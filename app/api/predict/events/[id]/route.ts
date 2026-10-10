import { jsonResponse } from "@/lib/solana/server/json";
import { getEvent } from "@/lib/predict/events.server";
import { refreshPrices } from "@/lib/predict/prices.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const within = (p: Promise<unknown>, ms: number) => Promise.race([p.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);

/** GET /api/predict/events/:id — one event by event id or any of its market ids, freshly priced. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await within(refreshPrices(), 3000);
    const event = await getEvent(id);
    if (!event) return jsonResponse({ error: "Event not found" }, { status: 404 });
    return jsonResponse({ event });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Failed to load event" }, { status: 502 });
  }
}
