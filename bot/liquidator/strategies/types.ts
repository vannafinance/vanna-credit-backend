import type { TransactionInstruction } from "@solana/web3.js";
import type { BatchContext } from "@/lib/solana/margin";
import type { LiquidateRequest } from "@/lib/solana/liquidate";
import type { BotConfig } from "../config";
import type { Target } from "../engine";
import type { Wallet } from "../wallet";

/** One liquidatable account, freshly loaded for this round. */
export interface Candidate {
  row: Target;
  ctx: BatchContext;
  /** The program's liquidation HF (WAD), <= 1.10. */
  healthWad: bigint;
}

/** What a strategy proposes for one round on one account. */
export interface LiquidationAction {
  strategy: string;
  /** Estimated profit before fees and swap costs, USD. The bot runs the best action above MIN_PROFIT_USD. */
  profitUsd: number;
  /** For logs. */
  summary: Record<string, unknown>;
  request: LiquidateRequest;
  /** Instructions to run before / after the liquidation in the same transaction (rarely needed). */
  before?: TransactionInstruction[];
  after?: TransactionInstruction[];
}

/**
 * A way to liquidate. Add one per collateral kind (token seize today; Kamino / Phoenix unwind next):
 * `propose` returns null when the account has nothing this strategy can act on. Strategies only
 * propose; the bot picks, sends and runs the after-liquidation hooks.
 */
export interface LiquidationStrategy {
  name: string;
  propose(candidate: Candidate, wallet: Wallet, config: BotConfig): Promise<LiquidationAction | null>;
}
