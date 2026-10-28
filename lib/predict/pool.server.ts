/**
 * outcome_yield_pool (server only): PDAs, batched pool state reads, instruction builders for
 * create_pool / deposit / redeem, and the keeper-signed merge_and_deposit. Ported from
 * Backend-Solana-v2 `lib/world/pool.ts` (client) and `lib/world/pool-keeper.server.ts`; here every
 * transaction is built on the server so the trade API can return one signAll batch.
 *
 * Deposited YES/NO tokens become pool shares (9 decimals). The keeper merges matched YES+NO into
 * CASH, swaps it to USDC (Jupiter, Manifest) and supplies it to Vanna's USDC reserve on the core
 * lending program (`lender_supply`, VANNA_PROGRAM_ID). Redeem pays from the pool's dangling tokens
 * first and covers a shortfall by a USDC → CASH route the pool signs by CPI.
 */
import { AnchorProvider, BN, BorshCoder, Program, type Idl } from "@coral-xyz/anchor";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";
import idlJson from "@/idl/outcome_yield_pool.json";
import { SOLANA_RPC_URL, VANNA_PROGRAM_ID } from "@/lib/solana/config";
import { getConnection, getMultipleAccountsChunked } from "@/lib/solana/connection";
import { confirmSignatureHttp } from "@/lib/solana/confirmation";
import { lenderTotalAssets, projectReserve, supplySharesToAssetsDown } from "@/lib/solana/math";
import { assetConfigPda, protocolConfigPda, reservePda, reserveVault, shareMintPda } from "@/lib/solana/pdas";
import { fetchPoolStates } from "@/lib/solana/protocol-state";
import { getToken } from "@/lib/solana/tokens";
import { ASSOCIATED_TOKEN_PROGRAM_ID, CASH_MINT, JUPITER_V6_PROGRAM_ID, OUTCOME_POOL_PROGRAM_ID, POOL_REDEEM_HORIZON_SECS, WORLD_PROGRAM_ID } from "./constants";
import { mintSupplyOf, tokenAmountOf } from "./decode";
import { healRouteAccounts, manifestQuote, swapInstructions } from "./jupiter.server";
import { getPoolKeeper } from "./keys.server";
import { previewRedeemValue, sizeRedeem } from "./math";
import type { Side } from "./types";

export const POOL_PROGRAM = new PublicKey(OUTCOME_POOL_PROGRAM_ID);
const PREDICT = new PublicKey(WORLD_PROGRAM_ID);
const JUPITER = new PublicKey(JUPITER_V6_PROGRAM_ID);
const CASH = new PublicKey(CASH_MINT);
const usdcMint = () => getToken("USDC").mint;
const seed = (v: string) => Buffer.from(v, "utf8");

const IDL = { ...(idlJson as Idl), address: OUTCOME_POOL_PROGRAM_ID } as Idl;
const coder = new BorshCoder(IDL);

const readonlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs,
};
let program: Program | null = null;
const poolProgram = () => (program ??= new Program(IDL, new AnchorProvider(getConnection(), readonlyWallet, { commitment: "confirmed" })));

// ---- PDAs -----------------------------------------------------------------------------------------

export const configPda = () => PublicKey.findProgramAddressSync([seed("config")], POOL_PROGRAM)[0];
export const allowedMarketPda = (market: PublicKey) => PublicKey.findProgramAddressSync([seed("allowed_market"), market.toBuffer()], POOL_PROGRAM)[0];
/** The pool's Vanna USDC reserve — the same for every pool. */
export const vannaReserve = () => reservePda(usdcMint());
export const poolPda = (market: PublicKey) => PublicKey.findProgramAddressSync([seed("pool"), market.toBuffer(), vannaReserve().toBuffer()], POOL_PROGRAM)[0];
export const shareMintPdaFor = (pool: PublicKey, side: Side) => PublicKey.findProgramAddressSync([seed(side === "yes" ? "yes_shares" : "no_shares"), pool.toBuffer()], POOL_PROGRAM)[0];
const ata2022 = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
const ataSpl = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);

