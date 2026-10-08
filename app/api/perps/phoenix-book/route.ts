import { NextRequest } from "next/server";
import { refreshPhoenixBookOnFork } from "@/lib/solana/server/perps-keeper";
import { jsonResponse } from "@/lib/solana/server/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/perps/phoenix-book { market } — FORK ONLY: re-copies a listed Phoenix market's orderbook
 * and spline from mainnet before a trade (nobody re-quotes on a fork, so its book goes stale).
 */
export async function POST(request: NextRequest) {
  let body: { market?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.market !== "string" || !/^[A-Za-z]{2,12}$/.test(body.market)) return jsonResponse({ error: "A market symbol is required" }, { status: 400 });
  try {
    return jsonResponse({ ok: true, written: await refreshPhoenixBookOnFork(body.market) });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "book refresh failed" }, { status: 502 });
  }
}
