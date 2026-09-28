import { forkUnixTimestamp, getConnection } from "@/lib/solana/connection";
import { readOnchainPrices } from "@/lib/solana/pyth";
import { priceFeedAccount } from "@/lib/solana/pdas";
import { TOKENS } from "@/lib/solana/tokens";
import { jsonResponse } from "@/lib/solana/server/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Asset price-account max age (every registered asset uses 3600s). */
const MAX_PRICE_AGE_SECS = 3600;

/**
 * GET /api/prices — USD prices read from the fork's on-chain Pyth PriceUpdateV2 accounts (the same
 * accounts the program values positions with), plus their age against the fork clock.
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
            stale: ageSecs === null || ageSecs > MAX_PRICE_AGE_SECS,
            account: priceFeedAccount(t.pythFeedId).toBase58(),
          },
        ];
      }),
    );
    return jsonResponse({ prices: body, forkTimestamp: Number(now) });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "price read failed" }, { status: 502 });
  }
}
