/**
 * FORK ONLY (`FORK_AUTO_FAUCET=true`): keeps the liquidator stocked with every borrowable token, so
 * a liquidation is never skipped for lack of the debt token. When a balance falls under
 * FORK_FAUCET_MIN units it is set to FORK_FAUCET_TARGET units with the fork's cheatcodes. On
 * mainnet this must stay off: there the wallet is funded with real tokens.
 */
import type { PublicKey } from "@solana/web3.js";
import { callCheatcode } from "@/lib/solana/server/cheatcodes";
import { toRaw } from "@/lib/solana/math";
import type { AssetConfigState } from "@/lib/solana/protocol-state";
import { tokenByMint } from "@/lib/solana/tokens";
import { notify } from "./notify";
import { log } from "./log";
import type { Wallet } from "./wallet";

export async function topUpOnFork(owner: PublicKey, borrowable: AssetConfigState[], wallet: Wallet, min: number, target: number): Promise<string[]> {
  const topped: string[] = [];
  for (const asset of borrowable) {
    const token = tokenByMint(asset.mint);
    if (!token) continue;
    if (wallet.balance(asset.mint) >= toRaw(min, token.decimals)) continue;
    const amount = toRaw(target, token.decimals);
    if (token.isNative) {
      // Only the lamports change; the wallet keeps its owner and data (a plain system account).
      await callCheatcode("surfnet_setAccount", [owner.toBase58(), { lamports: Number(amount) }]);
    } else {
      await callCheatcode("surfnet_setTokenAccount", [owner.toBase58(), asset.mint.toBase58(), { amount: Number(amount) }, asset.tokenProgram.toBase58()]);
    }
    topped.push(token.symbol);
  }
  if (topped.length) {
    log("INFO", "fork faucet topped up the liquidator", { tokens: topped, to: target });
    void notify(`🚰 Fork faucet: liquidator topped up to ${target.toLocaleString("en-US")} ${topped.join(", ")}`, { key: `faucet:${topped.join(",")}`, everyMs: 3_600_000 });
  }
  return topped;
}
