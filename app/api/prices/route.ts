import { forkUnixTimestamp, getConnection } from "@/lib/solana/connection";
import { readOnchainPrices } from "@/lib/solana/prices";
import { TOKENS } from "@/lib/solana/tokens";
import { jsonResponse } from "@/lib/solana/server/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/prices — USD prices exactly as the program reads them (each asset's on-chain
 * OracleConfig: Kamino Scope first, Pyth fallback), with their source, age against the fork clock
 * and freshness against the asset's own max age.
 */
export async function GET() {
  try {
    const connection = getConnection();
    const [prices, now] = await Promise.all([readOnchainPrices(connection), forkUnixTimestamp(connection)]);
    const body = Object.fromEntries(
      TOKENS.map((t) => {
        const p = prices[t.symbol];
        const ageSecs = p ? Number(now - p.publishTime) : null;
        return [
          t.symbol,
          {
            usd: p?.usd ?? null,
            publishTime: p ? Number(p.publishTime) : null,
            ageSecs,
            stale: !p || !p.fresh,
            source: p?.source ?? null,
          },
        ];
      }),
    );
    return jsonResponse({ prices: body, forkTimestamp: Number(now) });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "price read failed" }, { status: 502 });
  }
}