/** The Vanna account group every pool instruction carries (lender_supply / lender_redeem). */
function vannaGroup(pool: PublicKey) {
  const usdc = usdcMint();
  return {
    vannaProgram: VANNA_PROGRAM_ID,
    vannaProtocolConfig: protocolConfigPda(),
    vannaAssetConfig: assetConfigPda(usdc),
    vannaReserve: reservePda(usdc),
    usdcMint: usdc,
    vannaLiquidityVault: reserveVault(usdc, TOKEN_PROGRAM_ID),
    vannaShareMint: shareMintPda(usdc),
    poolUsdc: ataSpl(usdc, pool),
    poolVannaShares: ataSpl(shareMintPda(usdc), pool),
    splTokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    systemProgram: SystemProgram.programId,
  };
}

/** Accounts every Predict transaction may touch that are the same for all markets (static LUT). */
export function staticPoolAccounts(): PublicKey[] {
  const usdc = usdcMint();
  return [
    POOL_PROGRAM,
    configPda(),
    VANNA_PROGRAM_ID,
    protocolConfigPda(),
    assetConfigPda(usdc),
    reservePda(usdc),
    usdc,
    reserveVault(usdc, TOKEN_PROGRAM_ID),
    shareMintPda(usdc),
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    SystemProgram.programId,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    JUPITER,
    PREDICT,
    CASH,
    ComputeBudgetProgram.programId,
  ];
}

// ---- State reads ----------------------------------------------------------------------------------

export interface PoolAccount {
  market: PublicKey;
  collateralMint: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  marketCashVault: PublicKey;
  yesShareMint: PublicKey;
  noShareMint: PublicKey;
  poolCash: PublicKey;
  poolYes: PublicKey;
  poolNo: PublicKey;
  poolUsdc: PublicKey;
  poolVannaShares: PublicKey;
}

/** BorshCoder returns the IDL's snake_case field names; the code uses camelCase. */
function camel<T>(raw: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v])) as T;
}

function decodePool(info: AccountInfo<Buffer> | null): PoolAccount | null {
  if (!info || !info.owner.equals(POOL_PROGRAM)) return null;
  try {
    return camel<PoolAccount>(coder.accounts.decode("Pool", info.data));
  } catch {
    return null;
  }
}

/** Raw (6-decimal / 9-decimal) live figures of one pool. */
export interface PoolState {
  marketId: string;
  allowlisted: boolean;
  exists: boolean;
  pool: PublicKey;
  account: PoolAccount | null;
  yesDangling: bigint;
  noDangling: bigint;
  /**
   * Pool's invested balance as the program's `VannaAccounts::invested` counts it: idle `pool_usdc`
   * plus its Vanna USDC position valued at the reserve's exchange rate projected to the fork's now
   * (6 decimals).
   */
  invested: bigint;
  /** `invested` with the reserve projected `POOL_REDEEM_HORIZON_SECS` further: sizes redeem routes (see `sizeRedeem`). */
  investedAhead: bigint;
  yesShareSupply: bigint;
  noShareSupply: bigint;
}

const g = globalThis as unknown as { __predictAllow?: { at: number; map: Map<string, boolean> } };
const ALLOW_TTL_MS = 60_000;

/** Which markets the program admin allowlisted (AllowedMarket PDA exists), cached for a minute. */
export async function readAllowlist(marketIds: string[]): Promise<Map<string, boolean>> {
  const cache = (g.__predictAllow ??= { at: 0, map: new Map() });
  if (Date.now() - cache.at > ALLOW_TTL_MS) cache.map = new Map();
  const missing = marketIds.filter((id) => !cache.map.has(id));
  if (missing.length) {
    const infos = await getMultipleAccountsChunked(getConnection(), missing.map((id) => allowedMarketPda(new PublicKey(id))));
    missing.forEach((id, i) => cache.map.set(id, Boolean(infos[i])));
    if (cache.at === 0 || Date.now() - cache.at > ALLOW_TTL_MS) cache.at = Date.now();
  }
  return new Map(marketIds.map((id) => [id, cache.map.get(id) ?? false]));
}

/**
 * The pool's USDC claim: Vanna lender shares × the reserve's exchange rate projected to the fork's
 * now, plus `aheadSecs` more seconds of accrual (the program refreshes the reserve before pricing a redeem).
 */
