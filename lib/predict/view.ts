/**
 * Pure view maths for the Predict UI (unit-tested in view.test.ts), ported from the V4 design's
 * predict.js helpers and pointed at the real World data in `./types`:
 *
 * - labels and prices of an outcome (asks / bids in cents; `null` = no World trade, not tradable);
 * - the yield pool of one market and side ("paired" = matched with the opposite side, earning the
 *   USDC pool's supply APY, the design's `side()`);
 * - quotes at the fork maker's flat price (a buy of C at ask p gets C / p shares, as the server);
 * - the bet slip's outcome groups and "If this happens / Pays" scenarios (design `groupsOf` /
 *   `scenarios`), with World's own exclusivity flag (`exh: false` = every listed outcome can lose);
 * - the positions table rows (a position's pool part and its wallet part are separate rows).
 *
 * Nothing here is sample data: every number comes from `/api/predict/*`.
 */
import { MAX_TRADE_CASH, MAX_TRADE_LEGS, MIN_TRADE_CASH } from "./constants";
import type { PredictEvent, PredictOutcome as Outcome, PredictPosition, Side } from "./types";

export { MAX_TRADE_CASH, MAX_TRADE_LEGS, MIN_TRADE_CASH };

/** Default buy amount on the panel and per bet-slip leg (CASH / USDC). */
export const DEF_AMT = "100";
export const LEG_AMT = "50";

// -------------------------------------------------------------------------------------------------
// Outcomes
// -------------------------------------------------------------------------------------------------
export const yl = (o: Outcome) => o.yl || "Yes";
export const nl = (o: Outcome) => o.nl || "No";
export const lab = (o: Outcome, s: Side) => (s === "yes" ? yl(o) : nl(o));
/** Ask in cents (what one share costs now), null when unpriced. */
export const ask = (o: Outcome, s: Side) => (s === "yes" ? o.y : o.n);
/** Bid in cents (what one share sells for now), null when unpriced. */
export const bid = (o: Outcome, s: Side) => (s === "yes" ? o.yBid : o.nBid);
export const other = (s: Side): Side => (s === "yes" ? "no" : "yes");
export const isDraw = (o: Outcome) => o.ab === "DRAW" || /^draw$/i.test(o.name);
/** "Other" (the field) is listed last, like Polymarket. */
export const isOther = (o: Outcome) => /^other$/i.test(o.name);
/** Priced and open (the API's own flag plus both asks present). */
export const canTrade = (o: Outcome) => o.tradable && o.y !== null && o.n !== null;
/** Highest chance first; unpriced outcomes and "Other" last. */
export const byChance = (a: Outcome, b: Outcome) => Number(isOther(a)) - Number(isOther(b)) || (b.y ?? -1) - (a.y ?? -1);
/** Outcomes that decide the event (side markets of a game excluded). */
export const mainOuts = (e: PredictEvent) => e.outs.filter((o) => !o.grp);
/** The market's own name inside an event. */
export const mName = (e: PredictEvent, o: Outcome) => (e.outs.length > 1 ? o.name : e.title);
export const outOf = (e: PredictEvent | undefined | null, k: string | undefined | null) => (e && k ? e.outs.find((o) => o.k === k) : undefined);

/** The outcome an event page opens on: the leader of a multi-outcome event, else the first one. */
export function defaultOut(e: PredictEvent): Outcome {
  const ms = mainOuts(e);
  const list = ms.length ? ms : e.outs;
  if (e.type === "multi" || e.type === "strike") return list.slice().sort(byChance)[0];
  return list.find(canTrade) ?? list[0];
}

/** Two-team games with no draw: No on one team is the same bet as Yes on the other (except a tie). */
export function twinOf(e: PredictEvent, o: Outcome, s: Side): { o: Outcome; s: Side; tie: boolean } | null {
  if (e.type !== "match" || o.grp) return null;
  const ps = mainOuts(e);
  if (ps.length !== 2 || ps.some(isDraw)) return null;
  const t = ps.find((x) => x !== o)!;
  if (!canTrade(t)) return null;
  return { o: t, s: other(s), tie: e.exh === false };
}

