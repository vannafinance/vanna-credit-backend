import { PublicKey } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { fetchMarginSnapshot, serializeMarginSnapshot } from "@/lib/solana/margin";
import { fetchLenderPositions } from "@/lib/solana/lend";
import { fetchWalletBalances } from "@/lib/solana/balances";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/account/:wallet — the wallet's full on-chain picture: margin snapshot (collateral vaults,
 * accrued debts, exact HF), lender positions and wallet balances. Nothing is cached client-side.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ addr: string }> }) {
  const { addr } = await params;
  if (!isPublicKeyString(addr)) return jsonResponse({ error: "A valid Solana address is required" }, { status: 400 });
  try {
    const owner = new PublicKey(addr);
    const [margin, lender, wallet] = await Promise.all([fetchMarginSnapshot(owner), fetchLenderPositions(owner), fetchWalletBalances(owner)]);
    return jsonResponse({ margin: serializeMarginSnapshot(margin), lender, wallet: { ui: wallet.ui, wsol: wallet.wsolRaw } });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "account read failed" }, { status: 502 });
  }
}