async function usdcValueOf() {
  const usdc = (await fetchPoolStates()).USDC;
  return (vannaShares: bigint, aheadSecs = 0n) => {
    if (!usdc?.reserve || !usdc.projected) return 0n;
    const reserve = aheadSecs > 0n ? projectReserve(usdc.reserve, usdc.now + aheadSecs) : usdc.projected;
    return supplySharesToAssetsDown(vannaShares, usdc.shareSupply, lenderTotalAssets(reserve));
  };
}

/**
 * Every market the outcome pool program has created a pool for (one getProgramAccounts over the
 * program's `Pool` accounts), whether or not it is listed on the Predict page today.
 */
export async function listPoolMarketIds(): Promise<string[]> {
  const filter = coder.accounts.memcmp("Pool");
  const accounts = await getConnection().getProgramAccounts(POOL_PROGRAM, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: filter.offset ?? 0, bytes: filter.bytes } }],
  });
  return [...new Set(accounts.map((a) => decodePool(a.account as AccountInfo<Buffer>)?.market.toBase58()).filter((m): m is string => Boolean(m)))];
}

/**
 * Live pool figures for many markets in a few batched reads: allowlist, Pool accounts, then their
 * YES / NO token accounts, Vanna share accounts, share-mint supplies and idle USDC accounts.
 */
export async function readPoolStates(marketIds: string[]): Promise<Map<string, PoolState>> {
  const out = new Map<string, PoolState>();
  if (!marketIds.length) return out;
  // The USDC share value is the slowest read and needs nothing below: start it first.
  const valueReady = usdcValueOf();
  valueReady.catch(() => undefined); // awaited (and rethrown) below
  const allow = await readAllowlist(marketIds);
  const conn = getConnection();
  const pools = marketIds.map((id) => poolPda(new PublicKey(id)));
  const poolInfos = await getMultipleAccountsChunked(conn, pools);
  const accounts = poolInfos.map((i) => decodePool(i as AccountInfo<Buffer> | null));
  const keys: PublicKey[] = [];
  accounts.forEach((a) => {
    if (a) keys.push(a.poolYes, a.poolNo, a.poolVannaShares, a.yesShareMint, a.noShareMint, a.poolUsdc);
  });
  const [infos, value] = await Promise.all([keys.length ? getMultipleAccountsChunked(conn, keys) : Promise.resolve([]), valueReady]);
  let k = 0;
  marketIds.forEach((id, i) => {
    const a = accounts[i];
    const base = { marketId: id, allowlisted: allow.get(id) ?? false, pool: pools[i], account: a };
    if (!a) {
      out.set(id, { ...base, exists: false, yesDangling: 0n, noDangling: 0n, invested: 0n, investedAhead: 0n, yesShareSupply: 0n, noShareSupply: 0n });
      return;
    }
    const d = (j: number) => (infos[k + j]?.data as Buffer | undefined) ?? null;
    // Idle USDC (e.g. the rounding dust a redeem's `lender_redeem` leaves) counts too, as on chain.
    const idle = tokenAmountOf(d(5));
    out.set(id, {
      ...base,
      exists: true,
      yesDangling: tokenAmountOf(d(0)),
      noDangling: tokenAmountOf(d(1)),
      invested: idle + value(tokenAmountOf(d(2))),
      investedAhead: idle + value(tokenAmountOf(d(2)), POOL_REDEEM_HORIZON_SECS),
      yesShareSupply: mintSupplyOf(d(3)),
      noShareSupply: mintSupplyOf(d(4)),
    });
    k += 6;
  });
  return out;
}

/** Owner's pool-share balances (raw, 9 decimals) for many markets, both sides. */
export async function readShareBalances(owner: PublicKey, marketIds: string[]): Promise<Map<string, { yes: bigint; no: bigint }>> {
  const keys = marketIds.flatMap((id) => {
    const pool = poolPda(new PublicKey(id));
    return [ata2022(shareMintPdaFor(pool, "yes"), owner), ata2022(shareMintPdaFor(pool, "no"), owner)];
  });
  const infos = keys.length ? await getMultipleAccountsChunked(getConnection(), keys) : [];
  return new Map(marketIds.map((id, i) => [id, { yes: tokenAmountOf(infos[2 * i]?.data as Buffer), no: tokenAmountOf(infos[2 * i + 1]?.data as Buffer) }]));
}