// -------------------------------------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------------------------------------
/** `/predict/<eventId>[~<marketId>[~yes|no]]` (a market id opens that market selected). */
export const predictHref = (eventId: string, marketId?: string | null, s?: Side | null) => `/predict/${[eventId, marketId, s].filter(Boolean).join("~")}`;
export function parseRouteId(id: string): { ev: string; mk?: string; sd?: Side } {
  const [ev, mk, sd] = decodeURIComponent(id).split("~");
  return { ev, mk: mk || undefined, sd: sd === "yes" || sd === "no" ? sd : undefined };
}

// -------------------------------------------------------------------------------------------------
// Yield pool ("paired" shares earn the USDC pool's supply APY)
// -------------------------------------------------------------------------------------------------
export interface PoolSide {
  /** Shares of this side in the pool (after `add`). */
  mine: number;
  /** Shares of the opposite side in the pool. */
  opp: number;
  matched: number;
  /** Part of this side that is paired, 0–1. */
  share: number;
  /** Yearly yield on this side at today's balance, %. */
  apy: number;
  /** Every share of this side is paired. */
  full: boolean;
  /** Shares of this side waiting for the other side. */
  waiting: number;
}

/**
 * One market's pool for one side. `pool.yes / no` are each side's unpaired tokens plus the USDC its
 * pairs became (see types.ts), so min(yes, no) = the pairs. `add` = shares about to come in.
 */
export function poolSide(o: Outcome, s: Side, rate: number, add = 0): PoolSide {
  const mine = o.pool[s] + add;
  const opp = o.pool[other(s)];
  const matched = Math.min(mine, opp);
  const share = mine > 0 ? matched / mine : opp > 0 ? 1 : 0;
  return { mine, opp, matched, share, apy: rate * share, full: mine <= opp, waiting: Math.max(0, mine - opp) };
}
/** Paired YES+NO in one market's pool ($1 of USDC lent each). */
export const pairsOf = (o: Outcome) => Math.min(o.pool.yes, o.pool.no);
export const pairsIn = (e: PredictEvent) => e.outs.reduce((t, o) => t + pairsOf(o), 0);
/** Buys on this market go straight into Vanna's pool (the program admin allowlisted it). */
export const pooled = (o: Outcome) => o.poolDetail.allowlisted;
export const anyPooled = (e: PredictEvent) => e.outs.some(pooled);

// -------------------------------------------------------------------------------------------------
// Quotes (the fork maker fills at one price: shares = cash / ask, cash = shares × bid)
// -------------------------------------------------------------------------------------------------
export function quoteBuy(o: Outcome, s: Side, amount: number): { avg: number; sh: number } {
  const p = ask(o, s);
  if (p === null || !(p > 0) || !(amount > 0)) return { avg: p ?? 0, sh: 0 };
  return { avg: p, sh: amount / (p / 100) };
}
export function quoteSell(o: Outcome, s: Side, n: number): { avg: number; usd: number } {
  const p = bid(o, s);
  if (p === null || !(n > 0)) return { avg: p ?? 0, usd: 0 };
  return { avg: p, usd: (n * p) / 100 };
}

/** What a buy does to the pool: your paired shares before / after, and the side's APY before / after. */
export function buyFx(o: Outcome, s: Side, amount: number, rate: number, held = 0) {
  const q = quoteBuy(o, s, amount);
  const into = pooled(o) ? q.sh : 0;
  const before = poolSide(o, s, rate);
  const after = poolSide(o, s, rate, into);
  return { q, before, after, pairedNow: held * before.share, pairedAfter: (held + into) * after.share };
}

// -------------------------------------------------------------------------------------------------
// Bet slip: what can happen in the event (groups) and what each outcome pays (scenarios)
// -------------------------------------------------------------------------------------------------
export interface SlipLeg {
  k: string;
  s: Side;
  /** Shares this leg buys. */
  sh: number;
}
interface State {
  label: string;
  yes: (k: string) => boolean;
  i?: number;
  win?: string | null;
}
interface Group {
  keys: string[];
  states: State[];
  main?: boolean;
  span?: (i: number, j: number) => string;
}

