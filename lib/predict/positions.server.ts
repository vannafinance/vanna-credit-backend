/**
 * A wallet's Predict positions on the fork (server only): outcome tokens in the wallet plus pool
 * shares in outcome_yield_pool (valued at what `redeem` pays right now), cost basis from the
 * wallet's reconstructed trades, and the summary / vault figures in the UI model's shapes.
 */
import { PublicKey } from "@solana/web3.js";
import type { ReadScope } from "@/lib/async";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getConnection } from "@/lib/solana/connection";
import { fetchPoolStates } from "@/lib/solana/protocol-state";
import { getToken } from "@/lib/solana/tokens";
import { CASH_MINT, OUTCOME_DECIMALS, POOL_SHARE_DECIMALS } from "./constants";
import { getTradeHistory } from "./activity.server";
import { getMarketInfo, marketIdForMint } from "./catalog.server";
import { listEvents } from "./events.server";
import { outcomeSubject } from "./grouping";
import { fromRawUnits, shortDate } from "./math";
import { poolPda, readPoolStates, redeemValue, shareMintPdaFor, type PoolState } from "./pool.server";
import { getMarketPrices } from "./prices.server";
import type { MarketInfo, PositionsResponse, PredictEvent, PredictImportable, PredictPosition, PredictSummary, PredictVault, Side } from "./types";

interface Holding {
  marketId: string;
  side: Side;
  wallet: bigint;
  shares: bigint;
}

/** Most the positions can pay together: in a match / multi event only one outcome wins (sample `maxPayout`). */
export function maxPayout(positions: PredictPosition[], events: Map<string, PredictEvent>): number {
  let total = 0;
  const byEvent = new Map<string, PredictPosition[]>();
  for (const p of positions) byEvent.set(p.eventId, [...(byEvent.get(p.eventId) ?? []), p]);
  for (const [eventId, ps] of byEvent) {
    const e = events.get(eventId);
    if (!e || (e.type !== "match" && e.type !== "multi") || e.exh === false) {
      total += ps.reduce((t, p) => t + p.pays, 0);
      continue;
    }
    const lines = new Set(e.outs.filter((o) => o.grp).map((o) => o.k));
    total += ps.filter((p) => lines.has(p.marketId)).reduce((t, p) => t + p.pays, 0);
    const main = ps.filter((p) => !lines.has(p.marketId));
    const winners = e.outs.filter((o) => !o.grp && !o.res).map((o) => o.k);
    total += Math.max(0, ...winners.map((w) => main.reduce((t, p) => t + ((p.side === "yes") === (p.marketId === w) ? p.pays : 0), 0)));
  }
  return total;
}

