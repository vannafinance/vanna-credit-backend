import { NextRequest, NextResponse } from "next/server";
import { jupiterBaseUrl, jupiterHeaders } from "@/lib/solana/server/jupiter-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/jupiter/swap-instructions — proxied with the server API key.
 *
 * Used for MARGIN-account swaps: the caller passes `userPublicKey` = the margin PDA,
 * `wrapAndUnwrapSol: false` and `useSharedAccounts: true`, and wraps only the returned
 * `swapInstruction` in the program's `margin_execute` (the Jupiter adapter allows exact-input
 * `route` / `shared_accounts_route` with no platform fee).
 */
export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const response = await fetch(`${jupiterBaseUrl()}/swap/v1/swap-instructions`, {
      method: "POST",
      headers: jupiterHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const body = await response.json();
    return NextResponse.json(body, { status: response.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Jupiter swap-instructions failed" }, { status: 502 });
  }
}
