import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";
import { getTradeHistory } from "@/lib/predict/activity.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/predict/activity/:owner?market=<id> — the wallet's trades on the fork, reconstructed from chain. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ owner: string }> }) {
  const { owner } = await ctx.params;
  if (!isPublicKeyString(owner)) return jsonResponse({ error: "Invalid wallet address" }, { status: 400 });
  const market = req.nextUrl.searchParams.get("market");
  try {
    const trades = await getTradeHistory(new PublicKey(owner));
    return jsonResponse({ trades: market ? trades.filter((t) => t.marketId === market) : trades });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Failed to load activity" }, { status: 502 });
  }
}
