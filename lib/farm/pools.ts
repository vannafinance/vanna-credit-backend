/**
 * Farm pool catalogue — THE one config file for what the Farm pages list: one single-asset
 * Kamino Lend vault per Kamino receipt (lib/solana/kamino.ts `KAMINO_RECEIPTS`), with live metrics
 * from `GET /api/farm/pools` once loaded. Metrics are `null` (rendered as zero) until then or when
 * Kamino's API is unreachable — never a made-up TVL / APY.
 *
 * No LP / multi-asset pools: Kamino Liquidity strategies reject CPI, so a margin account can't
 * hold them.
 */
import { FARM_CATALOGUE, type FarmPool } from "@/lib/solana/farm";

export type FarmPoolConfig = FarmPool;

/** Catalogue entries with every metric null — shown while `/api/farm/pools` loads. */
export const FARM_POOLS_PLACEHOLDER: FarmPoolConfig[] = FARM_CATALOGUE.map((p) => ({
  ...p,
  supplyApy: null,
  borrowApy: null,
  totalSupply: null,
  totalBorrow: null,
  totalSupplyUsd: null,
  totalBorrowUsd: null,
  utilization: null,
}));

/** Display name: the underlying symbol. */
export function poolTitle(pool: FarmPoolConfig): string {
  return pool.symbol;
}

/** Zero ("0.00%" / "$0.00") for any metric that isn't available. */
export function formatMetric(value: number | null, kind: "usd" | "pct"): string {
  if (value === null || !Number.isFinite(value)) value = 0;
  if (kind === "pct") return `${(value * 100).toFixed(2)}%`;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact token amount ("716.50K JitoSOL"); "0.00 <symbol>" when unknown. */
export function formatTokenMetric(value: number | null, symbol: string): string {
  if (value === null || !Number.isFinite(value)) value = 0;
  const abs = Math.abs(value);
  const text =
    abs >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : abs >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : abs >= 1e3 ? `${(value / 1e3).toFixed(2)}K` : value.toFixed(2);
  return `${text} ${symbol}`;
}
