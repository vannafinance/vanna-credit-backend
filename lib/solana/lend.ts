/* eslint-disable @typescript-eslint/no-explicit-any */
import { BN } from "@coral-xyz/anchor";
import type { ReadScope } from "../async";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { getProgram } from "./program";
import { assetConfigPda, lenderShareAccount, protocolConfigPda, reservePda, reserveVault, shareMintPda, walletAta } from "./pdas";
import { fetchPoolStates, type PoolState } from "./protocol-state";
import { fetchWalletBalances, spendableLamports } from "./balances";
import { getToken, TOKENS, type TokenInfo } from "./tokens";
import {
  assetsToSupplySharesDown,
  assetsToSupplySharesUp,
  fromRaw,
  lenderTotalAssets,
  MIN_INITIAL_SHARES,
  rawToNumber,
  supplySharesToAssetsDown,
  toRaw,
} from "./math";
import { sendInstructions } from "./tx";
import { getActiveSigner, type TxSigner } from "./wallet-bridge";
import { temporaryWsolReceiver, wrapSolInstructions } from "./wsol";

/** Slippage bound on share/asset conversions between quote and execution (interest accrues). */
const LEND_SLIPPAGE_BPS = 50n;

export interface TxResult {
  signature: string;
}

export interface ServiceOptions {
  /** Defaults to the connected browser wallet. */
  signer?: TxSigner;
  onStatus?: (status: string) => void;
}

function lenderAccounts(owner: PublicKey, token: TokenInfo, lenderTokenAccount: PublicKey) {
  return {
    lender: owner,
    protocolConfig: protocolConfigPda(),
    assetConfig: assetConfigPda(token.mint),
    reserve: reservePda(token.mint),
    underlyingMint: token.mint,
    lenderTokenAccount,
    liquidityVault: reserveVault(token.mint, token.tokenProgram),
    shareMint: shareMintPda(token.mint),
    lenderShareAccount: lenderShareAccount(owner, token.mint),
    tokenProgram: token.tokenProgram,
    shareTokenProgram: TOKEN_PROGRAM_ID,
  };
}

function requirePool(pool: PoolState | undefined, symbol: string): asserts pool is PoolState & { projected: NonNullable<PoolState["projected"]> } {
  if (!pool?.projected) throw new Error(`${symbol} lending pool is not initialised on this fork`);
}

/** Expected shares for `assets` against the pool's projected state (what the program will compute). */
export function previewSupplyShares(pool: PoolState, assetsRaw: bigint): bigint {
  if (!pool.projected) return 0n;
  return assetsToSupplySharesDown(assetsRaw, pool.shareSupply, lenderTotalAssets(pool.projected));
}

/**
 * Supply `amountUi` of `symbol` to its lending pool (`lender_supply`). SOL is wrapped into the
 * wallet's wSOL ATA first (a freshly created ATA is closed again afterwards).
 */
