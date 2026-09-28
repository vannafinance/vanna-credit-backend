import { refreshForkPrices } from "@/lib/solana/server/fork-prices";
import { healKaminoReserves } from "@/lib/solana/server/kamino-heal";
import { jsonResponse } from "@/lib/solana/server/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let inflight: Promise<unknown> | null = null;

/**
 * POST /api/prices/refresh — the fork price keeper: rewrites every registry asset's PriceUpdateV2
 * via `surfnet_setAccount` with a live Jupiter USD price, stamped with the fork clock. Also heals
 * any cloned Kamino reserve whose `last_update.slot` is ahead of the fork (see kamino-heal.ts), since
 * this runs before every risk-checked transaction. Concurrent requests share one refresh.
 */
export async function POST() {
  try {
    inflight ??= Promise.all([refreshForkPrices(), healKaminoReserves()]).finally(() => {
      inflight = null;
    });
    const [prices, healedReserves] = (await inflight) as [unknown, unknown];
    return jsonResponse({ ok: true, prices, healedReserves });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "price refresh failed" }, { status: 502 });
  }
}
