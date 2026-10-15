import { PublicKey } from "@solana/web3.js";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";
import { getPositions } from "@/lib/predict/positions.server";
import { ttlCache } from "@/lib/server-cache";
import { wantsFresh } from "@/lib/fresh-reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

/**
 * Each open Predict tab polls its positions every 20 s (~11 fork calls per read). Per-wallet reads
 * within 15 s are shared; `?fresh=1` (sent right after the user's own trade) always reads the chain.
 */
const POSITIONS_TTL_MS = 15_000;
const cachedPositions = ttlCache<Awaited<ReturnType<typeof getPositions>>>(POSITIONS_TTL_MS, 1_000);

/** GET /api/predict/positions/:owner — wallet outcome tokens + pooled shares (valued), summary, vault, importable. */
export async function GET(req: Request, ctx: { params: Promise<{ owner: string }> }) {
  const { owner } = await ctx.params;
  if (!isPublicKeyString(owner)) return jsonResponse({ error: "Invalid wallet address" }, { status: 400 });
  try {
    const fresh = wantsFresh(req);
    const scope = fresh ? {} : undefined;
    return jsonResponse(await cachedPositions(owner, () => getPositions(new PublicKey(owner), scope), { fresh }));
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Failed to load positions" }, { status: 502 });
  }
}
