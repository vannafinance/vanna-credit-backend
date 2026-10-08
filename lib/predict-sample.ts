/**
 * Predict (BETA) — UI-only sample data, shared by the Predict page and the Portfolio → Lender →
 * Predict tab. Mirrors the design prototype's `window.PredictAPI` (index.html predict.js
 * `summary / positions / vault / importable`). No transactions, nothing persisted: an in-memory
 * session store. Buys, sells and "Earn on them" imports on the Predict page mutate the sample
 * account below and bump a zustand revision (plain `create`, NO persist), so every component that
 * reads through `usePredictSample()` (Portfolio too) re-renders in the same session. A page reload
 * resets everything to the design's sample.
 */
import { create } from "zustand";

// ---------------------------------------------------------------------------------------------
// Public shapes (consumed by Portfolio)
// ---------------------------------------------------------------------------------------------

export interface PredictSummary {
  /** Positions value at the mark, USD. */
  value: number;
  cost: number;
  pnl: number;
  /** USDC of matched YES/NO pairs lent in the USDC Earn pool. */
  inVault: number;
  earned: number;
  /** Passive yield on the positions, %. */
  apy: number;
  /** Max payout if every pick wins, USD. */
  payout: number;
  count: number;
  perMonth: number;
}

export interface PredictPosition {
  id: string;
  eventId: string;
  marketId: string;
  event: string;
  market: string;
  outcome: string;
  side: "yes" | "no";
  label: string;
  shares: number;
  yieldShares: number;
  avg: number;
  mark: number;
  value: number;
  cost: number;
  pnl: number;
  inVault: number;
  /** Share of the position matched (lent), 0–100. */
  matched: number;
  earned: number;
  apy: number;
  pays: number;
  since: string;
  /** Shares waiting for the Earn pool to free USDC (queued sell). */
  queued?: number;
  /** Just bought / deposited: pairs are being merged into USDC (earns 0 meanwhile). */
  merging?: boolean;
  /** Where the position came from. */
  src?: "vanna" | "wallet" | "polymarket";
}

export interface PredictVault {
  deposited: number;
  earned: number;
  apy: number;
  pairs: number;
  share: number;
  events: number;
}

export interface PredictImportable {
  id: string;
  source: "wallet" | "polymarket";
  event: string;
  market: string;
  side: "yes" | "no";
  label: string;
  shares: number;
  value: number;
  apy: number;
  /** Listed on Vanna (can be moved / deposited). */
  listed?: boolean;
  eventId?: string | null;
  marketId?: string | null;
}

export const EMPTY_PREDICT_SUMMARY: PredictSummary = { value: 0, cost: 0, pnl: 0, inVault: 0, earned: 0, apy: 0, payout: 0, count: 0, perMonth: 0 };

// ---------------------------------------------------------------------------------------------
// Sample model (design predict.js, verbatim numbers)
// ---------------------------------------------------------------------------------------------

export type Side = "yes" | "no";
export type EventType = "binary" | "updown" | "match" | "multi" | "date" | "strike";
export type Cat = "crypto" | "sports" | "politics" | "economics";

export interface Outcome {
  k: string;
  name: string;
  /** Team / party abbreviation (match events). */
  ab?: string;
  /** Yes / No price in cents. */
  y: number;
  n: number;
  /** 24h change, points. */
  d?: number;
  vol: number;
  /** Outcome shares supplied to Vanna's yield vault (matched pairs = min(yes, no) = USDC lent). */
  pool: { yes: number; no: number };
  /** Custom labels for the Yes / No sides (Up / Down, Over / Under…). */
  yl?: string;
  nl?: string;
  grp?: "lines";
  res?: Side;
  /** Price target (strike events). */
  lv?: number;
  uid: string;
}

export interface PredictEvent {
  id: string;
  type: EventType;
  cat: Cat;
  tag: string;
  title: string;
  ic: string;
  live?: boolean;
  score?: string;
  when?: string;
  last: string;
  ends: string;
  opened: string;
  vol: number;
  v24: number;
  oi: number;
  source: string;
  note?: string;
  rules: string;
  /** false = the listed outcomes can all lose (an NFL tie resolves both teams NO). */
  exh?: boolean;
  asset?: "BTC" | "SOL";
  open?: number;
  countdown?: string;
  outs: Outcome[];
}

interface Pos {
  id: string;
  ev: string;
  o: string;
  side: Side;
  sh: number;
  avg: number;
  yld: number;
  t: string;
  src: "vanna" | "wallet" | "polymarket";
  q?: number;
  mergeAt?: number;
}

export interface ImportItem {
  id: string;
  src: "wallet" | "polymarket";
  ev: string | null;
  o?: string;
  side: Side;
  sh: number;
  avg: number;
  pmBid?: number;
  pmTitle?: string;
  pmOut?: string;
  done?: boolean;
  pos?: string;
  after?: number;
}

type RawOutcome = Omit<Outcome, "uid">;
type RawEvent = Omit<PredictEvent, "outs"> & { outs: RawOutcome[] };

/** Underlying prices used by the price-target / Up-Down events (design core.js PX, sample). */
export const PX = { BTC: 83445.05, SOL: 116.86 } as const;

