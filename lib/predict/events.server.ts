/**
 * Predict events (server only): the World catalog grouped into events (grouping.ts), priced from
 * mainnet maker fills (prices.server.ts) and joined with the live yield-pool balances on the fork
 * (pool.server.ts). Output shapes are the UI model in types.ts.
 */
import { CASH_DECIMALS } from "./constants";
import { getMarketInfo, listMarketInfos, openInterestOf, refreshOpenInterest } from "./catalog.server";
import { groupMarkets, type EventSkeleton } from "./grouping";
import { countdown, fromRawUnits, poolBar, shortDate, timeAgo, toCents } from "./math";
import { readPoolStates, type PoolState } from "./pool.server";
import { featuredOnly, featuredRank } from "./featured";
import { getMarketPrices, getMarketVolume, scanMarketMints } from "./prices.server";
import type { MarketInfo, PoolDetail, PredictEvent, PredictOutcome } from "./types";

const EVENTS_TTL_MS = 15_000;
const g = globalThis as unknown as { __predictEvents?: { at: number; events: PredictEvent[]; byMarket: Map<string, string>; pending: Promise<void> | null } };
const state = (g.__predictEvents ??= { at: 0, events: [], byMarket: new Map(), pending: null });

const SOURCES: Record<number, string> = { 1: "Pyth price feed", 2: "World.xyz (sports data)", 3: "World.xyz (sports data)", 4: "World.xyz (F1 data)", 5: "World.xyz resolver" };

function poolDetail(p: PoolState | undefined): PoolDetail {
  if (!p) return { allowlisted: false, exists: false, yesDangling: 0, noDangling: 0, invested: 0, pendingMerge: 0 };
  const yes = fromRawUnits(p.yesDangling, CASH_DECIMALS);
  const no = fromRawUnits(p.noDangling, CASH_DECIMALS);
  return { allowlisted: p.allowlisted, exists: p.exists, yesDangling: yes, noDangling: no, invested: fromRawUnits(p.invested, CASH_DECIMALS), pendingMerge: Math.min(yes, no) };
}

function toEvent(sk: EventSkeleton, infos: Map<string, MarketInfo>, pools: Map<string, PoolState>, now: number): PredictEvent {
  const outs: PredictOutcome[] = sk.outcomes.map((o) => {
    const m = infos.get(o.marketId)!;
    const kind = m.startMs !== null && m.endMs !== null ? "updown" : "binary";
    const p = getMarketPrices(m.yesMint, m.noMint, kind, m.startMs);
    const detail = poolDetail(pools.get(m.id));
    const ended = m.endMs !== null && m.endMs <= now;
    return {
      ...o,
      y: toCents(p.yesAsk),
      n: toCents(p.noAsk),
      vol: getMarketVolume(m.yesMint, m.noMint),
      pool: poolBar(detail.yesDangling, detail.noDangling, detail.invested),
      uid: `${sk.id}/${o.marketId}`,
      k: o.marketId,
      marketId: m.id,
      yesMint: m.yesMint,
      noMint: m.noMint,
      symbol: m.symbol,
      image: m.image,
      yBid: toCents(p.yesBid),
      nBid: toCents(p.noBid),
      oi: openInterestOf(m.id),
      lastTradeAt: p.lastTradeAt,
      tradable: !ended && p.yesAsk !== null && p.noAsk !== null,
      poolDetail: detail,
    };
  });
  const members = sk.outcomes.map((o) => infos.get(o.marketId)!);
  const lastTradeAt = Math.max(0, ...outs.map((o) => o.lastTradeAt ?? 0)) || null;
  const v24 = outs.reduce((t, o) => t + o.vol, 0);
  const live = sk.type === "updown" && sk.startMs !== null && sk.endMs !== null && sk.startMs <= now && now < sk.endMs;
  return {
    id: sk.id,
    type: sk.type,
    cat: sk.cat,
    tag: sk.tag,
    title: sk.title,
    ic: sk.ic,
    ...(sk.type === "updown" ? { live, when: live ? `Closes in ${countdown(sk.endMs, now)}` : `Opens in ${countdown(sk.startMs, now)}`, countdown: countdown(sk.endMs, now) } : {}),
    last: timeAgo(lastTradeAt, now),
    ends: shortDate(sk.endMs),
    opened: shortDate(sk.startMs),
    vol: v24,
    v24,
    oi: outs.reduce((t, o) => t + o.oi, 0),
    source: SOURCES[members[0].resolutionKind] ?? "World.xyz",
    ...(sk.note ? { note: sk.note } : {}),
    rules: sk.rules,
    ...(sk.exh === false ? { exh: false } : {}),
    ...(sk.asset ? { asset: sk.asset } : {}),
    outs,
    image: sk.image,
    league: sk.league,
    groupedBy: sk.groupedBy,
    startMs: sk.startMs,
    endMs: sk.endMs,
  };
}

