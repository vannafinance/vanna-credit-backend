import { NextRequest } from "next/server";
import { fundOnFork } from "@/lib/solana/server/fork-faucet";
import { findToken, TOKENS } from "@/lib/solana/tokens";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/faucet { address, symbol? } — tops up the address on the fork by each token's faucet
 * amount (1000) via Surfpool cheatcodes. Omit `symbol` to fund every registry token.
 */
export async function POST(request: NextRequest) {
  let body: { address?: unknown; symbol?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isPublicKeyString(body.address)) return jsonResponse({ error: "A valid Solana address is required" }, { status: 400 });
  const tokens = body.symbol === undefined ? TOKENS : [findToken(String(body.symbol))].filter(Boolean);
  if (tokens.length === 0) return jsonResponse({ error: `Unsupported faucet token ${String(body.symbol)}` }, { status: 400 });
  try {
    const results = [];
    for (const t of tokens) results.push(await fundOnFork(t!.symbol, body.address));
    return jsonResponse({ ok: true, results, note: "Funded via Surfpool cheatcode (not a transaction)" });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Faucet request failed" }, { status: 502 });
  }
}