/** Sample events (World-scale; prices in cents, YES+NO = 100–102). */
const RAW_EVENTS: RawEvent[] = [
  { id: "mlb-cle-cws", type: "match", cat: "sports", tag: "MLB", title: "Guardians vs White Sox", ic: "CLE", live: true, score: "2 - 3", when: "6th inning", last: "1m ago",
    ends: "Oct 7, 2026", opened: "Oct 1, 2026", vol: 296e3, v24: 210e3, oi: 92e3, source: "mlb.com", note: "each party is its own Yes / No market",
    rules: "Each team has its own Yes/No market, resolving YES if that team wins the game (extra innings count). Postponed: stays open until played. Cancelled: resolves 50/50.",
    outs: [
      { k: "cle", name: "Guardians", ab: "CLE", y: 47, n: 54, d: -1, vol: 120e3, pool: { yes: 500, no: 520 } },
      { k: "cws", name: "White Sox", ab: "CWS", y: 54, n: 47, d: 1, vol: 132e3, pool: { yes: 640, no: 400 } },
      { k: "spread", grp: "lines", name: "Spread 1.5", yl: "CLE +1.5", nl: "CWS −1.5", y: 66, n: 35, d: 0, vol: 22e3, pool: { yes: 120, no: 90 } },
      { k: "total", grp: "lines", name: "Total runs 8.5", yl: "Over", nl: "Under", y: 46, n: 55, d: 2, vol: 22e3, pool: { yes: 200, no: 210 } },
    ] },
  { id: "fed-oct", type: "multi", cat: "economics", tag: "Fed", title: "Fed decision in October?", ic: "FED", last: "4m ago",
    ends: "Oct 28, 2026", opened: "Jun 17, 2026", vol: 2.41e6, v24: 186e3, oi: 410e3, source: "federalreserve.gov",
    rules: "Resolves to the change in the upper bound of the federal funds target range announced after the Oct 27-28 FOMC meeting. Exactly one outcome resolves YES.",
    outs: [
      { k: "nochg", name: "No change", y: 83, n: 18, d: 2, vol: 820e3, pool: { yes: 2400, no: 1900 } },
      { k: "cut25", name: "25 bps cut", y: 15, n: 86, d: -2, vol: 640e3, pool: { yes: 900, no: 1300 } },
      { k: "hike25", name: "25 bps hike", y: 2, n: 99, d: 0, vol: 410e3, pool: { yes: 120, no: 300 } },
      { k: "cut50", name: "50+ bps cut", y: 0.8, n: 99.3, d: 0, vol: 540e3, pool: { yes: 20, no: 60 } },
      { k: "hike50", name: "50+ bps hike", y: 0.4, n: 99.7, d: 0, vol: 390e3, pool: { yes: 20, no: 30 } },
    ] },
  { id: "iran-blockade", type: "date", cat: "politics", tag: "Geopolitics", title: "US ends Iran blockade by…?", ic: "US", last: "2m ago",
    ends: "Mar 31, 2027", opened: "Jul 14, 2026", vol: 3.12e6, v24: 152e3, oi: 520e3, source: "Official US government statements", note: "a later date includes the earlier ones",
    rules: "Each date resolves YES if the US government officially announces the end or suspension of its naval blockade of Iran by that date (11:59 PM ET). A later date includes every earlier one, so its chance is higher.",
    outs: [
      { k: "aug31", name: "Aug 31", res: "no", y: 0, n: 100, vol: 494e3, pool: { yes: 0, no: 0 } },
      { k: "sep30", name: "Sep 30", res: "no", y: 0, n: 100, vol: 559e3, pool: { yes: 0, no: 0 } },
      { k: "oct15", name: "Oct 15", y: 11, n: 90, d: -3, vol: 183e3, pool: { yes: 300, no: 900 } },
      { k: "oct31", name: "Oct 31", y: 20, n: 81, d: -4, vol: 376e3, pool: { yes: 500, no: 650 } },
      { k: "nov30", name: "Nov 30", y: 32, n: 69, d: -2, vol: 81e3, pool: { yes: 220, no: 260 } },
      { k: "dec31", name: "Dec 31", y: 49, n: 52, d: -2, vol: 295e3, pool: { yes: 1400, no: 1100 } },
      { k: "mar31", name: "Mar 31, 2027", y: 72, n: 29, d: -1, vol: 39e3, pool: { yes: 300, no: 120 } },
    ] },
  { id: "btc-oct", type: "strike", cat: "crypto", tag: "Bitcoin", title: "What price will Bitcoin hit in October?", ic: "BTC", asset: "BTC", last: "1m ago", countdown: "24d 9h",
    ends: "Oct 31, 2026", opened: "Oct 1, 2026", vol: 1.06e6, v24: 140e3, oi: 230e3, source: "Binance BTC/USDT 1-minute candles", note: "each target is its own Yes / No market",
    rules: "↑ rows resolve YES if any Binance BTC/USDT 1-minute candle in October has a high at or above the price; ↓ rows if a low is at or below it.",
    outs: [
      { k: "u95", name: "↑ 95,000", lv: 95000, y: 14, n: 87, d: -3, vol: 107e3, pool: { yes: 300, no: 450 } },
      { k: "u90", name: "↑ 90,000", lv: 90000, y: 37, n: 64, d: -6, vol: 131e3, pool: { yes: 400, no: 380 } },
      { k: "d80", name: "↓ 80,000", lv: 80000, y: 66, n: 35, d: 9, vol: 106e3, pool: { yes: 650, no: 420 } },
      { k: "d75", name: "↓ 75,000", lv: 75000, y: 26, n: 75, d: 4, vol: 163e3, pool: { yes: 200, no: 300 } },
    ] },
  { id: "nfl-ne-jax", type: "match", cat: "sports", tag: "NFL", title: "Patriots vs Jaguars", ic: "NE", when: "Sun, Oct 12 · 13:00", exh: false, last: "6m ago",
    ends: "Oct 12, 2026", opened: "Sep 1, 2026", vol: 640e3, v24: 120e3, oi: 140e3, source: "nfl.com", note: "each party is its own Yes / No market",
    rules: "Each team has its own Yes/No market, resolving YES if that team wins. A tie resolves both markets NO.",
    outs: [
      { k: "ne", name: "Patriots", ab: "NE", y: 58, n: 43, d: 3, vol: 330e3, pool: { yes: 800, no: 700 } },
      { k: "jax", name: "Jaguars", ab: "JAX", y: 43, n: 58, d: -3, vol: 310e3, pool: { yes: 1100, no: 760 } },
    ] },
  { id: "sol-week", type: "updown", cat: "crypto", tag: "Solana", title: "Solana Up or Down this week?", ic: "SOL", asset: "SOL", open: 112.4, when: "Closes in 4d 21h", countdown: "4d 21h", last: "1m ago",
    ends: "Oct 12, 2026", opened: "Oct 5, 2026", vol: 184e3, v24: 96e3, oi: 41e3, source: "Pyth SOL/USD",
    rules: "Resolves UP if SOL/USD on Pyth at Oct 12, 12:00 ET is above the Oct 5, 12:00 ET open ($112.40); otherwise DOWN.",
    outs: [{ k: "m", name: "SOL this week", yl: "Up", nl: "Down", y: 54, n: 47, d: 6, vol: 184e3, pool: { yes: 500, no: 380 } }] },
  { id: "lal-bar-osa", type: "match", cat: "sports", tag: "La Liga", title: "Barcelona vs Osasuna", ic: "BAR", when: "Sat, Oct 11 · 16:30", last: "12m ago",
    ends: "Oct 11, 2026", opened: "Sep 20, 2026", vol: 312e3, v24: 88e3, oi: 64e3, source: "laliga.com", note: "each party is its own Yes / No market",
    rules: "Three markets: Barcelona wins, Draw, Osasuna wins (90 minutes plus stoppage time). Exactly one resolves YES.",
    outs: [
      { k: "bar", name: "Barcelona", ab: "BAR", y: 71, n: 30, d: 1, vol: 180e3, pool: { yes: 900, no: 620 } },
      { k: "draw", name: "Draw", ab: "DRAW", y: 18, n: 83, d: 0, vol: 61e3, pool: { yes: 160, no: 400 } },
      { k: "osa", name: "Osasuna", ab: "OSA", y: 12, n: 89, d: -1, vol: 71e3, pool: { yes: 150, no: 300 } },
    ] },
  { id: "dem-2028", type: "multi", cat: "politics", tag: "US Election", title: "Democratic nominee 2028?", ic: "DEM", last: "8m ago",
    ends: "Aug 31, 2028", opened: "Nov 6, 2024", vol: 9.8e6, v24: 74e3, oi: 1.9e6, source: "Democratic National Convention",
    rules: 'Resolves to the person nominated as the Democratic Party candidate for US President in 2028. Exactly one outcome resolves YES; "Other" covers everyone not listed.',
    outs: [
      { k: "aoc", name: "Alexandria Ocasio-Cortez", y: 18, n: 83, d: 1, vol: 1.5e6, pool: { yes: 600, no: 330 } },
      { k: "newsom", name: "Gavin Newsom", y: 17, n: 84, d: 0, vol: 2.8e6, pool: { yes: 700, no: 520 } },
      { k: "ossoff", name: "Jon Ossoff", y: 15, n: 86, d: 2, vol: 1.3e6, pool: { yes: 300, no: 260 } },
      { k: "harris", name: "Kamala Harris", y: 7, n: 94, d: 0, vol: 1.4e6, pool: { yes: 150, no: 400 } },
      { k: "shapiro", name: "Josh Shapiro", y: 6, n: 95, d: 0, vol: 1.0e6, pool: { yes: 90, no: 120 } },
      { k: "buttigieg", name: "Pete Buttigieg", y: 5, n: 96, d: 0, vol: 1.2e6, pool: { yes: 60, no: 80 } },
      { k: "beshear", name: "Andy Beshear", y: 3, n: 98, d: 0, vol: 0.9e6, pool: { yes: 30, no: 40 } },
      { k: "moore", name: "Wes Moore", y: 2, n: 99, d: 0, vol: 0.7e6, pool: { yes: 20, no: 25 } },
      { k: "other", name: "Other", y: 28, n: 73, d: 0, vol: 0.4e6, pool: { yes: 120, no: 90 } },
    ] },
  { id: "house-2026", type: "multi", cat: "politics", tag: "Midterms", title: "Which party wins the House in 2026?", ic: "US", last: "3m ago",
    ends: "Nov 3, 2026", opened: "Jan 5, 2025", vol: 4.6e6, v24: 66e3, oi: 1.1e6, source: "Official election results",
    rules: "Resolves to the party that wins a majority of voting seats in the US House of Representatives in the 2026 midterm election.",
    outs: [
      { k: "dem", name: "Democrats", y: 93, n: 8, d: 1, vol: 2.6e6, pool: { yes: 1500, no: 900 } },
      { k: "rep", name: "Republicans", y: 8, n: 93, d: -1, vol: 2.0e6, pool: { yes: 300, no: 450 } },
    ] },
  { id: "btc100k", type: "binary", cat: "crypto", tag: "Bitcoin", title: "Will Bitcoin reach $100,000 by Dec 31?", ic: "BTC", last: "5m ago",
    ends: "Dec 31, 2026", opened: "Jan 2, 2026", vol: 1.48e6, v24: 61e3, oi: 320e3, source: "Binance BTC/USDT",
    rules: "Resolves YES if any Binance BTC/USDT 1-minute candle has a high at or above $100,000 before Dec 31, 2026, 11:59 PM ET.",
    outs: [{ k: "m", name: "Bitcoin $100K by Dec 31", y: 18, n: 83, d: -2, vol: 1.48e6, pool: { yes: 1300, no: 900 } }] },
  { id: "ceasefire", type: "date", cat: "politics", tag: "Geopolitics", title: "US–Iran ceasefire holds through…?", ic: "IR", last: "9m ago",
    ends: "Dec 31, 2026", opened: "Sep 2, 2026", vol: 820e3, v24: 58e3, oi: 150e3, source: "Consensus of credible reporting", note: "each later date needs the calm to last longer",
    rules: "Each date resolves NO if the US carries out an air or missile strike on Iran by that date (Iran time); otherwise YES. Later dates need a longer calm, so their chance is lower.",
    outs: [
      { k: "sep30", name: "Sep 30", res: "yes", y: 100, n: 0, vol: 2.45e6, pool: { yes: 0, no: 0 } },
      { k: "oct15", name: "Oct 15", y: 91, n: 10, d: 3, vol: 253e3, pool: { yes: 600, no: 200 } },
      { k: "oct31", name: "Oct 31", y: 75, n: 26, d: 2, vol: 330e3, pool: { yes: 800, no: 500 } },
      { k: "nov30", name: "Nov 30", y: 45, n: 56, d: 4, vol: 133e3, pool: { yes: 150, no: 180 } },
      { k: "dec31", name: "Dec 31", y: 35, n: 66, d: 1, vol: 104e3, pool: { yes: 90, no: 140 } },
    ] },
  { id: "ucl-2027", type: "multi", cat: "sports", tag: "UCL", title: "Champions League winner 2027?", ic: "UCL", last: "22m ago",
    ends: "May 29, 2027", opened: "Jul 1, 2026", vol: 2.2e6, v24: 33e3, oi: 480e3, source: "uefa.com",
    rules: 'Resolves to the club that wins the 2026-27 UEFA Champions League final. Exactly one outcome resolves YES; "Other" covers every club not listed.',
    outs: [
      { k: "bar", name: "Barcelona", y: 23, n: 78, d: 1, vol: 520e3, pool: { yes: 300, no: 260 } },
      { k: "bay", name: "Bayern Munich", y: 15, n: 86, d: 0, vol: 410e3, pool: { yes: 200, no: 110 } },
      { k: "ars", name: "Arsenal", y: 13, n: 88, d: 1, vol: 380e3, pool: { yes: 150, no: 160 } },
      { k: "psg", name: "Paris Saint-Germain", y: 11, n: 90, d: -1, vol: 330e3, pool: { yes: 100, no: 140 } },
      { k: "liv", name: "Liverpool", y: 9, n: 92, d: 0, vol: 290e3, pool: { yes: 80, no: 90 } },
      { k: "rma", name: "Real Madrid", y: 8, n: 93, d: -1, vol: 270e3, pool: { yes: 70, no: 60 } },
      { k: "other", name: "Other", y: 22, n: 79, d: 0, vol: 160e3, pool: { yes: 90, no: 70 } },
    ] },
  { id: "clarity", type: "binary", cat: "politics", tag: "Crypto policy", title: "Crypto market structure bill signed into law in 2026?", ic: "LAW", last: "2h ago",
    ends: "Dec 31, 2026", opened: "Mar 3, 2026", vol: 410e3, v24: 21e3, oi: 96e3, source: "congress.gov",
    rules: "Resolves YES if a federal crypto market structure bill is signed into law by Dec 31, 2026, 11:59 PM ET.",
    outs: [{ k: "m", name: "Signed in 2026", y: 34, n: 67, d: 3, vol: 410e3, pool: { yes: 400, no: 520 } }] },
  { id: "recession", type: "binary", cat: "economics", tag: "US economy", title: "US recession in 2026?", ic: "GDP", last: "5h ago",
    ends: "Feb 28, 2027", opened: "Jan 2, 2026", vol: 690e3, v24: 12e3, oi: 170e3, source: "NBER / BEA",
    rules: "Resolves YES if the NBER declares a US recession that began in 2026, or BEA reports two consecutive quarters of negative real GDP growth in 2026.",
    outs: [{ k: "m", name: "Recession in 2026", y: 9, n: 92, d: 0, vol: 690e3, pool: { yes: 200, no: 650 } }] },
];

