import { NextRequest, NextResponse } from "next/server";
import { jupiterBaseUrl, jupiterHeaders } from "@/lib/solana/server/jupiter-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/jupiter/swap { quoteResponse, userPublicKey } — builds the wallet swap transaction. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.quoteResponse || !body?.userPublicKey) {
      return NextResponse.json({ error: "quoteResponse and userPublicKey are required" }, { status: 400 });
    }
    const response = await fetch(`${jupiterBaseUrl()}/swap/v1/swap`, {
      method: "POST",
      headers: jupiterHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
      body: JSON.stringify({
        quoteResponse: body.quoteResponse,
        userPublicKey: body.userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        // No priority fee: the fork has no fee market, and "auto" reads mainnet fee data.
        prioritizationFeeLamports: 0,
      }),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Jupiter swap failed" }, { status: 502 });
  }
}
