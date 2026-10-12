import { planLiquidations, repayWithBuffer, withSlippage } from "@/lib/solana/liquidate";
import type { LiquidationStrategy } from "./types";

/**
 * Token seize: repay one debt from the wallet and take one token collateral (+ bonus) straight out
 * of the margin vault. Works whether or not the account also holds a venue, as long as it has token
 * collateral; the most profitable pair the wallet can fund wins.
 */
export const tokenStrategy: LiquidationStrategy = {
  name: "token",
  async propose({ ctx }, wallet, config) {
    const plan = planLiquidations(ctx, (mint) => wallet.balance(mint))[0];
    if (!plan) return null;
    const repay = repayWithBuffer(plan.quote, wallet.balance(plan.debt.mint));
    return {
      strategy: "token",
      profitUsd: Number(plan.quote.grossProfitNano) / 1e9,
      summary: {
        debt: plan.debt.symbol,
        collateral: plan.collateral.symbol,
        repay: plan.quote.repaid,
        seize: plan.quote.seized,
        full: plan.quote.full,
      },
      request: {
        settle: {
          debtAsset: plan.debtAsset,
          collateralAsset: plan.collateralAsset,
          repay,
          minSeized: withSlippage(plan.quote.seized, config.slippageBps),
        },
      },
    };
  },
};
