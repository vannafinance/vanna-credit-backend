import { jsonResponse } from "@/lib/solana/server/json";
import { getEvent } from "@/lib/predict/events.server";
import { refreshPrices } from "@/lib/predict/prices.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** How long an event read waits for the shared price refresh. */
const PRICE_WAIT_MS = 1_500;

const within = (p: Promise<unknown>, ms: number) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);

/** GET /api/predict/events/:id — one event by event id or any of its market ids, freshly priced. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    // The shared price refresh runs alongside the event read (a cold one waits on the catalog
    // anyway) and is waited on briefly: the first backfill takes much longer, keeps running in the
    // background, and the page's next poll (~15 s) picks up what it found.
    const event = await getEvent(id, { pricesReady: within(refreshPrices(), PRICE_WAIT_MS) });
    if (!event) return jsonResponse({ error: "Event not found" }, { status: 404 });
    return jsonResponse({ event });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Failed to load event" }, { status: 502 });
  }
}