const money = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

/**
 * Groups of outcomes that resolve together. Exclusive events (a World Group, a multi-outcome
 * question) are one group with one state per outcome, plus "None of them" when every listed
 * outcome can lose. Price targets are ladders. Anything else is one independent Yes / No group per
 * market.
 */
export function groupsOf(e: PredictEvent): Group[] {
  const ops = e.outs;
  const ms = mainOuts(e);
  const indep = (o: Outcome): Group => ({ keys: [o.k], states: [{ label: `${o.name}: ${yl(o)}`, yes: () => true }, { label: `${o.name}: ${nl(o)}`, yes: () => false }] });
  const single = (o: Outcome): Group => ({ keys: [o.k], states: [{ label: yl(o), yes: () => true }, { label: nl(o), yes: () => false }] });
  if (ops.length === 1) return [single(ops[0])];
  const lines = ops.filter((o) => o.grp).map(indep);
  if (e.type === "strike") {
    const ups = ms.filter((o) => o.name.startsWith("↑") && o.lv != null).sort((a, b) => a.lv! - b.lv!);
    const dns = ms.filter((o) => o.name.startsWith("↓") && o.lv != null).sort((a, b) => b.lv! - a.lv!);
    const rest = ms.filter((o) => !ups.includes(o) && !dns.includes(o));
    const who = e.asset ?? e.tag;
    const ladder = (list: Outcome[], hit: string, stay: string): Group => {
      const n = list.length;
      const span = (i: number, j: number) =>
        i === 0 && j === n ? "Any outcome" : i === 0 ? `${stay} ${money(list[j].lv!)}` : j === n ? `${hit} ${money(list[i - 1].lv!)}` : `${hit} ${money(list[i - 1].lv!)}, not ${money(list[j].lv!)}`;
      return { keys: list.map((o) => o.k), span, states: [...list.map((_, j) => j), n].map((j) => ({ i: j, label: span(j, j), yes: (key: string) => list.findIndex((o) => o.k === key) < j })) };
    };
    return [
      ...(ups.length ? [ladder(ups, `${who} reaches`, `${who} stays under`)] : []),
      ...(dns.length ? [ladder(dns, `${who} dips to`, `${who} stays above`)] : []),
      ...rest.map(indep),
      ...lines,
    ];
  }
  if (e.type === "match" || e.type === "multi") {
    const isMatch = e.type === "match";
    const states: State[] = ms.map((o) => ({ win: o.k, label: isMatch ? (isDraw(o) ? "Draw" : `${o.name} wins`) : o.name, yes: (k: string) => k === o.k }));
    if (e.exh === false) states.push({ win: null, label: isMatch ? "Tie" : "None of them", yes: () => false });
    return [{ main: true, keys: ms.map((o) => o.k), states }, ...lines];
  }
  return ops.map(indep);
}

export interface Scenario {
  label: string;
  /** What the slip pays in this state; null for a folded range ("N other outcomes"). */
  pay: number | null;
  lo?: number;
  hi?: number;
}

/**
 * One row per distinct payout, best first: "If this happens / Pays". States that pay the same are
 * merged ("A or B", or a ladder span); more than six rows fold the middle into one range row.
 */