/** Yield the vault has paid out to date (all users, USD), sample. */
const VAULT_EARNED = 213.4;
/** Demo: free USDC when "tight liquidity" is toggled (Earn pool almost fully borrowed). */
export const TIGHT_FREE = 60;
/** Default buy amount (USDC). */
export const DEF_AMT = "100";
/** How long a fresh buy / deposit shows "Merging into the Earn pool" (ms). */
const MERGE_MS = 3500;

/** The whole mutable sample session (fresh copy per page load; never persisted). */
interface Model {
  EV: PredictEvent[];
  pos: Pos[];
  imp: ImportItem[];
  seq: number;
  /** Linked Polymarket account (read-only), sample. */
  pm: { addr: string; how: "wallet" | "address" } | null;
  /** Sample wallet balances used by the trade panel. */
  wallet: { USDC: number; CASH: number };
  /** The USDC Earn pool row (sample): sup / bor / supply APY, `fromPredict` = matched pairs lent. */
  usdc: { sup: number; bor: number; supA: number; util: number; fromPredict: number };
  /** Demo toggle: Earn pool nearly fully borrowed, so part of a sell queues. */
  tight: boolean;
  tightFree: number;
}

function freshModel(): Model {
  const EV: PredictEvent[] = RAW_EVENTS.map((e) => ({ ...e, outs: e.outs.map((o) => ({ ...o, pool: { ...o.pool }, uid: `${e.id}/${o.k}` })) }));
  return {
    EV,
    seq: 10,
    pos: [
      { id: "pp1", ev: "nfl-ne-jax", o: "jax", side: "yes", sh: 300, avg: 0.41, yld: 0.92, t: "Sep 7", src: "vanna" },
      { id: "pp2", ev: "fed-oct", o: "cut25", side: "yes", sh: 400, avg: 0.12, yld: 1.18, t: "Sep 17", src: "vanna" },
      { id: "pp3", ev: "iran-blockade", o: "dec31", side: "yes", sh: 250, avg: 0.44, yld: 0.73, t: "Sep 12", src: "vanna" },
      { id: "pp4", ev: "lal-bar-osa", o: "bar", side: "yes", sh: 150, avg: 0.64, yld: 0.14, t: "Sep 28", src: "vanna" },
    ],
    // Held elsewhere, not earning yet: wallet = World outcome tokens in the connected wallet,
    // polymarket = positions in a Polymarket account (needs a read-only link).
    imp: [
      { id: "w1", src: "wallet", ev: "btc100k", o: "m", side: "no", sh: 220, avg: 0.78 },
      { id: "w2", src: "wallet", ev: "dem-2028", o: "newsom", side: "yes", sh: 200, avg: 0.14 },
      { id: "pm1", src: "polymarket", ev: "fed-oct", o: "nochg", side: "yes", sh: 500, avg: 0.79, pmBid: 82.5, pmTitle: "Fed Decision in October?", pmOut: "No change" },
      { id: "pm2", src: "polymarket", ev: "ceasefire", o: "oct31", side: "yes", sh: 300, avg: 0.7, pmBid: 74, pmTitle: "US x Iran ceasefire continues through October 31?", pmOut: "Yes" },
      { id: "pm3", src: "polymarket", ev: null, side: "yes", sh: 1000, avg: 0.15, pmBid: 17, pmTitle: "Elon Musk # tweets October 6 - October 13, 2026?", pmOut: "240-259" },
    ],
    pm: null,
    wallet: { USDC: 850, CASH: 240 },
    usdc: { sup: 69750, bor: 52300, supA: 5.4, util: 75, fromPredict: 16480 },
    tight: false,
    tightFree: TIGHT_FREE,
  };
}

