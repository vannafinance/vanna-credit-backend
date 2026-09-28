import { NextRequest, NextResponse } from "next/server";
import { jupiterBaseUrl, jupiterHeaders } from "@/lib/solana/server/jupiter-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This app targets a Surfpool mainnet fork. Oracle-driven routes can reject cloned oracle state
// and concentrated-liquidity pools drift from mainnet once cloned, so default to pool AMMs that
// behave on a fork (see Backend-Solana app/api/jupiter/quote for the full reasoning).
// Orca Whirlpool is included: it was excluded in Backend-Solana because a frozen clone's
// tick-array accounts can fall behind the pool's CURRENT tick (`InvalidTickArraySequence`), but on
// this fork Whirlpool-only routes (SOL/USDC both ways, SOL→JitoSOL, JupSOL→SOL, USDT↔USDC) all
// executed cleanly without needing a heal (verified 2026-09-28), and Whirlpool accounts are in
// fork-heal's STALE_PRONE_DEX_PROGRAMS so a drifted clone is re-cloned by `surfnet_resetAccount`
// before the swap is retried. Operators can override with JUPITER_FORK_DEXES.
const FORK_DEXES = process.env.JUPITER_FORK_DEXES ?? "Raydium,Raydium CLMM,Raydium CP,Orca V2,Meteora DLMM,Whirlpool";

/** GET /api/jupiter/quote?inputMint&outputMint&amount[&slippageBps] — proxied with the server API key. */
export async function GET(request: NextRequest) {
  const src = request.nextUrl.searchParams;
  if (!src.get("inputMint") || !src.get("outputMint") || !src.get("amount")) {
    return NextResponse.json({ error: "inputMint, outputMint, and amount are required" }, { status: 400 });
  }
  const url = new URL(`${jupiterBaseUrl()}/swap/v1/quote`);
  src.forEach((value, key) => url.searchParams.set(key, value));
  if (!url.searchParams.has("slippageBps")) url.searchParams.set("slippageBps", "100");
  if (!url.searchParams.has("dexes")) url.searchParams.set("dexes", FORK_DEXES);
  try {
    const response = await fetch(url.toString(), { headers: jupiterHeaders({ Accept: "application/json" }), cache: "no-store" });
    const body = await response.json();
    return NextResponse.json(body, { status: response.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Jupiter quote failed" }, { status: 502 });
  }
}