export function scenarios(e: PredictEvent, legs: SlipLeg[]): Scenario[] {
  if (!legs.length) return [];
  const gs = groupsOf(e).filter((g) => legs.some((l) => g.keys.includes(l.k)));
  if (!gs.length) return [];
  let combos: { g: Group; st: State }[][] = [[]];
  for (const g of gs) combos = combos.flatMap((c) => g.states.map((st) => [...c, { g, st }]));
  const rows = combos.map((c) => {
    const pay = legs.reduce((t, l) => {
      const it = c.find((x) => x.g.keys.includes(l.k));
      const yes = it ? it.st.yes(l.k) : false;
      return t + ((l.s === "yes") === yes ? l.sh : 0);
    }, 0);
    return { label: c.map((x) => x.st.label).join(", "), pay, i: c.length === 1 ? c[0].st.i : undefined };
  });
  const by = new Map<string, { pay: number; rows: typeof rows }>();
  for (const r of rows) {
    const k = r.pay.toFixed(2);
    if (!by.has(k)) by.set(k, { pay: r.pay, rows: [] });
    by.get(k)!.rows.push(r);
  }
  const g1 = gs.length === 1 && gs[0].span ? gs[0] : null;
  let out: Scenario[] = [...by.values()]
    .sort((a, b) => b.pay - a.pay)
    .map((b) => {
      const ix = b.rows.map((r) => r.i);
      if (g1 && ix.every((i) => i !== undefined)) {
        const nums = ix as number[];
        if (Math.max(...nums) - Math.min(...nums) === nums.length - 1) return { pay: b.pay, label: g1.span!(Math.min(...nums), Math.max(...nums)) };
      }
      const ls = b.rows.map((r) => r.label);
      return { pay: b.pay, label: ls.length <= 2 ? ls.join(" or ") : `${ls[0]}, or ${ls.length - 1} other outcomes` };
    });
  if (out.length > 6) {
    const mid = out.slice(3, -2);
    out = [...out.slice(0, 3), { pay: null, lo: mid[mid.length - 1].pay!, hi: mid[0].pay!, label: `${mid.length} other outcomes` }, ...out.slice(-2)];
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Positions table rows: the pooled part (Vanna) and the wallet part (World) of each position
// -------------------------------------------------------------------------------------------------
export type RowStatus = { cls: "ok" | "warn" | "amber" | "mute"; txt: string };
export interface PosRow {
  key: string;
  kind: "pool" | "wallet";
  p: PredictPosition;
  eventId: string;
  marketId: string;
  side: Side;
  label: string;
  event: string;
  market: string;
  shares: number;
  /** Avg cost and mark, cents. */
  avg: number;
  now: number;
  value: number;
  pnl: number;
  src: "vanna" | "world";
  status: RowStatus;
  /** Wallet part on an allowlisted market: can start earning (deposit). */
  canEarn: boolean;
}

/**
 * Splits each position into its pool part (shares redeemable from the pool, earning on the paired
 * part) and its wallet part (World tokens sitting in the wallet, not earning). Cost is split by
 * principal shares; `allowlisted` says which wallet parts can start earning.
 */
export function positionRows(ps: PredictPosition[], allowlisted: (marketId: string) => boolean): PosRow[] {
  const rows: PosRow[] = [];
  for (const p of ps) {
    const principal = p.walletShares + p.poolShares;
    const costOf = (n: number) => (principal > 0 ? (p.cost * n) / principal : 0);
    const base = { p, eventId: p.eventId, marketId: p.marketId, side: p.side, label: p.label, event: p.event, market: p.market, avg: p.avg * 100, now: p.mark * 100 };
    if (p.poolValueShares > 0) {
      const value = p.poolValueShares * p.mark;
      rows.push({
        ...base,
        key: `${p.id}-pool`,
        kind: "pool",
        shares: p.poolValueShares,
        value,
        pnl: value - costOf(p.poolShares),
        src: "vanna",
        status: p.merging ? { cls: "warn", txt: "Joining the pool" } : { cls: "ok", txt: `Earning ${p.apy.toFixed(2)}%` },
        canEarn: false,
      });
    }
    if (p.walletShares > 0) {
      const value = p.walletShares * p.mark;
      rows.push({
        ...base,
        key: `${p.id}-wallet`,
        kind: "wallet",
        shares: p.walletShares,
        value,
        pnl: value - costOf(p.walletShares),
        src: "world",
        status: { cls: "amber", txt: "Not earning" },
        canEarn: allowlisted(p.marketId),
      });
    }
  }
  return rows;
}