/** Sorts like World: live windows first, then by open interest. */
const rank = (e: PredictEvent) => (e.live ? 1e15 : 0) + e.oi;
/** Featured mode keeps World's Trending order (lib/predict/featured.ts); otherwise {@link rank}. */
const byPageOrder = (a: PredictEvent, b: PredictEvent) => {
  const fa = Math.min(...a.outs.map((o) => featuredRank(o.marketId)));
  const fb = Math.min(...b.outs.map((o) => featuredRank(o.marketId)));
  return fa !== fb ? fa - fb : rank(b) - rank(a);
};

async function rebuild(): Promise<void> {
  const { markets, groups } = await listMarketInfos();
  const skeletons = groupMarkets(markets, groups);
  const infos = new Map(markets.map((m) => [m.id, m]));
  const pools = await readPoolStates(markets.filter((m) => m.startMs === null).map((m) => m.id)).catch((error) => {
    console.warn("Predict pool states unavailable:", error instanceof Error ? error.message : error);
    return new Map<string, PoolState>();
  });
  const now = Date.now();
  const events = skeletons.map((sk) => toEvent(sk, infos, pools, now)).sort(featuredOnly() ? byPageOrder : (a, b) => rank(b) - rank(a));
  const byMarket = new Map<string, string>();
  for (const e of events) for (const o of e.outs) byMarket.set(o.marketId, e.id);
  state.events = events;
  state.byMarket = byMarket;
  state.at = Date.now();
}

/** Every listed event (cached ~15 s; the first call waits for the catalog scan). */
export async function listEvents(): Promise<PredictEvent[]> {
  if (Date.now() - state.at > EVENTS_TTL_MS) {
    if (!state.pending) state.pending = rebuild().finally(() => (state.pending = null));
    if (state.at === 0) await state.pending;
  }
  return state.events;
}

/**
 * One event by event id or by any of its market ids, freshly priced: its markets' own trade
 * history is scanned when the shared scan has no price, and open interest / pools are re-read.
 */
export async function getEvent(id: string, opts: { scanTimeoutMs?: number } = {}): Promise<PredictEvent | null> {
  await listEvents();
  const eventId = state.events.some((e) => e.id === id) ? id : state.byMarket.get(id);
  let event = eventId ? state.events.find((e) => e.id === eventId) ?? null : null;
  if (!event) {
    // Not listed (an ended window, or a market below the open-interest floor a user still holds).
    const info = await getMarketInfo(id);
    if (!info) return null;
    const [sk] = groupMarkets([{ ...info, groupId: null }], new Map());
    await refreshOpenInterest([info.id]);
    const pools = await readPoolStates([info.id]).catch(() => new Map<string, PoolState>());
    event = toEvent(sk, new Map([[info.id, info]]), pools, Date.now());
  }
  const unpriced = event.outs.filter((o) => o.y === null);
  if (unpriced.length) {
    await Promise.race([Promise.allSettled(unpriced.map((o) => scanMarketMints(o.yesMint, o.noMint))), new Promise((r) => setTimeout(r, opts.scanTimeoutMs ?? 8000))]);
  }
  const ids = event.outs.map((o) => o.marketId);
  const [infos, pools] = await Promise.all([
    Promise.all(ids.map((m) => getMarketInfo(m))),
    readPoolStates(event.type === "updown" ? [] : ids).catch(() => new Map<string, PoolState>()),
    refreshOpenInterest(ids),
  ]);
  const infoMap = new Map(infos.filter((x): x is MarketInfo => Boolean(x)).map((m) => [m.id, m]));
  const sk: EventSkeleton = {
    id: event.id,
    type: event.type,
    groupedBy: event.groupedBy,
    title: event.title,
    cat: event.cat,
    tag: event.tag,
    league: event.league,
    image: event.image,
    rules: event.rules,
    note: event.note,
    exh: event.exh,
    asset: event.asset,
    ic: event.ic,
    startMs: event.startMs,
    endMs: event.endMs,
    outcomes: event.outs.map(({ marketId, name, ab, yl, nl, lv, grp }) => ({ marketId, name, ab, yl, nl, lv, grp })),
  };
  return toEvent(sk, infoMap, pools, Date.now());
}

/** The event id a market belongs to (listed events only). */
export async function eventIdForMarket(marketId: string): Promise<string | null> {
  await listEvents();
  return state.byMarket.get(marketId) ?? null;
}
