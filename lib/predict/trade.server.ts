/**
 * Builds Predict trades for the fork (server only): one request → an ordered batch of v0
 * transactions the wallet signs with ONE `signAllTransactions` and the client sends in order.
 *
 * Buy N YES for C CASH at ask p (N = C / p), atomically in one instruction group (ported from
 * Backend-Solana-v2 `lib/world/trade.server.ts`):
 *   1. the maker sends the user N − C CASH (its side of the bet);
 *   2. the user calls World's `prediCt.split(N)`: N CASH → N YES + N NO;
 *   3. the user sends the N NO to the maker.
 * On an allowlisted market the same batch then deposits the N YES into outcome_yield_pool
 * (`create_pool` first when the market has no pool yet) and the client asks the keeper to merge
 * once it confirms. Sell N YES at bid b: when the wallet holds fewer than N the user's pool shares
 * are redeemed first (with the pool's USDC → CASH shortfall route), then the user sends N YES to
 * the maker and the maker pays N·b CASH (merging the YES with its NO inventory to stay flat).
 * Pay with USDC: a USDC → CASH Jupiter route (Manifest) runs first and the buys spend its minimum
 * output. Groups are packed into as few transactions as fit (pack.ts) with the shared lookup table.
 * The maker signs here; the transaction can only be submitted exactly as quoted.
 */
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SOLANA_RPC_URL } from "@/lib/solana/config";
import { getConnection } from "@/lib/solana/connection";
import { getToken } from "@/lib/solana/tokens";
import {
  CASH_DECIMALS,
  CASH_MINT,
  MARKET_ACCOUNT_SIZE,
  MARKET_OFFSETS,
  MAX_TRADE_CASH,
  MAX_TRADE_LEGS,
  MERGE_DISCRIMINATOR,
  MIN_TRADE_CASH,
  OUTCOME_DECIMALS,
  SPLIT_DISCRIMINATOR,
  WORLD_PROGRAM_ID,
} from "./constants";
import { tokenAmountOf } from "./decode";
import { getMarketInfo } from "./catalog.server";
import { healRouteAccounts, manifestQuote, swapInstructions } from "./jupiter.server";
import { getPredictLookupTable } from "./lut.server";
import { ensureMakerReady } from "./maker.server";
import { buyShares, fromRawUnits, sellCash, sharesForAssets, toRawUnits } from "./math";
import { packGroups, type IxGroup } from "./pack";
import { createPoolIx, depositIxs, readPoolStates, readShareBalances, redeemIxs, type PoolState } from "./pool.server";
import { getMarketPrices } from "./prices.server";
import type { MarketInfo, Side, TradeBuildResponse, TradeQuote, TradeRequest } from "./types";

const WORLD = new PublicKey(WORLD_PROGRAM_ID);
const CASH = new PublicKey(CASH_MINT);

export class TradeError extends Error {}

const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

/** prediCt `split` / `merge`: account order as World's own transactions use it. */
export function completeSetIx(kind: "split" | "merge", user: PublicKey, market: PublicKey, yes: PublicKey, no: PublicKey, vault: PublicKey, amount: bigint) {
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  return new TransactionInstruction({
    programId: WORLD,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      w(market),
      w(CASH),
      w(yes),
      w(no),
      w(ata(CASH, user)),
      w(vault),
      w(ata(yes, user)),
      w(ata(no, user)),
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from(kind === "split" ? SPLIT_DISCRIMINATOR : MERGE_DISCRIMINATOR), u64(amount)]),
  });
}

const transfer = (mint: PublicKey, from: PublicKey, to: PublicKey, owner: PublicKey, amount: bigint) =>
  createTransferCheckedInstruction(ata(mint, from), mint, ata(mint, to), owner, amount, OUTCOME_DECIMALS, [], TOKEN_2022_PROGRAM_ID);

interface LegMarket {
  info: MarketInfo;
  market: PublicKey;
  yes: PublicKey;
  no: PublicKey;
  vault: PublicKey;
}

