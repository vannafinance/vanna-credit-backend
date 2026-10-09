import { PublicKey } from "@solana/web3.js";
import type { NextRequest } from "next/server";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";
import { cachedRow, decorate, lookupOwner } from "@/lib/analytics/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/accounts/:owner — one account (from the snapshot, or looked up on demand and
 * added to it). Read-only: it only reads the wallet's margin PDA.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ owner: string }> }) {
  const { owner } = await params;
  if (!isPublicKeyString(owner)) return jsonResponse({ error: "A valid Solana wallet address is required" }, { status: 400 });
  try {
    const row = cachedRow(owner) ?? (await lookupOwner(new PublicKey(owner)));
    if (!row) return jsonResponse({ error: "This wallet has no Vanna margin account on the fork." }, { status: 404 });
    return jsonResponse({ row: decorate(row) });
  } catch {
    return jsonResponse({ error: "Account read failed" }, { status: 502 });
  }
}