export const sideDangling = (s: PoolState, side: Side) => (side === "yes" ? s.yesDangling : s.noDangling);
export const sideSupply = (s: PoolState, side: Side) => (side === "yes" ? s.yesShareSupply : s.noShareSupply);
export const redeemValue = (s: PoolState, side: Side, sharesRaw: bigint) => previewRedeemValue(sharesRaw, sideDangling(s, side), s.invested, sideSupply(s, side));

/** Reads the program Config (admin / keeper) from the fork. */
export async function readPoolConfig(): Promise<{ admin: PublicKey; resolver: PublicKey; keeper: PublicKey; maxSwapLossBps: number } | null> {
  const info = await getConnection().getAccountInfo(configPda(), "confirmed");
  if (!info) return null;
  const c = camel<{ admin: PublicKey; resolver: PublicKey; keeper: PublicKey; maxSwapLossBps: number }>(coder.accounts.decode("Config", info.data));
  return { admin: c.admin, resolver: c.resolver, keeper: c.keeper, maxSwapLossBps: Number(c.maxSwapLossBps) };
}

/** Throws unless the configured keeper key is the program Config's keeper (a merge would fail). */
export async function assertKeeperMatchesConfig(): Promise<void> {
  const cfg = await readPoolConfig();
  if (!cfg) throw new Error("outcome_yield_pool config account not found on the fork");
  const keeper = getPoolKeeper().publicKey;
  if (!cfg.keeper.equals(keeper)) throw new Error(`Pool keeper key ${keeper.toBase58()} is not the config keeper ${cfg.keeper.toBase58()}`);
}

// ---- Instruction builders ------------------------------------------------------------------------

export interface MarketMints {
  marketId: string;
  yesMint: string;
  noMint: string;
}

/** `allow_market` (admin only): lets `create_pool` / deposits happen for `marketId`. */
export async function allowMarketIx(admin: PublicKey, marketId: string): Promise<TransactionInstruction> {
  const market = new PublicKey(marketId);
  return poolProgram()
    .methods.allowMarket()
    .accounts({ admin, config: configPda(), market, allowedMarket: allowedMarketPda(market), systemProgram: SystemProgram.programId } as never)
    .instruction();
}

/** `create_pool` (permissionless for an allowlisted market). */
export async function createPoolIx(payer: PublicKey, m: MarketMints): Promise<TransactionInstruction> {
  const usdc = usdcMint();
  return poolProgram()
    .methods.createPool()
    .accounts({
      payer,
      market: new PublicKey(m.marketId),
      vannaReserve: vannaReserve(),
      usdcMint: usdc,
      vannaShareMint: shareMintPda(usdc),
      collateralMint: CASH,
      yesMint: new PublicKey(m.yesMint),
      noMint: new PublicKey(m.noMint),
    } as never)
    .instruction();
}

/** Recipient share ATA (idempotent) + `deposit(is_yes, amount)` of `amountRaw` outcome tokens. */
export async function depositIxs(owner: PublicKey, m: MarketMints, side: Side, amountRaw: bigint): Promise<TransactionInstruction[]> {
  const market = new PublicKey(m.marketId);
  const pool = poolPda(market);
  const mint = new PublicKey(side === "yes" ? m.yesMint : m.noMint);
  const shareMint = shareMintPdaFor(pool, side);
  const recipientShares = getAssociatedTokenAddressSync(shareMint, owner, false, TOKEN_2022_PROGRAM_ID);
  const ix = await poolProgram()
    .methods.deposit(side === "yes", new BN(amountRaw.toString()))
    .accounts({
      depositor: owner,
      pool,
      market,
      outcomeMint: mint,
      depositorOutcome: getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID),
      poolOutcome: ata2022(mint, pool),
      shareMint,
      recipientShares,
      vanna: vannaGroup(pool),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    } as never)
    .instruction();
  return [createAssociatedTokenAccountIdempotentInstruction(owner, recipientShares, owner, shareMint, TOKEN_2022_PROGRAM_ID), ix];
}