export async function getPositions(owner: PublicKey, scope?: ReadScope): Promise<PositionsResponse> {
  const conn = getConnection();
  const usdc = getToken("USDC");
  const [tokens, lamports, usdcBal, events, trades, pools] = await Promise.all([
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed"),
    conn.getBalance(owner, "confirmed"),
    conn.getTokenAccountBalance(getAssociatedTokenAddressSync(usdc.mint, owner, false, TOKEN_PROGRAM_ID), "confirmed").then((b) => Number(b.value.uiAmount ?? 0)).catch(() => 0),
    listEvents().catch(() => [] as PredictEvent[]),
    getTradeHistory(owner).catch(() => []),
    fetchPoolStates(undefined, scope).catch(() => null),
  ]);
  const supplyApyPct = (pools?.USDC?.supplyApr ?? 0) * 100;
  const eventById = new Map(events.map((e) => [e.id, e]));
  const eventByMarket = new Map<string, PredictEvent>();
  for (const e of events) for (const o of e.outs) eventByMarket.set(o.marketId, e);

  // Candidate pools: every allowlisted listed market, plus anything the wallet traded or holds.
  const balances = new Map<string, bigint>();
  let cash = 0;
  for (const { account } of tokens.value) {
    const info = account.data.parsed?.info;
    const raw = BigInt(info?.tokenAmount?.amount ?? "0");
    if (!info?.mint || raw === 0n) continue;
    if (info.mint === CASH_MINT) cash += fromRawUnits(raw);
    else balances.set(info.mint, (balances.get(info.mint) ?? 0n) + raw);
  }
  const holdings = new Map<string, Holding>();
  const hold = (marketId: string, side: Side) => {
    const key = `${marketId}|${side}`;
    let h = holdings.get(key);
    if (!h) holdings.set(key, (h = { marketId, side, wallet: 0n, shares: 0n }));
    return h;
  };
  const candidates = new Set<string>([...events.flatMap((e) => e.outs.filter((o) => o.poolDetail.allowlisted).map((o) => o.marketId)), ...trades.map((t) => t.marketId)]);
  const infos = new Map<string, MarketInfo>();
  for (const [mint, raw] of balances) {
    const marketId = await marketIdForMint(mint).catch(() => null);
    if (!marketId) continue;
    const info = infos.get(marketId) ?? (await getMarketInfo(marketId).catch(() => null));
    if (!info) continue;
    infos.set(marketId, info);
    hold(marketId, mint === info.yesMint ? "yes" : "no").wallet += raw;
    candidates.add(marketId);
  }
  // Pool share mints are PDAs of the pool: invert them for the candidate markets.
  const shareMints = new Map<string, { marketId: string; side: Side }>();
  for (const id of candidates) {
    const pool = poolPda(new PublicKey(id));
    shareMints.set(shareMintPdaFor(pool, "yes").toBase58(), { marketId: id, side: "yes" });
    shareMints.set(shareMintPdaFor(pool, "no").toBase58(), { marketId: id, side: "no" });
  }
  for (const [mint, raw] of balances) {
    const s = shareMints.get(mint);
    if (s) hold(s.marketId, s.side).shares += raw;
  }

  const held = [...holdings.values()].filter((h) => h.wallet > 0n || h.shares > 0n);
  const poolStates = await readPoolStates([...new Set(held.map((h) => h.marketId))]).catch(() => new Map<string, PoolState>());
  const positions: PredictPosition[] = [];
  const importable: PredictImportable[] = [];
  for (const h of held) {
    const info = infos.get(h.marketId) ?? (await getMarketInfo(h.marketId).catch(() => null));
    if (!info) continue;
    const kind = info.startMs !== null && info.endMs !== null ? "updown" : "binary";
    const prices = getMarketPrices(info.yesMint, info.noMint, kind, info.startMs);
    const mark = (h.side === "yes" ? prices.yesBid : prices.noBid) ?? 0;
    const pool = poolStates.get(h.marketId);
    const walletShares = fromRawUnits(h.wallet, OUTCOME_DECIMALS);
    const poolShares = fromRawUnits(h.shares, POOL_SHARE_DECIMALS);
    const poolValueRaw = pool && h.shares > 0n ? redeemValue(pool, h.side, h.shares) : 0n;
    const poolValueShares = fromRawUnits(poolValueRaw, OUTCOME_DECIMALS);
    const supply = pool ? (h.side === "yes" ? pool.yesShareSupply : pool.noShareSupply) : 0n;
    const investedPart = pool && supply > 0n ? fromRawUnits((h.shares * pool.invested) / supply, OUTCOME_DECIMALS) : 0;
    const total = walletShares + poolValueShares;
    const buys = trades.filter((t) => t.marketId === h.marketId && t.outcome === h.side && t.side === "buy");
    const bought = buys.reduce((t, b) => t + b.shares, 0);
    const avg = bought ? buys.reduce((t, b) => t + b.cash, 0) / bought : mark;
    const principal = walletShares + poolShares;
    const yieldShares = poolValueShares - poolShares;
    const matched = total > 0 ? (investedPart / total) * 100 : 0;
    const event = eventByMarket.get(h.marketId);
    const outcome = event?.outs.find((o) => o.marketId === h.marketId);
    const outcomeName = outcome?.name ?? (outcomeSubject(info.name) || info.question);
    const label = h.side === "yes" ? outcome?.yl ?? "Yes" : outcome?.nl ?? "No";
    const times = buys.map((b) => b.time).filter((t): t is number => t !== null);
    const since = times.length ? shortDate(Math.min(...times)) : "";
    const pendingMerge = pool ? Math.min(fromRawUnits(pool.yesDangling), fromRawUnits(pool.noDangling)) : 0;
    const value = total * mark;
    const cost = principal * avg;
    positions.push({
      id: `${h.marketId}-${h.side}`,
      eventId: event?.id ?? h.marketId,
      marketId: h.marketId,
      event: event?.title ?? info.question,
      market: event && event.outs.length > 1 ? outcomeName : (event?.title ?? info.question),
      outcome: outcomeName,
      side: h.side,
      label,
      shares: total,
      yieldShares,
      avg,
      mark,
      value,
      cost,
      pnl: value - cost,
      inVault: investedPart * mark,
      matched,
      earned: Math.max(0, yieldShares) * mark,
      apy: (supplyApyPct * matched) / 100,
      pays: total,
      since,
      queued: 0,
      merging: poolShares > 0 && pendingMerge > 0,
      src: poolShares > 0 ? "vanna" : "wallet",
      walletShares,
      poolShares,
      poolValueShares,
    });
    if (walletShares > 0 && pool?.allowlisted) {
      importable.push({
        id: `w-${h.marketId}-${h.side}`,
        source: "wallet",
        event: event?.title ?? info.question,
        market: outcomeName,
        side: h.side,
        label,
        shares: walletShares,
        value: walletShares * mark,
        apy: supplyApyPct,
        listed: true,
        eventId: event?.id ?? null,
        marketId: h.marketId,
      });
    }
  }
  positions.sort((a, b) => b.value - a.value);

  const sum = (f: (p: PredictPosition) => number) => positions.reduce((t, p) => t + f(p), 0);
  const value = sum((p) => p.value);
  const cost = sum((p) => p.cost);
  const summary: PredictSummary = {
    value,
    cost,
    pnl: value - cost,
    inVault: sum((p) => p.inVault),
    earned: sum((p) => p.earned),
    apy: value ? sum((p) => p.value * p.apy) / value : 0,
    payout: maxPayout(positions, eventById),
    count: positions.length,
    perMonth: sum((p) => (p.value * p.apy) / 100 / 12),
  };

  const invested = events.flatMap((e) => e.outs.map((o) => o.poolDetail.invested));
  const deposited = invested.reduce((t, x) => t + x, 0);
  const supplied = pools?.USDC?.totalSupplied ?? 0;
  const vault: PredictVault = {
    deposited,
    earned: 0,
    apy: supplyApyPct,
    pairs: deposited,
    share: supplied ? (deposited / supplied) * 100 : 0,
    events: events.filter((e) => e.outs.some((o) => o.poolDetail.invested > 0)).length,
  };

  return { owner: owner.toBase58(), wallet: { cash, usdc: usdcBal, sol: lamports / 1e9 }, positions, summary, vault, importable };
}
