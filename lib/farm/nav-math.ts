/**
 * Pure share-price / funding maths for the Farm vault pages (client- and server-safe; no storage).
 *
 * Every figure is derived from REAL observations only: the hourly share-price points recorded by
 * lib/farm/nav-history.ts and Phoenix's published hourly funding rates (GET /api/farm/funding).
 * When the history is too short for a figure, the function returns null and the UI renders the
 * unavailable state — nothing is extrapolated or sampled.
 */

export interface NavPoint {
  /** Unix ms. */
  at: number;
  /** USD per share. */
  price: number;
}

/** One UTC day of a series: the day's UTC-midnight timestamp and its value. */
export interface DayPoint {
  at: number;
  value: number;
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** Hours in a year: annualises an hourly funding percentage. */
export const HOURS_PER_YEAR = 24 * 365;

/**
 * Annualised share-price return over the last `days`, from the newest observation at or before the
 * target time (and no more than two hours older than it). Null when no such observation exists.
 */
export function historicalApy(points: NavPoint[], current: NavPoint, days: number): number | null {
  const target = current.at - days * DAY;
  const prior = [...points].reverse().find((p) => p.at <= target && target - p.at <= 2 * HOUR);
  if (!prior || prior.price <= 0 || current.price <= 0) return null;
  const result = (Math.pow(current.price / prior.price, (365 * DAY) / (current.at - prior.at)) - 1) * 100;
  return Number.isFinite(result) ? result : null;
}

/** The last observation of each UTC day, oldest first (the share-price chart's daily samples). */
export function dailySamples(points: NavPoint[]): DayPoint[] {
  const byDay = new Map<number, DayPoint>();
  for (const p of [...points].sort((a, b) => a.at - b.at)) {
    if (!(p.price > 0)) continue;
    const day = Math.floor(p.at / DAY) * DAY;
    byDay.set(day, { at: day, value: p.price });
  }
  return [...byDay.values()];
}

/** Day-over-day annualised vault APY (%) from daily share-price samples; one point fewer than the input. */
export function dailyApy(days: DayPoint[]): DayPoint[] {
  const out: DayPoint[] = [];
  for (let i = 1; i < days.length; i++) {
    const span = (days[i].at - days[i - 1].at) / DAY;
    const r = days[i].value / days[i - 1].value;
    const apy = (Math.pow(r, 365 / span) - 1) * 100;
    if (Number.isFinite(apy)) out.push({ at: days[i].at, value: apy });
  }
  return out;
}

export interface NavStats {
  /** Annualised over the last 90 days (null below 90 days of history). */
  apy90: number | null;
  /** Annualised since the first recorded observation (null below one day of history). */
  sinceLaunch: number | null;
  /** Share-price change since the first recorded observation, % (null below one day). */
  roi: number | null;
  /** Mean daily return / its standard deviation × √365 (null below 3 daily returns or zero variance). */
  sharpe: number | null;
  /** Largest fall from a previous high, % (≤ 0; null without at least two observations). */
  maxDrawdown: number | null;
  /** First recorded observation, unix ms (null when nothing is recorded). */
  firstAt: number | null;
}

export function navStats(points: NavPoint[]): NavStats {
  const sorted = [...points].filter((p) => p.price > 0).sort((a, b) => a.at - b.at);
  const empty: NavStats = { apy90: null, sinceLaunch: null, roi: null, sharpe: null, maxDrawdown: null, firstAt: sorted[0]?.at ?? null };
  if (sorted.length < 2) return empty;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last.at - first.at;
  let peak = first.price;
  let mdd = 0;
  for (const p of sorted) {
    peak = Math.max(peak, p.price);
    mdd = Math.min(mdd, p.price / peak - 1);
  }
  const days = dailySamples(sorted);
  const rets = days.slice(1).map((d, i) => d.value / days[i].value - 1);
  let sharpe: number | null = null;
  if (rets.length >= 3) {
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length);
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : null;
  }
  const enough = span >= DAY;
  const since = enough ? (Math.pow(last.price / first.price, (365 * DAY) / span) - 1) * 100 : null;
  return {
    apy90: historicalApy(sorted, last, 90),
    sinceLaunch: since !== null && Number.isFinite(since) ? since : null,
    roi: enough ? (last.price / first.price - 1) * 100 : null,
    sharpe,
    maxDrawdown: mdd * 100,
    firstAt: first.at,
  };
}

/** One UTC day of Phoenix funding: the hours-weighted mean hourly rate, annualised (%). */
export interface FundingDay {
  at: number;
  apr: number;
  hours: number;
}

/** Daily annualised funding from Phoenix's hourly rates (`pct` is the hourly percentage). */
export function fundingDays(rates: { at: number; pct: number }[]): FundingDay[] {
  const byDay = new Map<number, { sum: number; hours: number }>();
  for (const r of rates) {
    if (!Number.isFinite(r.pct)) continue;
    const day = Math.floor(r.at / DAY) * DAY;
    const d = byDay.get(day) ?? { sum: 0, hours: 0 };
    d.sum += r.pct;
    d.hours += 1;
    byDay.set(day, d);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, d]) => ({ at, apr: (d.sum / d.hours) * HOURS_PER_YEAR, hours: d.hours }));
}

/** GET /api/farm/funding payload. */
export interface FundingResponse {
  symbol: string;
  /** Latest published hourly funding rate, percent (positive: longs pay shorts). */
  lastHourlyPct: number | null;
  /** Unix ms of that rate. */
  lastAt: number | null;
  days: FundingDay[];
}

export interface FundingStats {
  /** Hours-weighted mean annualised funding over the last 7 / 30 days (null without data). */
  avg7: number | null;
  avg30: number | null;
  /** Days (of the last 30 with data) whose funding was negative, and how many days had data. */
  negativeDays30: number;
  days30: number;
}

export function fundingStats(days: FundingDay[]): FundingStats {
  const avg = (rows: FundingDay[]) => {
    const h = rows.reduce((s, d) => s + d.hours, 0);
    return h ? rows.reduce((s, d) => s + d.apr * d.hours, 0) / h : null;
  };
  const last30 = days.slice(-30);
  return {
    avg7: avg(days.slice(-7)),
    avg30: avg(last30),
    negativeDays30: last30.filter((d) => d.apr < 0).length,
    days30: last30.length,
  };
}

/**
 * Price rise (%) that would take a vault's short to Phoenix's maintenance margin, from Phoenix's own
 * margin view: the short loses `shortUsd × x` while maintenance grows with the notional, so
 * x = (effective − maintenance) ÷ (short + maintenance). Conservative for a vault whose collateral is
 * the shorted asset itself (it ignores that collateral's gain). Null when there is no short or no view.
 */
export function shortLiquidationRise(shortUsd: number | null, effectiveUsd: number | null, maintenanceUsd: number | null): number | null {
  if (!shortUsd || shortUsd <= 0 || effectiveUsd === null || maintenanceUsd === null) return null;
  const x = ((effectiveUsd - maintenanceUsd) / (shortUsd + maintenanceUsd)) * 100;
  return Number.isFinite(x) ? Math.max(0, x) : null;
}

/** One Perena product's published figures (Perena's public API, mainnet); null when unavailable. */
export interface PerenaProduct {
  /** 7-day APY, %. */
  apy7: number | null;
  holders: number | null;
  /** Live share price on mainnet, USD. */
  price: number | null;
}

/** GET /api/farm/perena payload. */
export interface PerenaMarket {
  usdstar: PerenaProduct;
  junior: PerenaProduct;
  /** Unix ms of the read. */
  at: number;
}
