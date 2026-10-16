import { fetchPoolStates, serializePoolState } from "@/lib/solana/protocol-state";
import { jsonResponse } from "@/lib/solana/server/json";
import { wantsFresh } from "@/lib/fresh-reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/pools — every registry lending pool, read from its on-chain Reserve, accrued to fork-now. */
export async function GET(request: Request) {
  try {
    const pools = await fetchPoolStates(undefined, { publicState: wantsFresh(request) ? "fresh" : "cached" });
    return jsonResponse({ pools: Object.fromEntries(Object.entries(pools).map(([k, p]) => [k, serializePoolState(p)])) });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "pool read failed" }, { status: 502 });
  }
}
