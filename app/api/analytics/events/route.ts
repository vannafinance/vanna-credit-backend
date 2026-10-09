import type { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/solana/server/json";
import { readSnapshot } from "@/lib/analytics/server/store";
import { eventCounts, listEvents } from "@/lib/analytics/server/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/events?names=Liquidated,Borrowed&limit=50 - program events decoded from the
 * transactions the account scan has inspected (newest first), with that scan's coverage. No extra RPC.
 */
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const names = (p.get("names") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const limit = Math.min(200, Math.max(1, Number(p.get("limit")) || 50));
  const { snapshot, state } = readSnapshot();
  return jsonResponse({ state, coverage: snapshot?.coverage ?? null, forkTime: snapshot?.forkTime ?? null, counts: eventCounts(), events: listEvents(names, limit) });
}