const M: Model = freshModel();

// ---------------------------------------------------------------------------------------------
// Session store: a revision counter (re-render trigger) + the page's toast. No persist.
// ---------------------------------------------------------------------------------------------

interface PredictStore {
  rev: number;
  toast: string | null;
  /** Import sheet open on this tab (any page may open it, e.g. Portfolio). */
  importTab: "wallet" | "polymarket" | null;
}
export const usePredictStore = create<PredictStore>(() => ({ rev: 0, toast: null, importTab: null }));

let toastT: ReturnType<typeof setTimeout> | null = null;
/** Re-render every reader of the sample. */
function bump() {
  usePredictStore.setState((s) => ({ rev: s.rev + 1 }));
}
/** Show the page toast (4.2 s, as the design). */
export function predictToast(msg: string) {
  usePredictStore.setState({ toast: msg });
  if (toastT) clearTimeout(toastT);
  toastT = setTimeout(() => usePredictStore.setState({ toast: null }), 4200);
}
/** Open the "Bring your positions" sheet (Portfolio's "Earn on them" uses this too). */
export function openPredictImport(tab?: "wallet" | "polymarket") {
  usePredictStore.setState({ importTab: tab ?? (impLeft("wallet").length ? "wallet" : "polymarket") });
}
export function closePredictImport() {
  usePredictStore.setState({ importTab: null });
}

