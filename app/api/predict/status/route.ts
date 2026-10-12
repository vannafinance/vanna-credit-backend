import { jsonResponse } from "@/lib/solana/server/json";
import { getForkMaker, getPoolKeeper } from "@/lib/predict/keys.server";
import { readPoolConfig } from "@/lib/predict/pool.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/predict/status — public keys of the fork maker / keeper and whether the keeper matches the pool config. */
export async function GET() {
  try {
    const cfg = await readPoolConfig();
    let keeper: string | null = null;
    try {
      keeper = getPoolKeeper().publicKey.toBase58();
    } catch {
      /* not configured */
    }
    return jsonResponse({
      maker: getForkMaker().publicKey.toBase58(),
      keeper,
      config: cfg ? { admin: cfg.admin.toBase58(), keeper: cfg.keeper.toBase58(), maxSwapLossBps: cfg.maxSwapLossBps } : null,
      keeperMatchesConfig: Boolean(cfg && keeper && cfg.keeper.toBase58() === keeper),
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Status failed" }, { status: 502 });
  }
}