/**
 * `redeem(is_yes, shares, swap_data)` of `sharesRaw` pool shares into outcome tokens. When the
 * pool's dangling tokens of that side do not cover the redeem value, a USDC → CASH route for the
 * shortfall (signed by the pool via CPI) is attached, sized by `sizeRedeem` for the shortfall the
 * program computes after its reserve refresh when the transaction lands (interest accrued since the
 * read raises it; an exact-at-read route fails `SwapAmountMismatch` on any large redeem). It must
 * clear par for any caller, so a route below par fails with the program's own `SwapBelowMinimum`
 * (a market condition). Returns the shares actually burnt (fewer than asked only for a side's last
 * holders, see `sizeRedeem`) and the outcome tokens the redeem pays at least.
 */
export async function redeemIxs(
  owner: PublicKey,
  m: MarketMints,
  side: Side,
  sharesRaw: bigint,
  state: PoolState,
): Promise<{ instructions: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[]; value: bigint; shares: bigint; routeAccounts: PublicKey[] }> {
  if (!state.account) throw new Error("Pool not initialised for this market yet");
  const market = new PublicKey(m.marketId);
  const pool = poolPda(market);
  const mint = new PublicKey(side === "yes" ? m.yesMint : m.noMint);
  const shareMint = shareMintPdaFor(pool, side);
  const recipientOutcome = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  const { shares, value, usdcIn } = sizeRedeem(sharesRaw, sideDangling(state, side), state.invested, state.investedAhead, sideSupply(state, side));

  let swapData: Buffer = Buffer.alloc(0);
  let remainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  let lookupTables: AddressLookupTableAccount[] = [];
  if (usdcIn > 0n) {
    const quote = await manifestQuote(usdcMint().toBase58(), CASH_MINT, usdcIn);
    const route = await swapInstructions(getConnection(), quote, pool, ata2022(CASH, pool));
    swapData = route.swapData;
    remainingAccounts = route.swapAccounts;
    lookupTables = route.lookupTables;
  }
  const ix = await poolProgram()
    .methods.redeem(side === "yes", new BN(shares.toString()), swapData)
    .accounts({
      authority: owner,
      pool,
      shareMint,
      ownerShares: getAssociatedTokenAddressSync(shareMint, owner, false, TOKEN_2022_PROGRAM_ID),
      recipientOutcome,
      predict: {
        market,
        collateralMint: CASH,
        yesMint: new PublicKey(m.yesMint),
        noMint: new PublicKey(m.noMint),
        marketCashVault: state.account.marketCashVault,
        poolCash: state.account.poolCash,
        poolYes: state.account.poolYes,
        poolNo: state.account.poolNo,
        predictProgram: PREDICT,
      },
      vanna: vannaGroup(pool),
      jupiterProgram: JUPITER,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    } as never)
    .remainingAccounts(remainingAccounts)
    .instruction();
  return {
    instructions: [createAssociatedTokenAccountIdempotentInstruction(owner, recipientOutcome, owner, mint, TOKEN_2022_PROGRAM_ID), ix],
    lookupTables,
    value,
    shares,
    routeAccounts: remainingAccounts.map((a) => a.pubkey),
  };
}

/** Every address a pool legitimately owns: none exist on mainnet, so none may ever be reset. */
export function poolProtectedAddresses(pool: PublicKey, a: PoolAccount): Set<string> {
  return new Set([pool, a.yesShareMint, a.noShareMint, a.poolCash, a.poolYes, a.poolNo, a.poolUsdc, a.poolVannaShares, CASH, usdcMint()].map((k) => k.toBase58()));
}

// ---- Keeper merge --------------------------------------------------------------------------------

/**
 * One merge attempt: fresh Jupiter quote (CASH → USDC for the matched sets, quoted for the pool
 * PDA), simulate, heal the route's fork accounts once on failure, send signed by the keeper. Only
 * the config's keeper may land a swap slightly below par (`max_swap_loss_bps`), which every real
 * AMM swap does, so this is never signed by a user wallet.
 */
