import { jsonResponse } from "@/lib/solana/server/json";
import { refreshPrices } from "@/lib/predict/prices.server";
import { buildTrade, TradeError, validateTradeRequest } from "@/lib/predict/trade.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;


/**
 * POST /api/predict/trade { owner, legs: [{ marketId, outcome, side, amount }], pay?, noPool? }
 * → ordered v0 transactions (maker-signed where the maker is a party) for ONE signAllTransactions.
 * Buys on allowlisted markets also deposit into outcome_yield_pool; sells redeem pooled shares
 * first when the wallet holds too few. See lib/predict/trade.server.ts.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const request = validateTradeRequest(body);
    // Fill prices refresh in the background; the build itself caps its live-quote read (trade.server.ts).
    void refreshPrices().catch(() => {});
    return jsonResponse(await buildTrade(request));
  } catch (error) {
    const status = error instanceof TradeError ? 400 : 502;
    return jsonResponse({ error: error instanceof Error ? error.message : "Failed to build trade" }, { status });
  }
}
