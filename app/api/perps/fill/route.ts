import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { fillPendingOrders } from "@/lib/solana/server/perps-keeper";
import { refreshForkPrices } from "@/lib/solana/server/fork-prices";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One fill run per owner at a time (two could fill the same order twice). */
const running = new Map<string, Promise<unknown>>();

/**
 * POST /api/perps/fill { owner } — FORK ONLY: the stand-in for GMTrade's keepers. Refreshes index
 * prices, then fills every pending order of `owner`'s venue account at the on-chain index price.
 * On mainnet GMTrade's own keepers do this; the client only polls the order PDA.
 */
export async function POST(request: NextRequest) {
  let body: { owner?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isPublicKeyString(body.owner)) return jsonResponse({ error: "A valid owner address is required" }, { status: 400 });
  const owner = body.owner;
  try {
    const run =
      running.get(owner) ??
      refreshForkPrices()
        .then(() => fillPendingOrders(new PublicKey(owner)))
        .finally(() => running.delete(owner));
    running.set(owner, run);
    return jsonResponse({ ok: true, fills: await run });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "fill failed" }, { status: 502 });
  }
}
