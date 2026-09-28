import { jsonResponse } from "@/lib/solana/server/json";
import { FARM_CATALOGUE, type FarmPool } from "@/lib/solana/farm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KAMINO_MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const METRICS_URL = `https://api.kamino.finance/kamino-market/${KAMINO_MAIN_MARKET}/reserves/metrics?env=mainnet-beta`;
const CACHE_MS = 60_000;

interface KaminoReserveMetrics {
  reserve: string;
  supplyApy: string;
  borrowApy: string;
  totalSupply: string;
  totalBorrow: string;
  totalSupplyUsd: string;
  totalBorrowUsd: string;
}

let cache: { at: number; byReserve: Map<string, KaminoReserveMetrics> } | null = null;

async function metrics(): Promise<Map<string, KaminoReserveMetrics>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.byReserve;
  const res = await fetch(METRICS_URL, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Kamino metrics ${res.status}`);
  const rows = (await res.json()) as KaminoReserveMetrics[];
  cache = { at: Date.now(), byReserve: new Map(rows.map((r) => [r.reserve, r])) };
  return cache.byReserve;
}

const num = (v: string | undefined): number | null => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * GET /api/farm/pools — the Farm page's single-asset Kamino vaults with Kamino's own live
 * main-market metrics (supply/borrow APY, totals). These are MAINNET Kamino figures — the fork's
 * clone of each reserve is what deposits actually go into. When Kamino's API is unreachable the
 * pools are still listed with every metric null (rendered "—"), never guessed.
 */
export async function GET() {
  let byReserve = new Map<string, KaminoReserveMetrics>();
  let metricsError: string | null = null;
  try {
    byReserve = await metrics();
  } catch (error) {
    metricsError = error instanceof Error ? error.message : "Kamino metrics unavailable";
  }
  const pools: FarmPool[] = FARM_CATALOGUE.map((p) => {
    const m = byReserve.get(p.reserve);
    const supplyUsd = num(m?.totalSupplyUsd);
    const borrowUsd = num(m?.totalBorrowUsd);
    return {
      ...p,
      supplyApy: num(m?.supplyApy),
      borrowApy: num(m?.borrowApy),
      totalSupply: num(m?.totalSupply),
      totalBorrow: num(m?.totalBorrow),
      totalSupplyUsd: supplyUsd,
      totalBorrowUsd: borrowUsd,
      utilization: supplyUsd && borrowUsd !== null && supplyUsd > 0 ? borrowUsd / supplyUsd : null,
    };
  });
  return jsonResponse({ pools, metricsError }, { headers: { "Cache-Control": "s-maxage=30" } });
}