async function attemptMerge(marketId: string): Promise<{ signature: string; merged: bigint } | { skipped: string }> {
  const keeper = getPoolKeeper();
  const conn = getConnection();
  const market = new PublicKey(marketId);
  const pool = poolPda(market);
  const account = decodePool((await conn.getAccountInfo(pool, "confirmed")) as AccountInfo<Buffer> | null);
  if (!account) return { skipped: "pool not initialised" };
  const [yesInfo, noInfo] = await conn.getMultipleAccountsInfo([account.poolYes, account.poolNo], "confirmed");
  const yes = tokenAmountOf(yesInfo?.data as Buffer);
  const no = tokenAmountOf(noInfo?.data as Buffer);
  const completeSets = yes < no ? yes : no;
  if (completeSets <= 0n) return { skipped: "no matched YES+NO set in the pool" };

  // Who owns the market's CASH vault (token account owner, bytes 32..64): the market itself, or the World Group it
  // belongs to. Every outcome market of a Group shares one Group-owned vault, and prediCt's market-level merge can't
  // release CASH from it ("owner does not match"), so those pools merge through `merge_and_deposit_in_group`.
  const vaultInfo = await conn.getAccountInfo(account.marketCashVault, "confirmed");
  const vaultOwner = vaultInfo && vaultInfo.data.length >= 64 ? new PublicKey(vaultInfo.data.subarray(32, 64)) : null;
  if (!vaultOwner) throw new Error(`Market CASH vault ${account.marketCashVault.toBase58()} not found`);
  const group = vaultOwner.equals(market) ? null : vaultOwner;

  const quote = await manifestQuote(account.collateralMint.toBase58(), usdcMint().toBase58(), completeSets);
  const route = await swapInstructions(conn, quote, pool, ataSpl(usdcMint(), pool));
  const base = {
    caller: keeper.publicKey,
    config: configPda(),
    pool,
    predict: {
      market,
      collateralMint: account.collateralMint,
      yesMint: account.yesMint,
      noMint: account.noMint,
      marketCashVault: account.marketCashVault,
      poolCash: account.poolCash,
      poolYes: account.poolYes,
      poolNo: account.poolNo,
      predictProgram: PREDICT,
    },
    vanna: vannaGroup(pool),
    jupiterProgram: JUPITER,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  };
  const ix = await (group
    ? poolProgram().methods.mergeAndDepositInGroup(route.swapData).accounts({ base, group } as never)
    : poolProgram().methods.mergeAndDeposit(route.swapData).accounts(base as never))
    .remainingAccounts(route.swapAccounts)
    .instruction();

  // Jupiter's OWN lookup tables only: a self-built table holding the pool PDA would load it via the
  // table while it must also be a writable, seed-signed account, which the runtime rejects.
  const build = async () => {
    const latest = await conn.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: keeper.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }), ix],
    }).compileToV0Message(route.lookupTables);
    const tx = new VersionedTransaction(message);
    tx.sign([keeper]);
    const simulation = await conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    return { tx, latest, simulation };
  };
  let { tx, latest, simulation } = await build();
  if (simulation.value.err) {
    await healRouteAccounts(conn, SOLANA_RPC_URL, route.swapAccounts.map((a) => a.pubkey), poolProtectedAddresses(pool, account), new Set([pool.toBase58(), keeper.publicKey.toBase58()]));
    ({ tx, latest, simulation } = await build());
  }
  if (simulation.value.err) {
    const logs = (simulation.value.logs ?? []).slice(-12).join("\n");
    throw new Error(`Merge simulation failed: ${JSON.stringify(simulation.value.err)}\n${logs || "No program logs returned"}`);
  }
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  await confirmSignatureHttp(conn, signature, latest.lastValidBlockHeight);
  return { signature, merged: completeSets };
}

/** Merges a pool's matched YES+NO into Vanna USDC; retries once with a fresh quote. */
export async function mergeMarketAsKeeper(marketId: string): Promise<{ signature: string; merged: bigint } | { skipped: string }> {
  try {
    return await attemptMerge(marketId);
  } catch (error) {
    console.warn(`Predict merge attempt 1 failed for ${marketId}, retrying with a fresh quote:`, error instanceof Error ? error.message : error);
    return attemptMerge(marketId);
  }
}
