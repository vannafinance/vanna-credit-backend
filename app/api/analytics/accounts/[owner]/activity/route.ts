import { PublicKey } from "@solana/web3.js";
import type { NextRequest } from "next/server";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";
import { singleFlight } from "@/lib/async";
import { fetchMarginHistory } from "@/lib/solana/history";
import { describeActivity, type ActivityItem } from "@/lib/analytics/activity";
import { cachedRow, lookupOwner, warm } from "@/lib/analytics/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ActivityResponse {
  items: ActivityItem[];
  /** True when the scan reached the wallet's oldest transaction (nothing older exists). */
  complete: boolean;
  /** Transactions of the owner wallet that were read. */
  scanned: number;
}

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: ActivityResponse }>();
const flight = singleFlight<string, ActivityResponse>();

/**
 * GET /api/analytics/accounts/:owner/activity - this account's real transactions, newest first, decoded
 * from the program's own events by the same reader the Margin page uses (the owner wallet signs every
 * user transaction). Read-only. Cached briefly so many viewers do not each re-read the chain.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ owner: string }> }) {
  const { owner: id } = await params;
  if (!isPublicKeyString(id)) return jsonResponse({ error: "A valid wallet or margin account address is required" }, { status: 400 });
  try {
    await warm();
    const row = cachedRow(id) ?? (await lookupOwner(new PublicKey(id)));
    if (!row) return jsonResponse({ error: "No Vanna margin account found for this address on the fork." }, { status: 404 });
    const hit = cache.get(row.owner);
    if (hit && Date.now() - hit.at < TTL_MS) return jsonResponse(hit.value);
    const value = await flight(row.owner, async () => {
      const page = await fetchMarginHistory(new PublicKey(row.owner));
      return { items: page.rows.map(describeActivity), complete: page.complete, scanned: page.scanned };
    });
    cache.set(row.owner, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return jsonResponse(value);
  } catch {
    return jsonResponse({ error: "Activity could not be read" }, { status: 502 });
  }
}
