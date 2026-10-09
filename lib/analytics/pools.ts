/**
 * Pure derivations over the protocol read (pools + prices). A pool is valued in USD only when its
 * asset price is fresh and the pool and price were read on the same fork clock; otherwise its USD
 * figures are null — never zero, never a reference price — and totals say which pools they exclude.
 */
import { LENDING_TOKENS } from "@/lib/solana/tokens";
import type { ProtocolOverview } from "./server/store";
import { finite } from "./format";

export interface PoolRow {
  symbol: string;
  name: string;
  pool: ProtocolOverview["pools"][string];
  price: ProtocolOverview["prices"][string] | null;
  /** True when USD values can be shown for this pool. */
  valued: boolean;
  usdSupplied: number | null;
  usdBorrowed: number | null;
  usdCash: number | null;
}

export interface PoolTotals {
  supplied: number;
  borrowed: number;
  cash: number;
  ratio: number | null;
  partial: boolean;
  excluded: string[];
  maxUtilization: number | null;
  maxUtilizationSymbol: string | null;
  /** Debt-weighted borrow APR / supply-weighted supply APR across the valued pools. */
  borrowApr: number | null;
  supplyApr: number | null;
}

export function poolRows(p: ProtocolOverview | undefined): PoolRow[] {
  if (!p) return [];
  return LENDING_TOKENS.map((t) => ({ t, pool: p.pools[t.symbol] }))
    .filter((x) => x.pool?.initialised)
    .map(({ t, pool }) => {
      const price = p.prices[t.symbol] ?? null;
      const valued = !!price && finite(price.usd) && price.usd > 0 && !price.stale && Math.abs(p.forkTime - pool.forkTimestamp) <= 10;
      const v = (n: number) => (valued && price?.usd ? n * price.usd : null);
      return { symbol: t.symbol, name: t.name, pool, price, valued, usdSupplied: v(pool.totalSupplied), usdBorrowed: v(pool.totalBorrowed), usdCash: v(pool.availableLiquidity) };
    });
}

export function poolTotals(rows: PoolRow[]): PoolTotals | null {
  const valued = rows.filter((r) => r.valued);
  if (!valued.length) return null;
  const supplied = valued.reduce((s, r) => s + (r.usdSupplied ?? 0), 0);
  const borrowed = valued.reduce((s, r) => s + (r.usdBorrowed ?? 0), 0);
  const cash = valued.reduce((s, r) => s + (r.usdCash ?? 0), 0);
  const top = [...rows].sort((a, b) => b.pool.utilization - a.pool.utilization)[0];
  return {
    supplied, borrowed, cash,
    ratio: supplied > 0 ? borrowed / supplied : null,
    partial: valued.length < rows.length,
    excluded: rows.filter((r) => !r.valued).map((r) => r.symbol),
    maxUtilization: top?.pool.utilization ?? null,
    maxUtilizationSymbol: top?.symbol ?? null,
    borrowApr: borrowed > 0 ? valued.reduce((a, r) => a + (r.usdBorrowed ?? 0) * r.pool.borrowApr, 0) / borrowed : null,
    supplyApr: supplied > 0 ? valued.reduce((a, r) => a + (r.usdSupplied ?? 0) * r.pool.supplyApr, 0) / supplied : null,
  };
}
