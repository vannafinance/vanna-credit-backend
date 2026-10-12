/**
 * GET /api/farm/funding?symbol=ETH — Phoenix mainnet funding for a basis vault's perp market:
 * the last 90 days of published hourly rates (perp-api.phoenix.trade `GET /v1/funding/{symbol}/rates`,
 * public, no key) aggregated per UTC day and annualised, plus the latest hourly rate.
 * Cached in memory for 10 minutes; an upstream failure returns 502 and the page shows the zero form.
 */
import { redactSecrets } from "@/lib/solana/server/json";
import { NextRequest, NextResponse } from "next/server";
import { fetchWithTimeout } from "@/lib/async";
import { fundingDays, type FundingResponse } from "@/lib/farm/nav-math";
import { VAULTS } from "@/lib/solana/vault-catalogue";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const API = "https://perp-api.phoenix.trade";
const TTL = 10 * 60_000;
const SYMBOLS = new Set(VAULTS.filter((v) => v.kind === "basis").map((v) => v.asset));
const cache = new Map<string, { at: number; body: FundingResponse }>();
const pending = new Map<string, Promise<FundingResponse>>();
async function load(symbol: string): Promise<FundingResponse> {
  const start = Date.now() - 90 * 86_400_000;
  const r = await fetchWithTimeout(`${API}/v1/funding/${symbol}/rates?startTime=${start}&limit=10000`, { cache: "no-store" });
  if (!r.ok) throw new Error(`Phoenix funding failed (${r.status})`);
  const body = (await r.json()) as { rates?: { timestamp: number | string; fundingRatePercentage: string }[] };
  const rates = (body.rates ?? [])
    .map((p) => {
      const t = typeof p.timestamp === "number" ? p.timestamp : Date.parse(p.timestamp) / 1000;
      return { at: t < 1e12 ? t * 1000 : t, pct: Number(p.fundingRatePercentage) };
    })
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.pct))
    .sort((a, b) => a.at - b.at);
  const last = rates.at(-1);
  return { symbol, lastHourlyPct: last?.pct ?? null, lastAt: last?.at ?? null, days: fundingDays(rates) };
}
export async function GET(request: NextRequest) {
  const symbol = (request.nextUrl.searchParams.get("symbol") ?? "").toUpperCase();
  if (!SYMBOLS.has(symbol))
    return NextResponse.json({ error: "Unknown market" }, { status: 404 });
  const saved = cache.get(symbol);
  if (saved && Date.now() - saved.at < TTL) return NextResponse.json(saved.body);
  let running = pending.get(symbol);
  if (!running) {
    running = load(symbol).finally(() => pending.delete(symbol));
    pending.set(symbol, running);
  }
  try {
    const body = await running;
    cache.set(symbol, { at: Date.now(), body });
    return NextResponse.json(body);
  } catch (e) {
    if (saved) return NextResponse.json(saved.body);
    return NextResponse.json({ error: e instanceof Error ? redactSecrets(e.message) : "Funding unavailable" }, { status: 502 });
  }
}
