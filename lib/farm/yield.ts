/** Keep unavailable yield distinct from a measured zero, and APR distinct from APY. */
import { DAY, type NavPoint } from './nav-math';

export function eventApy(points: NavPoint[], current: NavPoint, days: number) {
  const prior = points.filter(p => Number.isFinite(p.price) && p.price > 0 && p.at <= current.at - days * DAY)
    .sort((a, b) => b.at - a.at)[0];
  if (!prior || !Number.isFinite(current.price) || current.price <= 0) return null;
  const value = (Math.pow(current.price / prior.price, 365 * DAY / (current.at - prior.at)) - 1) * 100;
  return Number.isFinite(value) ? { value, baselineAt: prior.at } : null;
}

/** Deposit receipt exchange rate; integer mint rounding makes this an approximation. */
export function depositPrice(valueRaw: bigint, sharesRaw: bigint): number | null {
  // Sub-share deposits can magnify mint rounding; don't use these as an APY baseline.
  if (valueRaw <= 0n || sharesRaw < 1_000_000n) return null;
  const price = Number(valueRaw) / Number(sharesRaw);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function netYield(apy: number | null | undefined, borrowApr: number | null, borrowedShare: number): number | null {
  if (apy == null || !Number.isFinite(apy) || (borrowedShare > 0 && (borrowApr === null || !Number.isFinite(borrowApr)))) return null;
  return apy - (borrowApr ?? 0) * borrowedShare;
}

export function grossFundingApr(avgApr: number | null | undefined, shortUsd: number | null | undefined, navUsd: number | null | undefined): number | null {
  if (avgApr == null || shortUsd == null || navUsd == null || !Number.isFinite(avgApr) || !Number.isFinite(shortUsd) || !Number.isFinite(navUsd) || navUsd <= 0 || shortUsd < 0) return null;
  return avgApr * shortUsd / navUsd;
}

/**
 * A yield figure as text. Not-yet-computable (too little share-price history) shows the zero form,
 * never "Unavailable" — the product rule is that the UI shows 0.00% until the day-by-day history
 * yields a real number; the calculation itself still keeps "no data" (null) apart from a measured 0.
 */
export function apyText(value: number | null | undefined, digits = 2): string {
  return `${(value == null || !Number.isFinite(value) ? 0 : value).toFixed(digits)}%`;
}

/**
 * Below this NAV a Basis vault's share-price APY is dominated by one-off costs: a single rebalance,
 * Phoenix taker fee or entry slippage moves the share price by more than days of funding would.
 */
export const LOW_TVL_USD = 10_000;

/** Days of real share-price history needed before a realized return is annualised. */
export const MIN_APY_HISTORY_DAYS = 7;

/** A Basis vault's headline APY: realized 7D when it exists, else the funding-based estimate. */
export interface VaultApy {
  value: number | null;
  /** True when `value` is the funding estimate, not a realized share-price return. */
  estimate: boolean;
  /**
   * Where it comes from: the 7-day share price (realized), or Phoenix funding (estimate). A vault
   * with under {@link MIN_APY_HISTORY_DAYS} days of history never gets an annualised since-launch figure.
   */
  source?: "7d" | "funding" | null;
  /** Phoenix's 7-day average funding APR on the vault's market, % (shown beside the vault APY). */
  fundingApr: number | null;
  /** NAV under {@link LOW_TVL_USD}: the figure is flagged "Low TVL · estimate". */
  lowTvl: boolean;
}

/**
 * Realized 7-day share-price APY when the vault has a 7-day baseline; otherwise the estimate from
 * what a basis vault actually earns: the last 7 days of Phoenix mainnet funding (real, hourly) on
 * the share of NAV held short (`grossFundingApr`). Before fees and execution, so it is labelled.
 *
 * A since-launch return is deliberately NOT annualised here: a few days of history (one rebalance
 * cost on a small NAV) turn a −1.7% move into a −75% "APY". Show it raw with
 * {@link sinceLaunchLabel} instead.
 */
export function vaultApy(
  realized: number | null | undefined,
  fundingAvg7: number | null | undefined,
  shortUsd: number | null | undefined,
  navUsd: number | null | undefined,
): VaultApy {
  const fundingApr = fundingAvg7 != null && Number.isFinite(fundingAvg7) ? fundingAvg7 : null;
  const lowTvl = navUsd != null && Number.isFinite(navUsd) && navUsd < LOW_TVL_USD;
  if (realized != null && Number.isFinite(realized)) return { value: realized, estimate: false, source: "7d", fundingApr, lowTvl };
  const est = grossFundingApr(fundingAvg7, shortUsd, navUsd);
  return { value: est, estimate: est !== null, source: est !== null ? "funding" : null, fundingApr, lowTvl };
}

/** Signed percent with a real minus sign, e.g. "+0.42%" / "−1.70%". */
const signedPct = (v: number, digits = 2) => `${v < 0 ? "\u2212" : "+"}${Math.abs(v).toFixed(digits)}%`;

/** "4 days" / "1 day" / "under 1 day" for an elapsed history length. */
export function daysText(days: number): string {
  if (!(days >= 1)) return "under 1 day";
  const d = Math.floor(days);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * The raw (un-annualised) share-price return since launch, e.g. "Since launch −1.70% · 4 days";
 * null without a return or launch time.
 */
export function sinceLaunchLabel(returnPct: number | null | undefined, days: number | null | undefined): string | null {
  if (returnPct == null || !Number.isFinite(returnPct) || days == null || !Number.isFinite(days)) return null;
  return `Since launch ${signedPct(returnPct)} · ${daysText(days)}`;
}
