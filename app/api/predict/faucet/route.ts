import { PublicKey } from "@solana/web3.js";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";
import { fundOnFork } from "@/lib/solana/server/fork-faucet";
import { fundCashOnFork } from "@/lib/predict/maker.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_CASH = 100;
const MAX_CASH = 1000;

/**
 * POST /api/predict/faucet { address, amount?, usdc? } — fork-only test faucet: +CASH (default 100,
 * max 1000) and SOL for fees via Surfpool cheatcodes; `usdc: true` also adds the app's USDC faucet
 * amount (to test paying with USDC).
 */
export async function POST(req: Request) {
  let body: { address?: unknown; amount?: unknown; usdc?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isPublicKeyString(body.address)) return jsonResponse({ error: "A valid Solana address is required" }, { status: 400 });
  const amount = typeof body.amount === "number" && body.amount > 0 ? Math.min(body.amount, MAX_CASH) : DEFAULT_CASH;
  try {
    const result = await fundCashOnFork(new PublicKey(body.address), amount);
    const usdc = body.usdc === true ? (await fundOnFork("USDC", body.address)).balance : undefined;
    return jsonResponse({ ok: true, added: amount, ...result, ...(usdc ? { usdc } : {}) });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Faucet failed" }, { status: 502 });
  }
}
