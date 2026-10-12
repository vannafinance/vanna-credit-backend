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

/** A Basis vault's headline APY: realized when it exists, else the funding-based estimate. */
export interface VaultApy {
  value: number | null;
  /** True when `value` is the funding estimate, not a realized share-price return. */
  estimate: boolean;
  /** Where it comes from: 7-day share price, share price since launch, or Phoenix funding. */
  source?: "7d" | "launch" | "funding" | null;
}

/**
 * Realized 7-day share-price APY when the vault has a 7-day baseline; else the realized APY since
 * launch (share price from 1.0, annualised by the second); only without either, the estimate from
 * what a basis vault actually earns — the last 7 days of Phoenix mainnet funding (real, hourly) on
 * the share of NAV held short (`grossFundingApr`). Before fees and execution, so it is labelled.
 */
export function vaultApy(
  realized: number | null | undefined,
  fundingAvg7: number | null | undefined,
  shortUsd: number | null | undefined,
  navUsd: number | null | undefined,
  sinceLaunch?: number | null,
): VaultApy {
  if (realized != null && Number.isFinite(realized)) return { value: realized, estimate: false, source: "7d" };
  // Realized by the second since launch (share price from 1.0) before 7 days of history exist.
  if (sinceLaunch != null && Number.isFinite(sinceLaunch)) return { value: sinceLaunch, estimate: false, source: "launch" };
  const est = grossFundingApr(fundingAvg7, shortUsd, navUsd);
  return { value: est, estimate: est !== null, source: est !== null ? "funding" : null };
}