let mergeT: ReturnType<typeof setTimeout> | null = null;
/** After a buy / deposit the "merging" flag expires: re-render then. */
function scheduleMerge() {
  const now = Date.now();
  const next = M.pos.filter((p) => p.mergeAt && p.mergeAt > now).map((p) => p.mergeAt as number).sort((a, b) => a - b)[0];
  if (mergeT) clearTimeout(mergeT);
  if (!next) return;
  mergeT = setTimeout(() => {
    bump();
    scheduleMerge();
  }, next - now + 80);
}

// ---------------------------------------------------------------------------------------------
// Market maths (design predict.js)
// ---------------------------------------------------------------------------------------------

/** What merged pairs earn: the USDC Earn supply APY (sample rate). */
export const RATE = () => M.usdc.supA;
const FREE_USDC = () => Math.max(0, M.usdc.sup - M.usdc.bor);
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const events = () => M.EV;
export const EVM = (id: string | undefined | null) => M.EV.find((e) => e.id === id);
export const OUT = (e: PredictEvent | undefined, k: string | undefined) => (e ? e.outs.find((o) => o.k === k) : undefined);
export const yl = (o: Outcome) => o.yl || "Yes";
export const nl = (o: Outcome) => o.nl || "No";
export const lab = (o: Outcome, s: Side) => (s === "yes" ? yl(o) : nl(o));
export const ask = (o: Outcome, s: Side) => (s === "yes" ? o.y : o.n);
/** 0.1¢ steps only below 1¢ and above 99¢. */
const tick = (c: number) => (c <= 1 || c > 99 ? 0.1 : 1);
export const bid = (o: Outcome, s: Side) => {
  const a = ask(o, s);
  return Math.max(0, +(a - tick(a)).toFixed(1));
};
export const openOuts = (e: PredictEvent) => e.outs.filter((o) => !o.res);
/** "Other" (the field) is listed last, like Polymarket. */
export const isOther = (o: Outcome) => o.k === "other";
export const byChance = (a: Outcome, b: Outcome) => Number(isOther(a)) - Number(isOther(b)) || b.y - a.y;

// Deterministic random (charts, books, activity).
export const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
export const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export interface Level {
  p: number;
  q: number;
}
const BK: Record<string, Level[]> = {};
/** Order-book levels per market and side, generated once (dir 1 = asks / buy, −1 = bids / sell). */
export function levels(o: Outcome, s: Side, dir: 1 | -1): Level[] {
  const key = `${o.uid}/${s}${dir > 0 ? "/a" : "/b"}`;
  if (BK[key]) return BK[key];
  const r = rng(hash(key));
  const p0 = dir > 0 ? ask(o, s) : bid(o, s);
  const depthUsd = Math.max(2500, (o.vol || 50e3) * 0.02);
  const base = (depthUsd / 6 / Math.max(p0, 0.5)) * 100;
  const out: Level[] = [];
  let p = p0;
  for (let i = 0; i < 60 && p > 0 && p < 100; i++) {
    out.push({ p: +p.toFixed(1), q: Math.round(base * (0.45 + r() * 1.1) * (1 + i * 0.12)) });
    p = +(p + (dir > 0 ? (p < 1 || p >= 99 ? 0.1 : 1) : -(p <= 1 || p > 99 ? 0.1 : 1))).toFixed(1);
  }
  return (BK[key] = out);
}
/** Quote a buy of `usdAmt` against the ask levels: avg price (¢) and shares. */
export function qBuy(o: Outcome, s: Side, usdAmt: number) {
  const lv = levels(o, s, 1);
  if (!(usdAmt > 0) || !lv.length) return { avg: ask(o, s), sh: 0 };
  let left = usdAmt;
  let sh = 0;
  for (const l of lv) {
    const cost = (l.q * l.p) / 100;
    if (cost >= left) {
      sh += left / (l.p / 100);
      left = 0;
      break;
    }
    sh += l.q;
    left -= cost;
  }
  const spent = usdAmt - left;
  return { avg: sh ? (spent / sh) * 100 : ask(o, s), sh };
}
/** Quote a sell of `n` shares against the bid levels: avg price (¢) and USD received. */
export function qSell(o: Outcome, s: Side, n: number) {
  const lv = levels(o, s, -1);
  if (!(n > 0) || !lv.length) return { avg: bid(o, s), usd: 0 };
  let left = n;
  let got = 0;
  for (const l of lv) {
    const take = Math.min(left, l.q);
    got += (take * l.p) / 100;
    left -= take;
    if (left <= 1e-9) break;
  }
  const sold = n - left;
  return { avg: sold ? (got / sold) * 100 : bid(o, s), usd: got };
}
/** The vault for one market and one side; `add` = shares about to be deposited. */
export function side(o: Outcome, s: Side, add = 0) {
  const mine = o.pool[s] + add;
  const other = o.pool[s === "yes" ? "no" : "yes"];
  const matched = Math.min(mine, other);
  const share = mine > 0 ? matched / mine : other > 0 ? 1 : 0;
  return { mine, other, matched, share, apy: RATE() * share, scarce: mine <= other, dangling: Math.max(0, mine - other) };
}
export const pairsOf = (o: Outcome) => (o.res ? 0 : Math.min(o.pool.yes, o.pool.no));
export const lentOf = (e: PredictEvent) => openOuts(e).reduce((t, o) => t + pairsOf(o), 0);
const totalPairs = () => M.EV.reduce((t, e) => t + lentOf(e), 0);
/** Keep the (sample) USDC Earn pool in step with the vault: each matched pair is $1 lent. */
function syncPool() {
  const u = M.usdc;
  const pairs = totalPairs();
  const d = pairs - (u.fromPredict || 0);
  if (Math.abs(d) > 1e-9) u.sup += d;
  u.fromPredict = pairs;
  u.util = u.sup ? (u.bor / u.sup) * 100 : 0;
}
syncPool();
export const usdcPool = () => M.usdc;
export const freeNow = () => (M.tight ? M.tightFree : FREE_USDC());
export const isTight = () => M.tight;
/** One-click sell: the market's unmatched shares of this side first, the rest withdraws USDC from the Earn pool and splits it. */
export function sellRoute(o: Outcome, s: Side, n: number) {
  const sd = side(o, s);
  const fromVault = Math.min(n, sd.dangling);
  const needUsd = Math.max(0, n - fromVault);
  const free = freeNow();
  const nowUsd = Math.min(needUsd, free);
  const queued = needUsd - nowUsd;
  return { fromVault, needUsd, free, nowUsd, queued, nowSh: fromVault + nowUsd };
}

