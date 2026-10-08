/**
 * History series for the Earn charts (Overall Deposit, Net Earnings, My Supply), rebuilt from the
 * wallet's on-chain `lender_supply` / `lender_redeem` events (lib/solana/history.ts via
 * useEarnTransactions) plus today's live position — never from browser storage.
 *
 * Every event carries both the underlying amount and the shares minted / burned, so it pins the
 * pool's real exchange rate (underlying per share) at that moment. Between two known points (the
 * events, and "now" = the pool's projected exchange rate) the rate is interpolated linearly —
 * interest accrues continuously, so this is the only estimated part. At any time t:
 *   value(t)  = shares held(t) × exchange rate(t)
 *   earned(t) = value(t) − net principal(t)       (Σ supplied − Σ redeemed so far)
 * The last point is the exact live position, so every chart ends on the headline figure. USD uses
 * today's oracle price (as the headline does).
 *
 * An asset is only reconstructed when its history provably covers the position
 * (computeEarnedInterest's `netDeposited !== null`: net event shares == shares held). Otherwise the
 * caller falls back to the live value only — a past curve is never invented.
 */
import type { EarnHistoryRow, EarnedInterest } from "@/lib/solana/history";

export const HOUR = 36e5;
export const DAY = 864e5;
/** Chart ranges (design TFS). */
export const TFS = ["1 Week", "1 Month", "3 Months", "All Time"] as const;
export type Tf = (typeof TFS)[number];

export interface SeriesPoint {
  t: number;
  v: number;
}

/** One asset's reconstructed timeline. */
interface AssetLine {
  sym: string;
  decimals: number;
  price: number;
  /** Ascending events: [time, signed shares (UI), signed principal (UI), exchange rate]. */
  ev: Array<{ t: number; ds: number; dp: number; xr: number | null }>;
  /** Live value now (UI units of the underlying). */
  liveAssets: number;
  /** Pool exchange rate now. */
  xrNow: number;
}

/** Inputs shared by the list and pool pages. */
export interface SeriesInput {
  rows: EarnHistoryRow[];
  earned: Record<string, EarnedInterest> | null;
  /** Live positions (UI units) per symbol. */
  positions: Record<string, { assets: number }>;
  /** Pool exchange rate per symbol (underlying per share). */
  xr: Record<string, number>;
  prices: Record<string, number>;
  decimals: Record<string, number>;
}

/** Result of a build: the points, or why the past can't be drawn. */
export interface SeriesResult {
  pts: SeriesPoint[];
  /** True when every asset with a position / history was reconstructed. */
  complete: boolean;
  /** Assets left out (history doesn't cover them, or no oracle price). */
  excluded: string[];
}

const toUi = (raw: bigint, dec: number) => Number(raw) / 10 ** dec;

function lineFor(sym: string, inp: SeriesInput): AssetLine {
  const dec = inp.decimals[sym] ?? 6;
  const ev = inp.rows
    .filter((r) => r.symbol === sym && r.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((r) => {
      const sign = r.type === "supply" ? 1 : -1;
      const xr = r.sharesRaw > 0n ? Number(r.amountRaw) / Number(r.sharesRaw) : null;
      return { t: r.timestamp, ds: sign * toUi(r.sharesRaw, dec), dp: sign * toUi(r.amountRaw, dec), xr };
    });
  return { sym, decimals: dec, price: inp.prices[sym] ?? 0, ev, liveAssets: inp.positions[sym]?.assets ?? 0, xrNow: inp.xr[sym] ?? 1 };
}

/** Exchange rate at t: linear between the known points (events, then now). */
function xrAt(line: AssetLine, t: number, now: number): number {
  const known = line.ev.filter((e) => e.xr !== null).map((e) => ({ t: e.t, x: e.xr as number }));
  known.push({ t: now, x: line.xrNow });
  if (t <= known[0].t) return known[0].x;
  for (let i = 1; i < known.length; i++) {
    const a = known[i - 1];
    const b = known[i];
    if (t <= b.t) return b.t === a.t ? b.x : a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t);
  }
  return line.xrNow;
}

/** Value (UI units) and earned (UI units) of one asset at t. */
function at(line: AssetLine, t: number, now: number): { value: number; earned: number } {
  let shares = 0;
  let principal = 0;
  for (const e of line.ev) {
    if (e.t > t) break;
    shares += e.ds;
    principal += e.dp;
  }
  const value = t >= now ? line.liveAssets : Math.max(0, shares) * xrAt(line, t, now);
  return { value, earned: value - principal };
}

/** Time grid for a range (the design's `grid()`): 6 h steps for a week, daily otherwise, 50 steps for All Time. */
export function grid(tf: Tf, first: number | null, now: number): number[] {
  const pts: number[] = [];
  if (tf === "All Time") {
    const s = first !== null ? Math.min(first, now - HOUR) : now - DAY;
    const step = Math.max(HOUR, (now - s) / 50);
    for (let t = s; t < now - step / 2; t += step) pts.push(t);
    pts.push(now);
    return pts;
  }
  const d = new Date(now);
  if (tf === "1 Week") d.setDate(d.getDate() - 7);
  else d.setMonth(d.getMonth() - (tf === "1 Month" ? 1 : 3));
  d.setHours(0, 0, 0, 0);
  const step = tf === "1 Week" ? 6 * HOUR : DAY;
  for (let t = d.getTime(); t < now - step / 2; t += step) pts.push(t);
  pts.push(now);
  return pts;
}

/**
 * Build the value ("dep") or earned-interest ("net") series in USD for `syms`.
 * `now` should be ≥ the newest event (the fork clock can run ahead of the browser's).
 */
export function buildSeries(kind: "dep" | "net", tf: Tf, syms: readonly string[], inp: SeriesInput, now: number): SeriesResult {
  const excluded: string[] = [];
  const lines: AssetLine[] = [];
  for (const sym of syms) {
    const line = lineFor(sym, inp);
    const involved = line.ev.length > 0 || line.liveAssets > 0;
    if (!involved) continue;
    const provable = inp.earned?.[sym]?.netDeposited !== null && inp.earned?.[sym] !== undefined;
    if (!provable || !(line.price > 0)) {
      excluded.push(sym);
      continue;
    }
    lines.push(line);
  }
  const firsts = lines.flatMap((l) => (l.ev.length ? [l.ev[0].t] : []));
  const first = firsts.length ? Math.min(...firsts) : null;
  const pts = grid(tf, first, now).map((t) => ({
    t,
    v: lines.reduce((s, l) => {
      const r = at(l, t, now);
      return s + (kind === "dep" ? r.value : r.earned) * l.price;
    }, 0),
  }));
  return { pts, complete: excluded.length === 0, excluded };
}

/** A flat line at the live value across the range (used when the past can't be reconstructed). */
export function flatSeries(tf: Tf, value: number, now: number): SeriesPoint[] {
  const g = grid(tf, null, now);
  return [{ t: g[0], v: value }, { t: now, v: value }];
}
