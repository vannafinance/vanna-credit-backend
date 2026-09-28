/**
 * Small shared helpers for the Earn / Portfolio surfaces (Solana port).
 *
 * Every asset list here comes from the token registry (lib/solana/tokens.ts) — never a
 * hardcoded symbol list — and every figure is derived from on-chain data passed in by the
 * caller. Nothing here fabricates a fallback number: an unknown value is `null` and renders
 * as "—".
 */
import { findToken, TOKENS, type TokenInfo } from "@/lib/solana/tokens";
import type { EarnedInterest } from "@/lib/solana/history";

/**
 * Dust threshold (UI units): anything below this is share-rounding residue left after a full
 * withdrawal, not a real position. Applied consistently across Earn and Portfolio.
 */
export const POSITION_DUST = 1e-6;

/** Resolve a route id / store value to a registry token (case-insensitive). */
export const resolveToken = (value: string | null | undefined): TokenInfo | undefined => findToken(value ?? "");

/** Compact token amount: 1_250_000 → "1.25M", 1_250 → "1.25K", else up to `decimals` places. */
export const fmtCompact = (n: number, decimals = 4): string => {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  if (abs === 0) return "0";
  if (abs < 10 ** -decimals) return `<${(10 ** -decimals).toFixed(decimals)}`;
  return n.toFixed(decimals).replace(/\.?0+$/, "");
};

/** USD with 2 decimals; sub-cent positives render as "<$0.01" instead of a misleading "$0.00". */
export const fmtUsd = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  // Share-rounding residue (e.g. −0.000001 right after a supply) is not a real loss.
  if (n < 0 && n > -0.005) return "$0.00";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Fraction (0.052) → "5.20%". */
export const fmtPct = (fraction: number | null | undefined, decimals = 2): string =>
  fraction === null || fraction === undefined || !Number.isFinite(fraction) ? "—" : `${(fraction * 100).toFixed(decimals)}%`;

/** Short base58 address: "H37YVB...GJcGC". */
export const shortAddress = (addr: string | null | undefined): string =>
  addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "—";

/**
 * Aggregate earned interest in USD across the registry.
 *
 * Returns `{ usd, partial, unknownSymbols }`:
 * - an asset whose `earned` is null is NEVER counted as 0 — it is listed in `unknownSymbols` and
 *   makes the total `partial` (the caller must label it or show "—");
 * - `usd` is null when earned interest is unknown for every asset that has a position/history.
 *
 * (A previous Stellar bug defaulted missing history to a zero cost basis and showed 100% of the
 * deposit as yield — `computeEarnedInterest` already refuses to do that; this keeps the refusal
 * intact through the summing step.)
 */
export function sumEarnedUsd(
  earned: Record<string, EarnedInterest> | null | undefined,
  prices: Record<string, number>,
): { usd: number | null; partial: boolean; unknownSymbols: string[] } {
  if (!earned) return { usd: null, partial: true, unknownSymbols: TOKENS.map((t) => t.symbol) };
  let usd = 0;
  let known = 0;
  const unknownSymbols: string[] = [];
  for (const t of TOKENS) {
    const e = earned[t.symbol];
    if (!e) continue;
    const price = prices[t.symbol] ?? 0;
    if (e.earned === null) {
      unknownSymbols.push(t.symbol);
      continue;
    }
    if (e.earned !== 0 && !(price > 0)) {
      // Interest is known in token units but there is no oracle price to value it.
      unknownSymbols.push(t.symbol);
      continue;
    }
    usd += e.earned * price;
    known += 1;
  }
  if (known === 0 && unknownSymbols.length > 0) return { usd: null, partial: true, unknownSymbols };
  return { usd, partial: unknownSymbols.length > 0, unknownSymbols };
}
