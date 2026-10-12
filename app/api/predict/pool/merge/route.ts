import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";
import { mergeMarketAsKeeper } from "@/lib/predict/pool.server";
import type { MergeResult } from "@/lib/predict/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/predict/pool/merge { marketId } | { marketIds: [...] } — the keeper merges each pool's
 * matched YES+NO (min of the two) into CASH → USDC → Vanna's USDC reserve. Markets with nothing to
 * merge are skipped. Signed by the configured keeper, never the caller (only the keeper may land a
 * swap slightly below par). Harmless to call repeatedly.
 */
export async function POST(req: Request) {
  let body: { marketId?: unknown; marketIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }
  const ids = [...new Set([...(Array.isArray(body.marketIds) ? body.marketIds : []), ...(body.marketId ? [body.marketId] : [])])];
  if (!ids.length || ids.length > 10 || !ids.every(isPublicKeyString)) return jsonResponse({ error: "marketId or marketIds (1-10) are required" }, { status: 400 });
  const results: MergeResult[] = [];
  for (const marketId of ids as string[]) {
    try {
      const r = await mergeMarketAsKeeper(marketId);
      results.push("skipped" in r ? { marketId, skipped: r.skipped } : { marketId, signature: r.signature, merged: Number(r.merged) / 1e6 });
    } catch (error) {
      results.push({ marketId, error: error instanceof Error ? error.message : "Merge failed" });
    }
  }
  const failed = results.every((r) => r.error);
  return jsonResponse({ results }, { status: failed ? 502 : 200 });
}