export const posOf = (e: PredictEvent, o: Outcome, s: Side) => M.pos.find((p) => p.ev === e.id && p.o === o.k && p.side === s);
export const posIn = (e: PredictEvent) => M.pos.filter((p) => p.ev === e.id);
export const allPos = () => M.pos;
/** Shares of this side the account holds in the vault (minus queued). */
export const heldOf = (e: PredictEvent, o: Outcome, s: Side) => {
  const p = posOf(e, o, s);
  return p ? Math.max(0, p.sh + p.yld - (p.q || 0)) : 0;
};
export type { Pos as PredictPos };

/** A position's numbers at the mark (bid). */
export function pmx(p: Pos) {
  const e = EVM(p.ev) as PredictEvent;
  const o = OUT(e, p.o) as Outcome;
  const tot = p.sh + p.yld;
  const mk = bid(o, p.side) / 100;
  const sd = side(o, p.side);
  const merging = !!(p.mergeAt && Date.now() < p.mergeAt);
  const value = tot * mk;
  const cost = p.sh * p.avg;
  return { e, o, tot, mk, value, cost, pnl: value - cost, inVault: merging ? 0 : tot * sd.share * mk, earned: p.yld * mk, apy: merging ? 0 : sd.apy, pays: tot, sd, merging };
}
export type Pmx = ReturnType<typeof pmx>;
/** Value-weighted APY of some positions. */
export const yourApy = (ps: Pmx[]) => {
  const v = ps.reduce((t, m) => t + m.value, 0);
  return v ? ps.reduce((t, m) => t + m.value * m.apy, 0) / v : 0;
};
/** Most the positions can pay together: in a match / multi event only one outcome wins, so take the best case there. */
function maxPayout() {
  let t = 0;
  M.EV.forEach((e) => {
    const ps = M.pos.filter((p) => p.ev === e.id);
    if (!ps.length) return;
    const n = (p: Pos) => p.sh + p.yld;
    if (e.type !== "match" && e.type !== "multi") {
      t += ps.reduce((a, p) => a + n(p), 0);
      return;
    }
    const main = ps.filter((p) => !OUT(e, p.o)?.grp);
    t += ps.filter((p) => OUT(e, p.o)?.grp).reduce((a, p) => a + n(p), 0);
    const wins: (string | null)[] = e.outs.filter((o) => !o.grp && !o.res).map((o) => o.k);
    if (e.exh === false) wins.push(null);
    t += Math.max(0, ...wins.map((w) => main.reduce((a, p) => a + ((p.side === "yes") === (p.o === w) ? n(p) : 0), 0)));
  });
  return t;
}
/** Two-party games with no draw: No on one team is the same bet as Yes on the other (except an NFL tie). */
export function twinOf(e: PredictEvent, o: Outcome, s: Side) {
  if (e.type !== "match" || o.grp) return null;
  const ps = e.outs.filter((x) => !x.grp);
  if (ps.length !== 2) return null;
  return { o: ps.find((x) => x !== o) as Outcome, s: (s === "yes" ? "no" : "yes") as Side, tie: e.exh === false };
}
/** What a buy of usdAmt does to the vault: new pairs = new USDC lent; dilution of the side already held. */
export function buyFx(o: Outcome, s: Side, usdAmt: number) {
  const q = qBuy(o, s, usdAmt);
  const before = side(o, s);
  const after = side(o, s, q.sh);
  const newPairs = Math.min(o.pool[s] + q.sh, after.other) - Math.min(o.pool[s], after.other);
  return { q, before, after, newPairs };
}
/** The selected market of an event when none is chosen: the leader of a multi, else the first open one. */
export function defaultOut(e: PredictEvent) {
  const op = openOuts(e).filter((x) => !x.grp);
  if (e.type === "multi") return op.slice().sort(byChance)[0].k;
  return op[0].k;
}

// ---------------------------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------------------------

