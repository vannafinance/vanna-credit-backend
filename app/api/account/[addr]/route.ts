import { PublicKey } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { fetchMarginSnapshot, serializeMarginSnapshot } from "@/lib/solana/margin";
import { fetchLenderPositions } from "@/lib/solana/lend";
import { fetchWalletBalances } from "@/lib/solana/balances";
import { isPublicKeyString, jsonResponse } from "@/lib/solana/server/json";
import { ttlCache } from "@/lib/server-cache";
import { wantsFresh } from "@/lib/fresh-reads";
import type { ReadScope } from "@/lib/async";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every open tab re-reads its wallet on each 8 s tick (11–15 fork calls). A 3 s per-wallet window
 * lets tabs of the same wallet share one read; `?fresh=1` (sent for a few seconds after the user's
 * own transaction, see lib/fresh-reads.ts) always reads the chain.
 */
const ACCOUNT_TTL_MS = 3_000;
const cachedAccount = ttlCache<object>(ACCOUNT_TTL_MS, 1_000);

/**
 * GET /api/account/:wallet — the wallet's full on-chain picture: margin snapshot (collateral vaults,
 * accrued debts, exact HF), lender positions and wallet balances. Nothing is cached client-side.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ addr: string }> }) {
  const { addr } = await params;
  if (!isPublicKeyString(addr)) return jsonResponse({ error: "A valid Solana address is required" }, { status: 400 });
  try {
    const owner = new PublicKey(addr);
    const fresh = wantsFresh(request);
    // Display requests may reuse public state; fresh reads isolate pre-confirmation work.
    const scope: ReadScope = { publicState: fresh ? "fresh" : "cached" };
    const body = await cachedAccount(
      addr,
      async () => {
        const [margin, lender, wallet] = await Promise.all([fetchMarginSnapshot(owner, scope), fetchLenderPositions(owner, scope), fetchWalletBalances(owner, undefined, scope)]);
        return { margin: serializeMarginSnapshot(margin), lender, wallet: { ui: wallet.ui, wsol: wallet.wsolRaw } };
      },
      { fresh },
    );
    return jsonResponse(body);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "account read failed" }, { status: 502 });
  }
}