/** Reads the market on the fork (cloning it from mainnet on first touch) and checks its layout. */
async function forkMarket(info: MarketInfo): Promise<LegMarket> {
  const acct = await getConnection().getAccountInfo(new PublicKey(info.id), "confirmed");
  if (!acct || acct.owner.toBase58() !== WORLD_PROGRAM_ID || acct.data.length !== MARKET_ACCOUNT_SIZE) {
    throw new TradeError("This market is not available on the fork (it may have closed on mainnet).");
  }
  const key = (o: number) => new PublicKey(acct.data.subarray(o, o + 32));
  const yes = key(MARKET_OFFSETS.yesMint);
  const no = key(MARKET_OFFSETS.noMint);
  if (yes.toBase58() !== info.yesMint || no.toBase58() !== info.noMint) throw new TradeError("Market accounts do not match.");
  return { info, market: new PublicKey(info.id), yes, no, vault: key(MARKET_OFFSETS.vault) };
}

const kindOf = (m: MarketInfo) => (m.startMs !== null && m.endMs !== null ? "updown" : "binary");

/** Validates the request shape; throws TradeError with a user-facing message. */
export function validateTradeRequest(body: unknown): TradeRequest {
  const b = body as Partial<TradeRequest> | null;
  if (!b || typeof b.owner !== "string") throw new TradeError("owner is required");
  try {
    new PublicKey(b.owner);
  } catch {
    throw new TradeError("Invalid wallet address");
  }
  if (!Array.isArray(b.legs) || b.legs.length === 0) throw new TradeError("legs must be a non-empty array");
  if (b.legs.length > MAX_TRADE_LEGS) throw new TradeError(`At most ${MAX_TRADE_LEGS} legs per trade`);
  for (const [i, l] of b.legs.entries()) {
    if (!l || typeof l.marketId !== "string" || (l.outcome !== "yes" && l.outcome !== "no") || !["buy", "sell", "deposit"].includes(l.side as string) || typeof l.amount !== "number" || !(l.amount > 0)) {
      throw new TradeError(`leg ${i}: marketId, outcome (yes|no), side (buy|sell|deposit) and a positive amount are required`);
    }
  }
  if (b.pay !== undefined && b.pay !== "CASH" && b.pay !== "USDC") throw new TradeError("pay must be CASH or USDC");
  return { owner: b.owner, legs: b.legs, pay: b.pay ?? "CASH", noPool: Boolean(b.noPool) };
}

