/**
 * GET /api/farm/perena — Perena's own published product figures for USD* and USD* Junior (mainnet),
 * from Perena's public API (api.perena.org, no key; the same source as app.perena.org/earn):
 * 7-day APY, holder count and live share price. Cached in memory for 5 minutes; each figure is null
 * when Perena's API fails, and the pages render that as the zero form. TVL is NOT taken from here:
 * the Vanna pages use the fork's on-chain NAV.
 */
import { NextResponse } from "next/server";
import { fetchWithTimeout } from "@/lib/async";
import type { PerenaMarket, PerenaProduct } from "@/lib/farm/nav-math";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const API = "https://api.perena.org/api";
const TTL = 5 * 60_000;
let cache: { at: number; body: PerenaMarket } | null = null;
let pending: Promise<PerenaMarket> | null = null;
async function get(path: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetchWithTimeout(`${API}/${path}`, { headers: { Origin: "https://app.perena.org" }, cache: "no-store" });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : null);
async function product(key: "usdstar" | "usdstarJunior"): Promise<PerenaProduct> {
  const [apy, holders, price] = await Promise.all([get(`${key}/apy`), get(`${key}/holders`), get(`${key}/price`)]);
  return { apy7: num(apy?.apy), holders: num(holders?.holders), price: num(price?.price) };
}
async function load(): Promise<PerenaMarket> {
  const [usdstar, junior] = await Promise.all([product("usdstar"), product("usdstarJunior")]);
  return { usdstar, junior, at: Date.now() };
}
export async function GET() {
  if (cache && Date.now() - cache.at < TTL) return NextResponse.json(cache.body);
  pending ??= load().finally(() => (pending = null));
  const body = await pending;
  const ok = [body.usdstar, body.junior].some((p) => p.apy7 !== null || p.holders !== null || p.price !== null);
  // Keep the last good read rather than replacing it with a failed one.
  if (ok || !cache) cache = { at: ok ? Date.now() : 0, body };
  return NextResponse.json(ok ? body : cache.body);
}
