/**
 * Farm service — single-asset Kamino Lend vaults, farmed from the margin account.
 *
 * Supplying goes through `margin_execute` (lib/solana/exec.ts `farmDeposit` / `farmWithdraw`): the
 * margin account supplies an asset (optionally borrowed from Vanna for leverage) to a Kamino main-
 * market reserve, and the cToken it gets back stays in the margin account as collateral, valued at
 * the reserve's exchange rate (it counts toward the account's health factor).
 *
 * Multi-asset LP (Kamino Liquidity strategies) is intentionally not offered: that program rejects
 * CPI, so a margin account can never hold its shares.
 */
import { PublicKey } from "@solana/web3.js";
import { KAMINO_RECEIPTS, receiptByMint, type KaminoReceipt } from "./kamino";
import { fetchMarginSnapshot, type MarginSnapshot } from "./margin";
import { getToken } from "./tokens";

export interface FarmPool {
  /** URL slug = lower-case underlying symbol ("jitosol"). */
  id: string;
  /** Registry symbol of the underlying. */
  symbol: string;
  receiptSymbol: string;
  protocol: "Kamino";
  reserve: string;
  /** Kamino main-market figures (mainnet, via Kamino's API); null when unavailable. */
  supplyApy: number | null;
  borrowApy: number | null;
  totalSupply: number | null;
  totalBorrow: number | null;
  totalSupplyUsd: number | null;
  totalBorrowUsd: number | null;
  utilization: number | null;
}

export interface FarmPosition {
  poolId: string;
  symbol: string;
  receiptSymbol: string;
  /** cTokens held by the margin account (UI units, 6 decimals). */
  receipts: number;
  /** Underlying currently redeemable for them, at the reserve's exchange rate (UI units). */
  underlying: number;
  /** USD value exactly as the program values it for the health factor. */
  liquidityUsd: number;
}

let apiBase = "";
/** Scripts set an absolute origin for the app's API routes; the browser uses "". */
export function setFarmApiBase(base: string) {
  apiBase = base.replace(/\/$/, "");
}

export const poolIdOf = (r: KaminoReceipt) => r.underlying.toLowerCase();

/** Every single-asset vault with live Kamino metrics (GET /api/farm/pools). */
export async function listFarmPools(): Promise<FarmPool[]> {
  const res = await fetch(`${apiBase}/api/farm/pools`, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `farm pools failed (${res.status})`);
  return body.pools as FarmPool[];
}

/** Farm positions from an already-loaded margin snapshot (no extra RPC). */
export function farmPositionsFromSnapshot(snapshot: MarginSnapshot): FarmPosition[] {
  const out: FarmPosition[] = [];
  for (const c of snapshot.collateral) {
    const r = receiptByMint(c.mint);
    if (!r || c.amountRaw === 0n) continue;
    const price = snapshot.prices[r.underlying];
    const usdPerUnderlying = price && price.price > 0n ? Number(price.price) * 10 ** price.exponent : 0;
    out.push({
      poolId: poolIdOf(r),
      symbol: r.underlying,
      receiptSymbol: r.symbol,
      receipts: c.amount,
      underlying: usdPerUnderlying > 0 ? c.usd / usdPerUnderlying : 0,
      liquidityUsd: c.usd,
    });
  }
  return out;
}

/** The wallet's farm positions (the margin account's Kamino cTokens). */
export async function fetchFarmPositions(owner: string): Promise<FarmPosition[]> {
  const snapshot = await fetchMarginSnapshot(new PublicKey(owner));
  return snapshot.exists ? farmPositionsFromSnapshot(snapshot) : [];
}

// The Farm listing lives with the receipt catalogue (kamino.ts) so server code can read it without this module's
// wallet and transaction imports.
export { FARM_DELISTED_UNDERLYINGS, isFarmListed } from "./kamino";

/** Static catalogue (used before metrics load, and by the server route). */
export const FARM_CATALOGUE: readonly Pick<FarmPool, "id" | "symbol" | "receiptSymbol" | "protocol" | "reserve">[] = KAMINO_RECEIPTS.filter(
  (r) => Boolean(getToken(r.underlying)),
).map((r) => ({ id: poolIdOf(r), symbol: r.underlying, receiptSymbol: r.symbol, protocol: "Kamino" as const, reserve: r.reserve.toBase58() }));
