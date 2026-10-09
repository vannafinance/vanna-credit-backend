import { jsonResponse } from "@/lib/solana/server/json";
import { readProtocol } from "@/lib/analytics/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/analytics/protocol — lending pools and oracle prices (with freshness), shared for 10 s server-side. */
export async function GET() {
  try {
    return jsonResponse(await readProtocol());
  } catch {
    return jsonResponse({ error: "Protocol read failed" }, { status: 502 });
  }
}
