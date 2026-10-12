import { PublicKey } from "@solana/web3.js";
import type { NextRequest } from "next/server";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";
import { cachedRow, decorate, lookupOwner } from "@/lib/analytics/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/accounts/:owner - one account (`owner` is a wallet or a margin account address) (from the snapshot, or looked up on demand and
 * added to it). Read-only: it only reads the margin account.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ owner: string }> }) {
  const { owner } = await params;
  if (!isPublicKeyString(owner)) return jsonResponse({ error: "A valid wallet or margin account address is required" }, { status: 400 });
  try {
    const row = cachedRow(owner) ?? (await lookupOwner(new PublicKey(owner)));
    if (!row) return jsonResponse({ error: "No Vanna margin account found for this address on the fork." }, { status: 404 });
    return jsonResponse({ row: decorate(row) });
  } catch {
    return jsonResponse({ error: "Account read failed" }, { status: 502 });
  }
}
