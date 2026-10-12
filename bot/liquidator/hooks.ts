import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TransactionInstruction, type Keypair } from "@solana/web3.js";
import { getConnection } from "@/lib/solana/connection";
import { EMBER_PROGRAM_ID, emberAccounts, emberWithdrawData, PHUSD_MINT, readPhoenixExchange } from "@/lib/solana/phoenix";
import { tokenAccountAmount } from "@/lib/solana/protocol-state";
import { getToken } from "@/lib/solana/tokens";
import { keypairSigner, sendInstructions } from "@/lib/solana/tx";
import * as alerts from "./alerts";
import { log } from "./log";
import type { LiquidationAction } from "./strategies";

/** A landed liquidation, handed to every after-liquidation hook. */
export interface LiquidationResult {
  margin: string;
  signature: string;
  action: LiquidationAction;
  /** The account's liquidation HF before this call. */
  healthFactor: number | null;
}

/**
 * Runs after each landed liquidation, e.g. swapping seized collateral back to the debt token, or
 * notifying a channel. A failing hook is logged and never stops the bot.
 */
export interface AfterLiquidationHook {
  name: string;
  run(result: LiquidationResult, keypair: Keypair): Promise<void>;
}

/** Posts each landed liquidation to Telegram (a no-op without TELEGRAM_* settings). Queued, not awaited: the next liquidation doesn't wait for Telegram. */
const telegramHook: AfterLiquidationHook = {
  name: "telegram",
  run: async ({ margin, signature, action, healthFactor }) => {
    void alerts.liquidated({ margin, signature, strategy: action.strategy, profitUsd: action.profitUsd, summary: action.summary, healthFactor });
  },
};

/**
 * phUSD (what a Phoenix liquidation seizes) back to USDC: the liquidator calls Ember's withdraw
 * itself, as the owner of its phUSD, for its whole phUSD balance.
 */
const unwrapPhusdHook: AfterLiquidationHook = {
  name: "unwrap-phusd",
  async run({ action }, keypair) {
    if (!action.request.settle?.collateralAsset.mint.equals(PHUSD_MINT)) return;
    const connection = getConnection();
    const owner = keypair.publicKey;
    const phusd = getAssociatedTokenAddressSync(PHUSD_MINT, owner, false, TOKEN_PROGRAM_ID);
    const balance = tokenAccountAmount(await connection.getAccountInfo(phusd, "confirmed"), TOKEN_PROGRAM_ID);
    if (balance <= 0n) return;
    const usdc = getToken("USDC");
    const exchange = await readPhoenixExchange(connection);
    // emberAccounts names the owner first, read-only: here the owner signs for itself.
    const keys = emberAccounts(exchange, owner, usdc.mint).map((k, i) => (i === 0 ? { ...k, isSigner: true } : k));
    const ixs = [
      createAssociatedTokenAccountIdempotentInstruction(owner, getAssociatedTokenAddressSync(usdc.mint, owner, false, usdc.tokenProgram), owner, usdc.mint, usdc.tokenProgram),
      new TransactionInstruction({ programId: EMBER_PROGRAM_ID, keys, data: emberWithdrawData(null) }),
    ];
    const signature = await sendInstructions(ixs, { signer: keypairSigner(keypair), label: "Unwrap phUSD" });
    log("INFO", "unwrapped phUSD to USDC", { amount: balance, signature });
  },
};

/** Order matters: unwrap first, so the next liquidation already has the USDC. Other seized collateral stays in the wallet. */
export const HOOKS: AfterLiquidationHook[] = [unwrapPhusdHook, telegramHook];