export async function buildTrade(req: TradeRequest): Promise<TradeBuildResponse> {
  const owner = new PublicKey(req.owner);
  const conn = getConnection();
  const warnings: string[] = [];

  // Markets (mainnet catalog + fork accounts), prices, pool states, balances.
  const ids = [...new Set(req.legs.map((l) => l.marketId))];
  const infos = await Promise.all(ids.map((id) => getMarketInfo(id)));
  const missing = ids.filter((_, i) => !infos[i]);
  if (missing.length) throw new TradeError(`Market not found: ${missing.join(", ")}`);
  const markets = new Map((await Promise.all(infos.map((i) => forkMarket(i!)))).map((m) => [m.info.id, m]));
  for (const m of markets.values()) if (m.info.endMs !== null && m.info.endMs <= Date.now()) throw new TradeError(`${m.info.question} has closed for trading.`);
  const [maker, pools, shares, table] = await Promise.all([
    ensureMakerReady(),
    readPoolStates(ids),
    readShareBalances(owner, ids),
    getPredictLookupTable(),
  ]);
  const balanceKeys = [ata(CASH, owner), ...ids.flatMap((id) => [ata(markets.get(id)!.yes, owner), ata(markets.get(id)!.no, owner)])];
  const balanceInfos = await conn.getMultipleAccountsInfo(balanceKeys, "confirmed");
  let cash = tokenAmountOf(balanceInfos[0]?.data as Buffer);
  /** Wallet outcome balance per mint, updated as legs are planned. */
  const held = new Map<string, bigint>();
  ids.forEach((id, i) => {
    held.set(markets.get(id)!.yes.toBase58(), tokenAmountOf(balanceInfos[1 + 2 * i]?.data as Buffer));
    held.set(markets.get(id)!.no.toBase58(), tokenAmountOf(balanceInfos[2 + 2 * i]?.data as Buffer));
  });

  const groups: IxGroup[] = [];
  const quotes: TradeQuote[] = [];
  const makerGroups = new Set<number>();
  const createdPools = new Set<string>();
  const mergeMarkets = new Set<string>();
  const routeAccounts: PublicKey[] = [];

  // Pay with USDC: one swap up front, buys spend its minimum output pro rata.
  let swap: TradeBuildResponse["swap"] = null;
  const buyLegs = req.legs.map((l, i) => ({ l, i })).filter((x) => x.l.side === "buy");
  const legCash = new Map<number, bigint>();
  if (req.pay === "USDC" && buyLegs.length) {
    const usdc = getToken("USDC");
    const totalUsdc = buyLegs.reduce((t, x) => t + x.l.amount, 0);
    const usdcRaw = toRawUnits(totalUsdc, usdc.decimals);
    const usdcInfo = await conn.getAccountInfo(getAssociatedTokenAddressSync(usdc.mint, owner, false, TOKEN_PROGRAM_ID), "confirmed");
    if (tokenAmountOf(usdcInfo?.data as Buffer) < usdcRaw) throw new TradeError(`Not enough USDC: need ${totalUsdc}.`);
    const quote = await manifestQuote(usdc.mint.toBase58(), CASH_MINT, usdcRaw, 50);
    const route = await swapInstructions(conn, quote, owner, ata(CASH, owner));
    const minOut = BigInt(quote.otherAmountThreshold);
    routeAccounts.push(...route.swapAccounts.map((a) => a.pubkey));
    groups.push({
      label: `Swap ${totalUsdc} USDC → CASH`,
      legIndex: null,
      instructions: [createAssociatedTokenAccountIdempotentInstruction(owner, ata(CASH, owner), owner, CASH, TOKEN_2022_PROGRAM_ID), ...route.setup, route.swap, ...route.cleanup],
      computeUnits: 300_000,
      lookupTables: route.lookupTables,
    });
    let left = minOut;
    buyLegs.forEach((x, j) => {
      const share = j === buyLegs.length - 1 ? left : (minOut * toRawUnits(x.l.amount)) / toRawUnits(totalUsdc);
      legCash.set(x.i, share);
      left -= share;
    });
    cash += minOut;
    swap = { usdcIn: totalUsdc, cashOutMin: fromRawUnits(minOut, CASH_DECIMALS) };
  }

  const ensurePool = async (m: LegMarket, legIndex: number, pool: PoolState) => {
    if (pool.exists || createdPools.has(m.info.id)) return;
    createdPools.add(m.info.id);
    groups.push({ label: "Create yield pool", legIndex, instructions: [await createPoolIx(owner, { marketId: m.info.id, yesMint: m.info.yesMint, noMint: m.info.noMint })], computeUnits: 160_000 });
  };

  for (const [legIndex, leg] of req.legs.entries()) {
    const m = markets.get(leg.marketId)!;
    const side: Side = leg.outcome;
    const [want, other] = side === "yes" ? [m.yes, m.no] : [m.no, m.yes];
    const pool = pools.get(m.info.id)!;
    const prices = getMarketPrices(m.info.yesMint, m.info.noMint, kindOf(m.info), m.info.startMs);
    const mints = { marketId: m.info.id, yesMint: m.info.yesMint, noMint: m.info.noMint };
    const quote: TradeQuote = { legIndex, marketId: m.info.id, outcome: side, side: leg.side, amountIn: 0, amountOut: 0, price: 0, payoutIfWin: 0, pooled: 0, redeemedShares: 0 };

    if (leg.side === "buy") {
      const price = side === "yes" ? prices.yesAsk : prices.noAsk;
      if (price === null || !(price > 0 && price < 1)) throw new TradeError(`Price unavailable for "${m.info.question}": no recent mainnet trade.`);
      const spend = legCash.get(legIndex) ?? toRawUnits(leg.amount, CASH_DECIMALS);
      const spendUi = fromRawUnits(spend, CASH_DECIMALS);
      if (spendUi < MIN_TRADE_CASH || spendUi > MAX_TRADE_CASH) throw new TradeError(`Trade between ${MIN_TRADE_CASH} and ${MAX_TRADE_CASH} CASH per leg.`);
      if (cash < spend) throw new TradeError(`Not enough CASH: you have ${fromRawUnits(cash).toFixed(2)}, this batch needs more. Use the faucet or pay with USDC.`);
      const out = buyShares(spend, price);
      const makerSide = out - spend;
      if (makerSide <= 0n) throw new TradeError("Amount too small.");
      makerGroups.add(groups.length);
      groups.push({
        label: `Buy ${side.toUpperCase()}`,
        legIndex,
        instructions: [
          createAssociatedTokenAccountIdempotentInstruction(owner, ata(m.yes, owner), owner, m.yes, TOKEN_2022_PROGRAM_ID),
          createAssociatedTokenAccountIdempotentInstruction(owner, ata(m.no, owner), owner, m.no, TOKEN_2022_PROGRAM_ID),
          createAssociatedTokenAccountIdempotentInstruction(maker.publicKey, ata(other, maker.publicKey), maker.publicKey, other, TOKEN_2022_PROGRAM_ID),
          transfer(CASH, maker.publicKey, owner, maker.publicKey, makerSide),
          completeSetIx("split", owner, m.market, m.yes, m.no, m.vault, out),
          transfer(other, owner, maker.publicKey, owner, out),
        ],
        computeUnits: 120_000,
      });
      cash -= spend;
      held.set(want.toBase58(), (held.get(want.toBase58()) ?? 0n) + out);
      Object.assign(quote, { amountIn: spendUi, amountOut: fromRawUnits(out), price, payoutIfWin: fromRawUnits(out) });
      if (pool.allowlisted && !req.noPool) {
        await ensurePool(m, legIndex, pool);
        groups.push({ label: `Supply ${side.toUpperCase()} to the yield pool`, legIndex, instructions: await depositIxs(owner, mints, side, out), computeUnits: 200_000, heap: true });
        held.set(want.toBase58(), held.get(want.toBase58())! - out);
        quote.pooled = fromRawUnits(out);
        mergeMarkets.add(m.info.id);
      }
    } else if (leg.side === "sell") {
      const price = side === "yes" ? prices.yesBid : prices.noBid;
      if (price === null || !(price > 0 && price < 1)) throw new TradeError(`Price unavailable for "${m.info.question}": no recent mainnet trade.`);
      let amount = toRawUnits(leg.amount, OUTCOME_DECIMALS);
      let wallet = held.get(want.toBase58()) ?? 0n;
      const ownShares = shares.get(m.info.id)?.[side] ?? 0n;
      if (wallet < amount && ownShares > 0n && pool.exists) {
        const need = amount - wallet;
        const dangling = side === "yes" ? pool.yesDangling : pool.noDangling;
        const supply = side === "yes" ? pool.yesShareSupply : pool.noShareSupply;
        const redeemShares = sharesForAssets(need, ownShares, dangling, pool.invested, supply);
        // redeemIxs may burn fewer shares than asked (a side's last holders; see sizeRedeem): r.shares / r.value are what it does.
        const r = await redeemIxs(owner, mints, side, redeemShares, pool);
        routeAccounts.push(...r.routeAccounts);
        groups.push({ label: `Redeem pooled ${side.toUpperCase()}`, legIndex, instructions: r.instructions, computeUnits: 600_000, heap: true, lookupTables: r.lookupTables, alone: r.lookupTables.length > 0 });
        wallet += r.value;
        quote.redeemedShares = fromRawUnits(r.shares, 9);
        mergeMarkets.add(m.info.id);
      }
      if (wallet < amount) {
        if (wallet <= 0n) throw new TradeError(`You hold no ${side.toUpperCase()} of "${m.info.question}".`);
        warnings.push(`leg ${legIndex}: only ${fromRawUnits(wallet).toFixed(6)} available, selling that`);
        amount = wallet;
      }
      const proceeds = sellCash(amount, price);
      if (proceeds <= 0n) throw new TradeError("Amount too small.");
      const makerOther = tokenAmountOf((await conn.getAccountInfo(ata(other, maker.publicKey), "confirmed"))?.data as Buffer);
      makerGroups.add(groups.length);
      groups.push({
        label: `Sell ${side.toUpperCase()}`,
        legIndex,
        instructions: [
          createAssociatedTokenAccountIdempotentInstruction(owner, ata(CASH, owner), owner, CASH, TOKEN_2022_PROGRAM_ID),
          createAssociatedTokenAccountIdempotentInstruction(maker.publicKey, ata(m.yes, maker.publicKey), maker.publicKey, m.yes, TOKEN_2022_PROGRAM_ID),
          createAssociatedTokenAccountIdempotentInstruction(maker.publicKey, ata(m.no, maker.publicKey), maker.publicKey, m.no, TOKEN_2022_PROGRAM_ID),
          transfer(want, owner, maker.publicKey, owner, amount),
          ...(makerOther >= amount ? [completeSetIx("merge", maker.publicKey, m.market, m.yes, m.no, m.vault, amount)] : []),
          transfer(CASH, maker.publicKey, owner, maker.publicKey, proceeds),
        ],
        computeUnits: 140_000,
      });
      held.set(want.toBase58(), wallet - amount);
      cash += proceeds;
      Object.assign(quote, { amountIn: fromRawUnits(amount), amountOut: fromRawUnits(proceeds, CASH_DECIMALS), price });
    } else {
      if (!pool.allowlisted) throw new TradeError(`"${m.info.question}" is not allowlisted for the yield pool.`);
      const amount = toRawUnits(leg.amount, OUTCOME_DECIMALS);
      const wallet = held.get(want.toBase58()) ?? 0n;
      if (wallet < amount) throw new TradeError(`You hold ${fromRawUnits(wallet).toFixed(2)} ${side.toUpperCase()} of this market.`);
      await ensurePool(m, legIndex, pool);
      groups.push({ label: `Supply ${side.toUpperCase()} to the yield pool`, legIndex, instructions: await depositIxs(owner, mints, side, amount), computeUnits: 200_000, heap: true });
      held.set(want.toBase58(), wallet - amount);
      Object.assign(quote, { amountIn: fromRawUnits(amount), amountOut: fromRawUnits(amount), pooled: fromRawUnits(amount) });
      mergeMarkets.add(m.info.id);
    }
    quotes.push(quote);
  }

  const shared: AddressLookupTableAccount[] = table ? [table] : [];
  const assemble = async () => {
    const packed = packGroups(groups, owner, shared);
    const latest = await conn.getLatestBlockhash("confirmed");
    const txs = packed.map((p) => {
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: latest.blockhash, instructions: p.instructions }).compileToV0Message(p.lookupTables));
      const makerSigned = p.groups.some((i) => makerGroups.has(i));
      if (makerSigned) tx.sign([maker]);
      return { tx, makerSigned, groups: p.groups };
    });
    return { txs, latest };
  };
  let { txs, latest } = await assemble();

  // Simulate the first transaction (later ones depend on it landing): surfaces balance / fee
  // errors before the wallet prompt, and heals a stale Manifest route on the fork once.
  const simulateFirst = () => conn.simulateTransaction(txs[0].tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  let sim = await simulateFirst();
  if (sim.value.err && routeAccounts.length) {
    const protectOwners = new Set([owner.toBase58(), maker.publicKey.toBase58(), ...[...pools.values()].map((p) => p.pool.toBase58())]);
    const protect = new Set([CASH_MINT, getToken("USDC").mint.toBase58(), ...[...pools.values()].flatMap((p) => (p.account ? [p.account.poolCash, p.account.poolYes, p.account.poolNo, p.account.poolUsdc, p.account.poolVannaShares, p.account.yesShareMint, p.account.noShareMint].map((k) => k.toBase58()) : []))]);
    if ((await healRouteAccounts(conn, SOLANA_RPC_URL, routeAccounts, protect, protectOwners)) > 0) {
      ({ txs, latest } = await assemble());
      sim = await simulateFirst();
    }
  }
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).filter((l) => /error|failed|insufficient|Error/i.test(l)).slice(-6).join("\n");
    throw new TradeError(`${groups[txs[0].groups[0]].label} simulation failed: ${JSON.stringify(sim.value.err)}${logs ? `\n${logs}` : ""}`);
  }

  return {
    transactions: txs.map((t) => ({
      transaction: Buffer.from(t.tx.serialize()).toString("base64"),
      label: t.groups.map((i) => groups[i].label).join(" + "),
      legIndexes: [...new Set(t.groups.map((i) => groups[i].legIndex).filter((x): x is number => x !== null))],
      makerSigned: t.makerSigned,
    })),
    quotes,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    mergeMarkets: [...mergeMarkets],
    swap,
    warnings,
  };
}
