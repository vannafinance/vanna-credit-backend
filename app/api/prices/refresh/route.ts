import { refreshForkPrices } from "@/lib/solana/server/fork-prices";
import { healKaminoReserves } from "@/lib/solana/server/kamino-heal";
import { jsonResponse } from "@/lib/solana/server/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let inflight: Promise<unknown> | null = null;
let recent: { at: number; result: [unknown, unknown] } | null = null;
const MIN_REFRESH_INTERVAL_MS = 30_000;

/**
 * POST /api/prices/refresh — the fork price keeper: rewrites every registry asset's PriceUpdateV2
 * via `surfnet_setAccount` with a live Jupiter USD price, stamped with the fork clock. Also heals
 * any cloned Kamino reserve whose `last_update.slot` is ahead of the fork (see kamino-heal.ts), since
 * this runs before every risk-checked transaction. Concurrent requests share one refresh.
 */
export async function POST() {
  try {
    if (!recent || Date.now() - recent.at >= MIN_REFRESH_INTERVAL_MS) {
      // Wait for both branches to settle on failure too: no overlapping account writes.
      inflight ??= Promise.allSettled([refreshForkPrices(), healKaminoReserves()]).then((results) => {
        const failure = results.find((r) => r.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const result = results.map((r) => (r as PromiseFulfilledResult<unknown>).value) as [unknown, unknown];
        recent = { at: Date.now(), result };
        return result;
      }).finally(() => { inflight = null; });
      await inflight;
    }
    const [prices, healedReserves] = recent!.result;
    return jsonResponse({ ok: true, prices, healedReserves });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "price refresh failed" }, { status: 502 });
  }
}
