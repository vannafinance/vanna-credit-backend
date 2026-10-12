import { PublicKey } from "@solana/web3.js";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";
import { getPositions } from "@/lib/predict/positions.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

/** GET /api/predict/positions/:owner — wallet outcome tokens + pooled shares (valued), summary, vault, importable. */
export async function GET(_req: Request, ctx: { params: Promise<{ owner: string }> }) {
  const { owner } = await ctx.params;
  if (!isPublicKeyString(owner)) return jsonResponse({ error: "Invalid wallet address" }, { status: 400 });
  try {
    return jsonResponse(await getPositions(new PublicKey(owner)));
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Failed to load positions" }, { status: 502 });
  }
}