export const impLeft = (src: "wallet" | "polymarket") => M.imp.filter((x) => x.src === src && !x.done);
export const impAll = (src: "wallet" | "polymarket") => M.imp.filter((x) => x.src === src);
export const pmLink = () => M.pm;
/** An import row's display numbers. */
export function impx(x: ImportItem) {
  const e = x.ev ? EVM(x.ev) : undefined;
  const o = e ? OUT(e, x.o) : undefined;
  const L = o ? lab(o, x.side) : x.side === "yes" ? "Yes" : "No";
  const price = x.src === "polymarket" || !o ? (x.pmBid ?? 0) : bid(o, x.side);
  const sd = o ? side(o, x.side, x.done ? 0 : x.sh) : null;
  const pmRow = x.src === "polymarket";
  return {
    e,
    o,
    L,
    event: pmRow || !e ? (x.pmTitle ?? "") : e.title,
    market: pmRow || !o ? (x.pmOut ?? "") : e && e.outs.length > 1 ? o.name : "",
    value: (x.sh * price) / 100,
    price,
    apy: sd ? sd.apy : 0,
    share: sd ? sd.share : 0,
  };
}
/** Quote for moving a Polymarket position to Vanna (sell there, bridge, buy here). */
export function mvQuote(x: ImportItem) {
  const e = EVM(x.ev) as PredictEvent;
  const o = OUT(e, x.o) as Outcome;
  const pmBid = x.pmBid ?? 0;
  const sellAvg = Math.max(0.1, pmBid * (1 - (0.6 * ((x.sh * pmBid) / 100)) / 60e3)); // Polymarket's book is deeper
  const proceeds = (x.sh * sellAvg) / 100;
  const bridge = 0.4;
  const cash = proceeds - bridge;
  const qb = qBuy(o, x.side, cash);
  const sd = side(o, x.side, qb.sh);
  const lossSh = x.sh - qb.sh;
  const a0 = ask(o, x.side);
  const sellSlip = ((pmBid - sellAvg) / pmBid) * 100;
  const buySlip = ((qb.avg - a0) / a0) * 100;
  return {
    sellAvg, proceeds, bridge, cash, buyAvg: qb.avg, after: qb.sh, gap: qb.avg - sellAvg, lossSh, lossPct: (lossSh / x.sh) * 100,
    lossUsd: (lossSh * qb.avg) / 100, apy: sd.apy, share: sd.share, mo: (cash * sd.share * RATE()) / 100 / 12,
    sellSlip, buySlip, limit: Math.ceil((Math.max(sellSlip, buySlip) + 0.5) * 2) / 2, realised: proceeds - x.sh * x.avg,
  };
}
export type MoveQuote = ReturnType<typeof mvQuote>;

// ---------------------------------------------------------------------------------------------
// Actions (in-memory only — nothing is sent anywhere)
// ---------------------------------------------------------------------------------------------

export const sampleWallet = () => M.wallet;
const TODAY_LABEL = "Oct 7";

/** Sample buy: spends sample USDC/CASH, adds shares to the vault. Returns the toast text. */
export function sampleBuy(e: PredictEvent, o: Outcome, s: Side, a: number, pay: "USDC" | "CASH"): string | null {
  if (!(a > 0) || a > (M.wallet[pay] || 0)) return null;
  const L = lab(o, s);
  const fx = buyFx(o, s, a);
  const q = fx.q;
  M.wallet[pay] -= a;
  o.pool[s] += q.sh;
  o.vol += a;
  e.vol += a;
  e.v24 += a;
  let p = posOf(e, o, s);
  if (p) {
    const c = p.sh * p.avg + a;
    p.sh += q.sh;
    p.avg = c / p.sh;
  } else {
    p = { id: `pp${++M.seq}`, ev: e.id, o: o.k, side: s, sh: q.sh, avg: q.avg / 100, yld: 0, t: TODAY_LABEL, src: "vanna" };
    M.pos.push(p);
  }
  p.mergeAt = Date.now() + MERGE_MS;
  syncPool();
  bump();
  scheduleMerge();
  return `Preview: bought ${shf(q.sh)} ${L}${e.outs.length > 1 ? ` · ${o.name}` : ""}. ${fx.newPairs > 0.005 ? `+${usdS(fx.newPairs)} lent in the Earn pool` : "Larger side: no new USDC lent"}; earning ${(fx.after.apy).toFixed(2)}% once merged`;
}
function sellShares(e: PredictEvent, o: Outcome, p: Pos, n: number) {
  const tot = p.sh + p.yld;
  const q = qSell(o, p.side, n);
  const f = n / tot;
  p.sh -= p.sh * f;
  p.yld -= p.yld * f;
  o.pool[p.side] = Math.max(0, o.pool[p.side] - n);
  o.vol += q.usd;
  e.vol += q.usd;
  M.wallet.USDC += q.usd;
  syncPool();
  return q.usd;
}
/** Shares a sell would sell (snaps to the full holding when the rest would be dust). */
export function sellN(e: PredictEvent, o: Outcome, s: Side, a: number) {
  const held = heldOf(e, o, s);
  return a > 0 && held - Math.min(a, held) < 0.01 ? held : Math.min(a, held);
}
/** Sample sell (unmatched first, then USDC withdrawn + split; any shortfall queues). Returns the toast text. */
export function sampleSell(e: PredictEvent, o: Outcome, s: Side, a: number): string | null {
  const p = posOf(e, o, s);
  if (!p) return null;
  const L = lab(o, s);
  const n = sellN(e, o, s, a);
  if (!(n > 0)) return null;
  const r = sellRoute(o, s, n);
  let got: number | null = null;
  if (r.nowSh > 0) {
    got = sellShares(e, o, p, r.nowSh);
    if (M.tight) M.tightFree = Math.max(0, M.tightFree - r.nowUsd);
  }
  if (r.queued > 0) p.q = (p.q || 0) + r.queued;
  if (p.sh + p.yld < 1e-6) M.pos = M.pos.filter((x) => x !== p);
  bump();
  return got != null
    ? `Preview: sold ${shf(r.nowSh)} ${L} for ${usdS(got)}${r.nowUsd > 0.005 ? ` (${usdS(r.nowUsd)} withdrawn from the Earn pool)` : ""}${r.queued ? `. ${shf(r.queued)} queued` : ""}`
    : `Preview: ${shf(r.queued)} ${L} queued: sells when the Earn pool has USDC`;
}
/** Demo toggle for tight Earn-pool liquidity; turning it off completes queued sells. */
export function toggleTight(): string | null {
  M.tight = !M.tight;
  M.tightFree = TIGHT_FREE;
  let msg: string | null = null;
  if (!M.tight) {
    let done = 0;
    let sum = 0;
    M.pos.slice().forEach((p) => {
      if (!p.q) return;
      const e = EVM(p.ev) as PredictEvent;
      const o = OUT(e, p.o) as Outcome;
      const n = Math.min(p.q, p.sh + p.yld);
      p.q = 0;
      if (n > 0) {
        sum += sellShares(e, o, p, n);
        done += n;
      }
      if (p.sh + p.yld < 1e-6) M.pos = M.pos.filter((x) => x !== p);
    });
    if (done) msg = `Queued sell completed: ${shf(done)} shares for ${usdS(sum)}`;
  }
  bump();
  return msg;
}
/** Cancel a queued sell (shares stay in the vault, earning). */
export function cancelQueued(id: string): string | null {
  const p = M.pos.find((i) => i.id === id);
  if (!p || !p.q) return null;
  const n = p.q;
  p.q = 0;
  const e = EVM(p.ev) as PredictEvent;
  bump();
  return `Queued sell cancelled: ${shf(n)} ${lab(OUT(e, p.o) as Outcome, p.side)} stay in the vault, earning`;
}
/** "Earn on them": deposit wallet-held World tokens into the vault (sample). */
export function impEarn(ids: string[]): string | null {
  const xs = M.imp.filter((x) => ids.includes(x.id) && !x.done && x.src === "wallet");
  if (!xs.length) return null;
  let v = 0;
  xs.forEach((x) => {
    const e = EVM(x.ev) as PredictEvent;
    const o = OUT(e, x.o) as Outcome;
    v += impx(x).value;
    o.pool[x.side] += x.sh;
    const p: Pos = { id: `pp${++M.seq}`, ev: e.id, o: o.k, side: x.side, sh: x.sh, avg: x.avg, yld: 0, t: TODAY_LABEL, src: "wallet", mergeAt: Date.now() + MERGE_MS };
    M.pos.push(p);
    x.done = true;
    x.pos = p.id;
  });
  syncPool();
  bump();
  scheduleMerge();
  return `Preview: ${xs.length} position${xs.length > 1 ? "s" : ""} (${usdS(v)}) deposited. Matched pairs start earning in the Earn pool`;
}
/** Link a Polymarket account (sample, read-only). */
export function pmLinkSet(link: { addr: string; how: "wallet" | "address" } | null) {
  M.pm = link;
  bump();
}
/** Finish a Polymarket → Vanna move (sample): adds the bought shares to the vault. */
export function finishMove(id: string, q: MoveQuote): string | null {
  const x = M.imp.find((i) => i.id === id);
  if (!x || x.done) return null;
  const e = EVM(x.ev) as PredictEvent;
  const o = OUT(e, x.o) as Outcome;
  o.pool[x.side] += q.after;
  o.vol += q.cash;
  e.vol += q.cash;
  const p: Pos = { id: `pp${++M.seq}`, ev: e.id, o: o.k, side: x.side, sh: q.after, avg: q.buyAvg / 100, yld: 0, t: TODAY_LABEL, src: "polymarket", mergeAt: Date.now() + MERGE_MS };
  M.pos.push(p);
  x.done = true;
  x.pos = p.id;
  x.after = q.after;
  syncPool();
  bump();
  scheduleMerge();
  return `Preview: moved ${shf(q.after)} ${lab(o, x.side)} into Vanna's vault`;
}

