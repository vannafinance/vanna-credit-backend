/**
 * One account, round by round: every strategy proposes, the most profitable action is sent, the
 * after-liquidation hooks run, until the account is healthy or nothing worth doing is left.
 * Shared by the bot loop (index.ts) and the fork e2e (scripts/e2e-liquidate.ts), so the test runs
 * exactly what the bot runs.
 */
import { PublicKey, type Keypair } from "@solana/web3.js";
import { BATCH_COMPUTE_UNITS } from "@/lib/solana/config";
import { describeError } from "@/lib/solana/errors";
import { loadContext } from "@/lib/solana/margin";
import { BALANCE_TO_BORROW_THRESHOLD_WAD, wadToNumber } from "@/lib/solana/math";
import { ensureFreshPrices } from "@/lib/solana/price-refresh";
import { keypairSigner, sendInstructions } from "@/lib/solana/tx";
import { liquidationHealthWad, liquidationInstructions, simulateSeized, withSlippage, type LiquidateRequest } from "@/lib/solana/liquidate";
import type { AccountRow } from "@/lib/analytics/types";
import * as alerts from "./alerts";
import type { BotConfig } from "./config";
import { HOOKS } from "./hooks";
import { log } from "./log";
import type { LiquidationAction, LiquidationStrategy } from "./strategies";
import { readWallet } from "./wallet";

/** A Phoenix close + withdraw + settle can name 100+ accounts and needs more than the batch budget. */
const LIQUIDATION_COMPUTE_UNITS = 1_400_000;

export interface RoundResult {
  round: number;
  outcome: "healthy" | "liquidated" | "dry-run" | "below-min-profit" | "no-action";
  action?: LiquidationAction;
  signature?: string;
  healthFactor: number | null;
}

/** The account to work on: an analytics row (the bot) or just its owner (the e2e). */
export type Target = Pick<AccountRow, "owner" | "address"> & Partial<Pick<AccountRow, "venueHeld">>;

export async function liquidateAccount(
  target: Target,
  keypair: Keypair,
  strategies: LiquidationStrategy[],
  config: BotConfig,
  isStopping: () => boolean = () => false,
): Promise<RoundResult[]> {
  const owner = new PublicKey(target.owner);
  const results: RoundResult[] = [];
  for (let round = 1; round <= config.maxRoundsPerAccount && !isStopping(); round++) {
    if (config.forkPriceRefresh) await ensureFreshPrices();
    const [ctx, wallet] = await Promise.all([loadContext(owner), readWallet(keypair.publicKey)]);
    const healthWad = liquidationHealthWad(ctx.snapshot, ctx.assetMap);
    const healthFactor = healthWad === null ? null : wadToNumber(healthWad);
    const base = { margin: target.address, round, healthFactor };
    if (healthWad === null || healthWad > BALANCE_TO_BORROW_THRESHOLD_WAD) {
      log("INFO", "account healthy", base);
      results.push({ round, outcome: "healthy", healthFactor });
      return results;
    }

    const proposals: LiquidationAction[] = [];
    for (const strategy of strategies) {
      try {
        const action = await strategy.propose({ row: target, ctx, healthWad }, wallet, config);
        if (action) proposals.push(action);
      } catch (error) {
        log("ERROR", "strategy failed", { ...base, strategy: strategy.name, error: describeError(error).slice(0, 300) });
      }
    }
    const action = proposals.sort((a, b) => b.profitUsd - a.profitUsd)[0];
    if (!action) {
      // A debt in a token the wallet doesn't hold can't be repaid: that is an inventory problem
      // someone must fix (top up the wallet), so it is an ERROR, not a quiet skip.
      const missing = ctx.snapshot.debts.filter((d) => d.debtRaw > 0n && wallet.balance(d.mint) === 0n).map((d) => d.symbol);
      const venueHeld = target.venueHeld ?? Boolean(ctx.venue?.open);
      log(missing.length ? "ERROR" : "WARNING", missing.length ? "cannot repay: wallet holds none of the debt token" : "liquidatable but no strategy can act", {
        ...base,
        missingDebtTokens: missing,
        venueHeld,
        collateral: ctx.snapshot.collateral.filter((c) => c.valueNano > 0n).map((c) => c.symbol),
        debts: ctx.snapshot.debts.map((d) => d.symbol),
      });
      if (missing.length) void alerts.cannotRepay(target.address, healthFactor, missing);
      else void alerts.noStrategy(target.address, healthFactor, venueHeld);
      results.push({ round, outcome: "no-action", healthFactor });
      return results;
    }
    const summary = { ...base, strategy: action.strategy, profitUsd: action.profitUsd, ...action.summary };
    if (action.profitUsd < config.minProfitUsd) {
      log("INFO", "below min profit, skipped", summary);
      results.push({ round, outcome: "below-min-profit", action, healthFactor });
      return results;
    }
    if (config.dryRun) {
      log("INFO", "DRY RUN: would liquidate", summary);
      void alerts.wouldLiquidate({ margin: target.address, strategy: action.strategy, profitUsd: action.profitUsd, summary: action.summary, healthFactor });
      results.push({ round, outcome: "dry-run", action, healthFactor });
      return results;
    }

    const sendOpts = {
      signer: keypairSigner(keypair),
      label: `Liquidate ${target.address}`,
      computeUnits: action.request.venue ? LIQUIDATION_COMPUTE_UNITS : BATCH_COMPUTE_UNITS,
    };
    const build = async (request: LiquidateRequest) => [...(action.before ?? []), ...(await liquidationInstructions(ctx, keypair.publicKey, request)), ...(action.after ?? [])];
    // The quote prices collateral with the app's prices; the program's oracle can differ (receipt
    // tokens), so `min_seized` comes from what a simulation really seizes, minus the slippage. If
    // the seize still moves past that bound before landing, simulate again and retry once.
    const withSimulatedMin = async (request: LiquidateRequest): Promise<LiquidateRequest> => {
      if (!request.settle) return request;
      const seized = await simulateSeized(await build({ ...request, settle: { ...request.settle, minSeized: 0n } }), sendOpts);
      if (seized === null) throw new Error("The simulation seized nothing");
      const slippage = request.venue ? config.venueSlippageBps : config.slippageBps;
      log("DEBUG", "simulated seize", { margin: target.address, quoted: action.summary.seize, simulated: seized });
      return { ...request, settle: { ...request.settle, minSeized: withSlippage(seized, slippage) } };
    };
    let signature: string;
    try {
      signature = await sendInstructions(await build(await withSimulatedMin(action.request)), sendOpts);
    } catch (error) {
      if (!/SlippageExceeded|slippage bound/i.test(describeError(error))) throw error;
      log("WARNING", "seize moved past min_seized before landing, retrying with a fresh simulation", { margin: target.address });
      signature = await sendInstructions(await build(await withSimulatedMin(action.request)), sendOpts);
    }
    log("INFO", "liquidated", { ...summary, signature });
    results.push({ round, outcome: "liquidated", action, signature, healthFactor });
    for (const hook of HOOKS) {
      try {
        await hook.run({ margin: target.address, signature, action, healthFactor }, keypair);
      } catch (error) {
        log("ERROR", "after-liquidation hook failed", { margin: target.address, hook: hook.name, error: describeError(error).slice(0, 300) });
      }
    }
  }
  return results;
}
