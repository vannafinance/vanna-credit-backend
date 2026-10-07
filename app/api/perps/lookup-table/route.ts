import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { ensurePerpsLookupTable } from "@/lib/solana/server/perps-keeper";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/perps/lookup-table { owner } — FORK ONLY: writes the address lookup table a margin's
 * Phoenix transactions reference (protocol accounts + the margin's own) and returns its address.
 * In production the guide keeps one protocol lookup table instead.
 */
export async function POST(request: NextRequest) {
  let body: { owner?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isPublicKeyString(body.owner)) return jsonResponse({ error: "A valid owner address is required" }, { status: 400 });
  try {
    return jsonResponse({ ok: true, address: (await ensurePerpsLookupTable(new PublicKey(body.owner))).toBase58() });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "lookup table failed" }, { status: 502 });
  }
}