export async function supply(symbol: string, amountUi: string | number, opts: ServiceOptions = {}): Promise<TxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const owner = signer.publicKey;
  const token = getToken(symbol);
  // Redeeming stays open for every token (so an existing position can always exit); new supply
  // only goes to the Earn pools the app offers.
  if (!token.lendable) throw new Error(`${token.symbol} has no Earn pool`);
  const assets = toRaw(amountUi, token.decimals);
  if (assets <= 0n) throw new Error("Enter an amount greater than zero");

  const [pools, balances] = await Promise.all([fetchPoolStates(), fetchWalletBalances(owner)]);
  const pool = pools[token.symbol];
  requirePool(pool, token.symbol);

  const available = token.isNative ? spendableLamports(balances.raw.SOL) : balances.raw[token.symbol];
  if (assets > available) {
    throw new Error(`Insufficient ${token.symbol}: wallet has ${fromRaw(available, token.decimals)} available${token.isNative ? " after the SOL fee reserve" : ""}`);
  }
  const expectedShares = previewSupplyShares(pool, assets);
  if (pool.shareSupply === 0n && expectedShares < MIN_INITIAL_SHARES) {
    throw new Error(`The first supply to the ${token.symbol} pool must mint at least ${MIN_INITIAL_SHARES} base units (${fromRaw(MIN_INITIAL_SHARES, token.decimals)} ${token.symbol}).`);
  }
  const minShares = (expectedShares * (10_000n - LEND_SLIPPAGE_BPS)) / 10_000n;

  const prefix: TransactionInstruction[] = [];
  const suffix: TransactionInstruction[] = [];
  let source = walletAta(owner, token.mint, token.tokenProgram);
  if (token.isNative) {
    const wrap = await wrapSolInstructions(owner, assets);
    prefix.push(...wrap.instructions);
    source = wrap.ata;
    if (!wrap.existed) suffix.push(createCloseAccountInstruction(wrap.ata, owner, owner));
  }

  const ix = await getProgram()
    .methods.lenderSupply(new BN(assets.toString()), new BN((minShares > 0n ? minShares : 1n).toString()))
    .accountsStrict({
      ...lenderAccounts(owner, token, source),
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();

  const signature = await sendInstructions([...prefix, ix, ...suffix], {
    signer,
    label: `Supply ${token.symbol}`,
    onStatus: opts.onStatus,
  });
  return { signature };
}

export interface RedeemRequest {
  /** Redeem an exact share count (raw). */
  sharesRaw?: bigint;
  /** Or redeem the shares worth this many underlying tokens (UI units, rounded up). */
  assetsUi?: string | number;
  /** Or redeem everything. */
  all?: boolean;
}

/**
 * Redeem lender shares (`lender_redeem`). SOL is redeemed into an isolated temporary wSOL
 * account that is closed in the same tx, so the user receives native SOL.
 */
export async function redeem(symbol: string, request: RedeemRequest, opts: ServiceOptions = {}): Promise<TxResult & { sharesRaw: bigint }> {
  const signer = opts.signer ?? getActiveSigner();
  const owner = signer.publicKey;
  const token = getToken(symbol);
  const [pools, balances] = await Promise.all([fetchPoolStates(), fetchWalletBalances(owner)]);
  const pool = pools[token.symbol];
  requirePool(pool, token.symbol);
  const held = balances.sharesRaw[token.symbol] ?? 0n;
  const lenderTotal = lenderTotalAssets(pool.projected);

  let shares: bigint;
  if (request.all) shares = held;
  else if (request.sharesRaw !== undefined) shares = request.sharesRaw;
  else if (request.assetsUi !== undefined) {
    shares = assetsToSupplySharesUp(toRaw(request.assetsUi, token.decimals), pool.shareSupply, lenderTotal);
    // Rounding up may exceed the balance by a unit when withdrawing "everything".
    if (shares > held) shares = held;
  } else throw new Error("redeem: specify sharesRaw, assetsUi or all");
  if (shares <= 0n) throw new Error(`No ${token.symbol} supply position to withdraw`);
  if (shares > held) throw new Error(`You only hold ${fromRaw(held, token.decimals)} v${token.symbol} shares`);

  const expectedAssets = supplySharesToAssetsDown(shares, pool.shareSupply, lenderTotal);
  if (expectedAssets > pool.projected.accountedLiquidityAssets - pool.projected.accruedProtocolFees) {
    throw new Error(`The ${token.symbol} pool only has ${pool.availableLiquidity} ${token.symbol} available to withdraw right now`);
  }
  const minAssets = (expectedAssets * (10_000n - LEND_SLIPPAGE_BPS)) / 10_000n;

  const prefix: TransactionInstruction[] = [];
  const suffix: TransactionInstruction[] = [];
  let destination = walletAta(owner, token.mint, token.tokenProgram);
  if (token.isNative) {
    const temp = await temporaryWsolReceiver(owner);
    prefix.push(...temp.setup);
    suffix.push(...temp.cleanup);
    destination = temp.account;
  } else {
    prefix.push(createAssociatedTokenAccountIdempotentInstruction(owner, destination, owner, token.mint, token.tokenProgram));
  }

  const ix = await getProgram()
    .methods.lenderRedeem(new BN(shares.toString()), new BN(minAssets.toString()))
    .accountsStrict(lenderAccounts(owner, token, destination) as any)
    .instruction();

  const signature = await sendInstructions([...prefix, ix, ...suffix], {
    signer,
    label: `Withdraw ${token.symbol}`,
    onStatus: opts.onStatus,
  });
  return { signature, sharesRaw: shares };
}

/** One lender position, valued at the pool's projected exchange rate. */
export interface LenderPosition {
  symbol: string;
  sharesRaw: bigint;
  shares: number;
  /** Underlying value of the shares right now (UI units). */
  assets: number;
  assetsRaw: bigint;
}

/** Every registry token's lender position for `owner` (zero rows included). */
export async function fetchLenderPositions(owner: PublicKey, scope?: ReadScope): Promise<Record<string, LenderPosition>> {
  const [pools, balances] = await Promise.all([fetchPoolStates(undefined, scope), fetchWalletBalances(owner, undefined, scope)]);
  const out: Record<string, LenderPosition> = {};
  for (const t of TOKENS) {
    const pool = pools[t.symbol];
    const sharesRaw = balances.sharesRaw[t.symbol] ?? 0n;
    const assetsRaw = pool?.projected ? supplySharesToAssetsDown(sharesRaw, pool.shareSupply, lenderTotalAssets(pool.projected)) : 0n;
    out[t.symbol] = {
      symbol: t.symbol,
      sharesRaw,
      shares: rawToNumber(sharesRaw, t.decimals),
      assetsRaw,
      assets: rawToNumber(assetsRaw, t.decimals),
    };
  }
  return out;
}
