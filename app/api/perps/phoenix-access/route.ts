import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { grantPhoenixCapabilitiesOnFork } from "@/lib/solana/server/perps-keeper";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/perps/phoenix-access { owner } — FORK ONLY: stands in for Phoenix's onboarding, giving
 * the margin's registered Phoenix trader the deposit / withdraw / order capabilities an onboarded
 * mainnet trader has. On mainnet Phoenix grants them itself.
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
    const granted = await grantPhoenixCapabilitiesOnFork(new PublicKey(body.owner));
    return granted ? jsonResponse({ ok: true }) : jsonResponse({ error: "The margin's Phoenix trader isn't registered yet" }, { status: 409 });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "phoenix access failed" }, { status: 502 });
  }
}
