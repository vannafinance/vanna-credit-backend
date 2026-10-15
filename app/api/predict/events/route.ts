import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/solana/server/json";
import { listEvents } from "@/lib/predict/events.server";
import { refreshPrices } from "@/lib/predict/prices.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const within = (p: Promise<unknown>, ms: number) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);

/** Only the first list request on an instance waits for the price scan; later ones never block on it. */
let pricesPrimed = false;

/**
 * GET /api/predict/events?cat=sports&q=nfl — every listed World event (grouped, priced from
 * JanusFI's live on-chain quotes or else mainnet fills, with live yield-pool balances from the fork). The first call after a cold start
 * waits for the mainnet scan (~10–40 s); later calls are served from memory.
 */
export async function GET(req: NextRequest) {
  try {
    // The shared refresh runs in the background (every 20 s); the listing already carries the prices
    // of the last rebuild, so a request only waits on a cold instance, where nothing is priced yet.
    const refresh = refreshPrices().catch(() => {});
    if (!pricesPrimed) {
      await within(refresh, 4000);
      pricesPrimed = true;
    }
    let events = await listEvents();
    const cat = req.nextUrl.searchParams.get("cat");
    const q = req.nextUrl.searchParams.get("q")?.toLowerCase();
    if (cat) events = events.filter((e) => e.cat === cat);
    if (q) events = events.filter((e) => e.title.toLowerCase().includes(q) || e.tag.toLowerCase().includes(q) || e.outs.some((o) => o.name.toLowerCase().includes(q)));
    return jsonResponse({ events, updatedAt: Date.now() });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Failed to load events" }, { status: 502 });
  }
}
