/**
 * Self-heal for the fork's stale-DEX-pool failures, used only when the MCP could not build a swap.
 *
 * On the Surfpool fork a concentrated-liquidity pool's cloned state drifts from mainnet, so a Jupiter route
 * that quoted fine can fail simulation (Anchor 3005 "AccountNotEnoughKeys", Jupiter 6001 slippage, a stale
 * DLMM bin). The app's own swap path already handles this by re-cloning the accounts the transaction touches
 * and simulating again (lib/solana/swap.ts, lib/solana/fork-heal.ts). The Copilot calls the same
 * `healStaleDexPools`, then asks the MCP to build the swap again against the refreshed pools.
 *
 * Nothing here signs or sends: a failed MCP envelope still carries the unsigned transaction, which is only
 * read for the account list.
 */

import { VersionedTransaction } from "@solana/web3.js";
import { getConnection } from "../../solana/connection";
import { healStaleDexPools } from "../../solana/fork-heal";

/** Swap-build failures that mean "fork pool state is stale", not "this swap is wrong". */
export const STALE_FORK_SWAP =
  /AccountNotEnoughKeys|\b3005\b|0x1771|\b6001\b|SlippageToleranceExceeded|0x1788|\b6024\b|0xbbd|bin_array|stale[_ ]pool|stale[_ ]bin|invalid index/i;

/** How many times a swap build is retried after a heal. */
export const MAX_SWAP_HEALS = 2;

export const swapHealDeps = {
  heal: (tx: VersionedTransaction): Promise<number> => healStaleDexPools(getConnection(), tx),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export function isSwapBuild(call: { tool: string; args: Record<string, unknown> }): boolean {
  return call.tool === "vanna_swap" && (call.args.action === "wallet_swap" || call.args.action === "margin_swap");
}

/** The unsigned transaction of a (possibly failed) write envelope, or null if it carries none. */
export function unsignedFromEnvelope(raw: Record<string, unknown>): VersionedTransaction | null {
  const txs = Array.isArray(raw.transactions) ? raw.transactions : [];
  const first = txs[0];
  const b64 = first && typeof first === "object" ? (first as Record<string, unknown>).unsignedTransaction : null;
  if (typeof b64 !== "string" || !b64) return null;
  try {
    return VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

/** Heal the pools a failed swap envelope touched. Returns how many accounts were reset (0 = nothing to fix). */
export async function healFromEnvelope(raw: Record<string, unknown>): Promise<number> {
  const tx = unsignedFromEnvelope(raw);
  if (!tx) return 0;
  try {
    return await swapHealDeps.heal(tx);
  } catch {
    return 0;
  }
}
