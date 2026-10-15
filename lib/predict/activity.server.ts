/**
 * A wallet's Predict trades on the fork (server only), reconstructed from chain: no indexer, no
 * browser state. Every trade moves the wallet's CASH, so the signatures of its CASH account list
 * them; each transaction's token-balance deltas give the shares and CASH per outcome. Outcome
 * tokens that went into (or out of) the market's yield pool in the same transaction count as the
 * wallet's (a buy that auto-deposits is still a buy of N shares).
 *
 * Limit: when one transaction trades several outcomes, its CASH is split pro rata by shares. A buy
 * paid in USDC counts the USDC spent (swapped to CASH in the same transaction) as its cost.
 */
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getConnection } from "@/lib/solana/connection";
import { getToken } from "@/lib/solana/tokens";
import { CASH_DECIMALS, CASH_MINT, OUTCOME_DECIMALS } from "./constants";
import { getMarketInfo, marketIdForMint } from "./catalog.server";
import { eventIdForMarket } from "./events.server";
import { outcomeSubject } from "./grouping";
import { poolPda } from "./pool.server";
import type { TradeEvent } from "./types";

const USDC = getToken("USDC").mint.toBase58();
const g = globalThis as unknown as { __predictTx?: Map<string, ParsedTransactionWithMeta | null> };
/**
 * Confirmed transactions never change: cache parsed ones by signature. Bounded (least recently used
 * dropped first), since any wallet in the URL adds entries; a not-yet-visible transaction (null) is
 * not cached, so it is picked up on the next read.
 */
const txCache = (g.__predictTx ??= new Map());
const TX_CACHE_LIMIT = 5_000;

async function parsed(signature: string) {
  const hit = txCache.get(signature);
  if (hit) {
    txCache.delete(signature);
    txCache.set(signature, hit);
    return hit;
  }
  const tx = await getConnection().getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (tx) {
    txCache.set(signature, tx);
    if (txCache.size > TX_CACHE_LIMIT) txCache.delete(txCache.keys().next().value!);
  }
  return tx ?? null;
}

/** Reconstructs this wallet's trades (newest first) from its last `limit` CASH-account transactions. */

/** Epoch ms, or null when missing or implausible (before 2020). */
const plausibleMs = (ms: number) => (ms >= Date.UTC(2020, 0, 1) ? ms : null);
export async function getTradeHistory(owner: PublicKey, limit = 40): Promise<TradeEvent[]> {
  const conn = getConnection();
  const cashAccount = getAssociatedTokenAddressSync(new PublicKey(CASH_MINT), owner, false, TOKEN_2022_PROGRAM_ID);
  const sigs = await conn.getSignaturesForAddress(cashAccount, { limit }, "confirmed").catch(() => []);
  // Singular calls: Surfpool's RPC does not support JSON-RPC batch requests.
  const txs: (ParsedTransactionWithMeta | null)[] = [];
  for (let i = 0; i < sigs.length; i += 6) txs.push(...(await Promise.all(sigs.slice(i, i + 6).map((s) => (s.err ? null : parsed(s.signature))))));
  const me = owner.toBase58();
  const out: TradeEvent[] = [];

  for (const [i, tx] of txs.entries()) {
    if (!tx?.meta || tx.meta.err) continue;
    const delta = new Map<string, number>();
    const bump = (o: string | undefined, mint: string, amount: string, sign: 1 | -1) => {
      if (!o) return;
      delta.set(`${o}|${mint}`, (delta.get(`${o}|${mint}`) ?? 0) + sign * Number(amount));
    };
    for (const b of tx.meta.preTokenBalances ?? []) bump(b.owner, b.mint, b.uiTokenAmount.amount, -1);
    for (const b of tx.meta.postTokenBalances ?? []) bump(b.owner, b.mint, b.uiTokenAmount.amount, 1);
    // Paid in CASH, or in USDC swapped to CASH in the same transaction (both 6 decimals, ~1:1).
    const cash = (delta.get(`${me}|${CASH_MINT}`) ?? 0) + (delta.get(`${me}|${USDC}`) ?? 0);
    if (cash === 0) continue;

    const mints = new Set([...delta.keys()].map((k) => k.split("|")[1]).filter((m) => m !== CASH_MINT && m !== USDC));
    const legs: { marketId: string; mint: string; outcome: "yes" | "no"; shares: number; pooled: number }[] = [];
    for (const mint of mints) {
      const marketId = await marketIdForMint(mint);
      if (!marketId) continue;
      const info = await getMarketInfo(marketId);
      if (!info) continue;
      const own = delta.get(`${me}|${mint}`) ?? 0;
      const pooled = delta.get(`${poolPda(new PublicKey(marketId)).toBase58()}|${mint}`) ?? 0;
      const shares = own + pooled;
      if (shares === 0) continue;
      legs.push({ marketId, mint, outcome: mint === info.yesMint ? "yes" : "no", shares, pooled });
    }
    // A buy has CASH out and shares in; a sell the reverse. Anything else (e.g. a deposit) is not a trade.
    const trades = legs.filter((l) => (cash < 0 && l.shares > 0) || (cash > 0 && l.shares < 0));
    const totalShares = trades.reduce((t, l) => t + Math.abs(l.shares), 0);
    for (const l of trades) {
      const info = (await getMarketInfo(l.marketId))!;
      const shares = Math.abs(l.shares) / 10 ** OUTCOME_DECIMALS;
      const legCash = (Math.abs(cash) * (Math.abs(l.shares) / totalShares)) / 10 ** CASH_DECIMALS;
      out.push({
        signature: tx.transaction.signatures[0],
        // The hosted fork sometimes reports a slot-based blockTime (a 1970 date): treat anything
        // before 2020 as unknown rather than show a wrong date.
        time: plausibleMs((tx.blockTime ?? sigs[i].blockTime ?? 0) * 1000),
        marketId: l.marketId,
        eventId: await eventIdForMarket(l.marketId),
        question: info.question,
        outcome: l.outcome,
        outcomeLabel: info.startMs !== null ? (l.outcome === "yes" ? "Up" : "Down") : `${outcomeSubject(info.name) || info.question} · ${l.outcome === "yes" ? "Yes" : "No"}`,
        side: cash < 0 ? "buy" : "sell",
        shares,
        cash: legCash,
        price: shares ? legCash / shares : 0,
        pooled: l.pooled / 10 ** OUTCOME_DECIMALS,
      });
    }
  }
  return out.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
}