// Tiny local formatters (the shared ones live in components/v3/format.ts; lib/ must not import components).
const shf = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2, maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
const usdS = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------------------------
// PredictAPI (what Portfolio reads)
// ---------------------------------------------------------------------------------------------

/** Sample summary of the account's predictions (design `summary()`). */
export function predictSummary(): PredictSummary {
  const xs = M.pos.map(pmx);
  const sum = (f: (m: Pmx) => number) => xs.reduce((t, m) => t + f(m), 0);
  const value = sum((m) => m.value);
  const cost = sum((m) => m.cost);
  return {
    value, cost, pnl: value - cost, inVault: sum((m) => m.inVault), earned: sum((m) => m.earned), apy: yourApy(xs),
    payout: maxPayout(), count: xs.length, perMonth: sum((m) => (m.value * m.apy) / 100 / 12),
  };
}
/** Sample positions (design `positions()`). `matched` is 0–100. */
export function predictPositions(): PredictPosition[] {
  return M.pos.map((p) => {
    const m = pmx(p);
    return {
      id: p.id, eventId: p.ev, marketId: p.o, event: m.e.title, market: m.e.outs.length > 1 ? m.o.name : m.e.title, outcome: m.o.name, side: p.side,
      label: lab(m.o, p.side), shares: m.tot, yieldShares: p.yld, queued: p.q || 0, avg: p.avg, mark: m.mk, value: m.value, cost: m.cost, pnl: m.pnl,
      inVault: m.inVault, matched: m.sd.share * 100, earned: m.earned, apy: m.apy, pays: m.pays, merging: m.merging, src: p.src, since: p.t,
    };
  });
}
/** Sample USDC-vault figures (design `vault()`). */
export function predictVault(): PredictVault {
  const pairs = totalPairs();
  const sup = M.usdc.sup;
  return { deposited: pairs, earned: VAULT_EARNED, apy: RATE(), pairs, share: sup ? (pairs / sup) * 100 : 0, events: M.EV.length };
}
/** Sample importable positions (wallet / linked Polymarket) (design `importable()`). */
export function predictImportable(): PredictImportable[] {
  return M.imp
    .filter((x) => !x.done && (x.src === "wallet" || M.pm))
    .map((x) => {
      const m = impx(x);
      return { id: x.id, source: x.src, event: m.event, market: m.market || m.event, side: x.side, label: m.L, shares: x.sh, value: m.value, apy: m.apy, listed: !!x.ev, eventId: x.ev, marketId: x.o ?? null };
    });
}
/** Route of an event page (optionally a market and side preselected). */
export const predictHref = (eventId: string, marketId?: string, s?: Side) => `/predict/${[eventId, marketId, s].filter(Boolean).join("~")}`;

/**
 * Subscribe to the sample session: re-renders on every buy / sell / import (same session only).
 * Returns the read API so callers can compute what they show during render.
 */
export function usePredictSample() {
  const rev = usePredictStore((s) => s.rev);
  return { rev, summary: predictSummary, positions: predictPositions, vault: predictVault, importable: predictImportable, openImport: openPredictImport, href: predictHref };
}
