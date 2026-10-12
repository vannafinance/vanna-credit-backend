import type { AccountMeta } from "@solana/web3.js";
import { VALIDATOR_PROGRAM_ID } from "@/lib/solana/config";
import { quoteLiquidation, repayWithBuffer, withSlippage, type LiquidationQuote } from "@/lib/solana/liquidate";
import { mulDivFloor } from "@/lib/solana/math";
import { integrationPda } from "@/lib/solana/pdas";
import {
  amountData,
  ASK,
  BID,
  marketOrderData,
  orderAccounts,
  PHOENIX_EXCHANGE,
  PHOENIX_PROGRAM_ID,
  phoenixValidatorAccounts,
  usdToTicks,
  WITHDRAW_FUNDS,
  withdrawAccounts,
} from "@/lib/solana/phoenix";
import { refreshPhoenixBookOnFork } from "@/lib/solana/server/perps-keeper";
import type { DebtPositionView } from "@/lib/solana/margin";
import { log } from "../log";
import type { LiquidationStrategy } from "./types";

/** Validator constants (vanna_validator/src/phoenix.rs): a liquidation close's limit must sit within this band of the index. */
const CLOSE_LOSS_BPS = 500;
const LIQUIDATION_BAND_BPS = 300;
/** Stay inside the band by this fraction (the program's own tests use 90%). */
const BAND_USE = 0.9;

/** The validator's band for a market, bps: min(CLOSE_LOSS_BPS × 10,000 / max_leverage_bps, 300). */
export function liquidationBandBps(maxLeverageBps: number): number {
  return Math.min((CLOSE_LOSS_BPS * 10_000) / Math.max(1, maxLeverageBps), LIQUIDATION_BAND_BPS);
}

const ro = (pubkey: AccountMeta["pubkey"]): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

/**
 * Phoenix venue: in ONE `public_liquidate`, close every open position (reduce-only market orders
 * that must fill completely, priced inside the validator's band around the index), withdraw the
 * trader's collateral to the margin as phUSD (the validator sets the amount: what Phoenix pays now),
 * then repay a debt and seize that phUSD. The phUSD is unwrapped to USDC by the after-liquidation
 * hook. Mirrors the program's own test (tests/external/phoenix/liquidation.rs).
 */
export const phoenixStrategy: LiquidationStrategy = {
  name: "phoenix",
  async propose({ ctx, healthWad, row }, wallet, config) {
    const venue = ctx.venue;
    if (!venue?.open || !venue.trader) return null;
    const why = (reason: string) => {
      log("WARNING", `phoenix: ${reason}`, { margin: row.address });
      return null;
    };
    if (venue.trader.withdrawQueued) return why("the trader has a queued withdrawal, Phoenix would refuse the withdraw");
    if (venue.withdrawableNow <= 0n) return why("Phoenix's withdraw budget is empty right now");

    const assets = [...ctx.assetMap.values()];
    const venueAsset = assets.find((a) => a.kind === "venue" && a.mint.equals(PHOENIX_EXCHANGE));
    const phusdAsset = assets.find((a) => a.mint.equals(venue.exchange.canonicalMint));
    if (!venueAsset || !phusdAsset) return why("the Phoenix venue or phUSD is not registered");

    const open = venue.trader.positions.filter((p) => p.baseLots !== 0n);
    const calls: Array<{ data: Buffer; accounts: AccountMeta[] }> = [];
    for (const position of open) {
      const m = venue.markets.find((x) => x.entry.assetId === position.assetId);
      if (!m) return why(`position in unlisted asset ${position.assetId}`);
      if (config.forkPriceRefresh) await refreshPhoenixBookOnFork(m.meta.key).catch(() => 0);
      const index = m.index?.usd;
      if (!index || !(index > 0)) return why(`no index price for ${m.meta.key}`);
      const band = (liquidationBandBps(m.entry.maxLeverageBps) * BAND_USE) / 10_000;
      const isLong = position.baseLots > 0n;
      const lots = isLong ? position.baseLots : -position.baseLots;
      const limit = isLong ? index * (1 - band) : index * (1 + band);
      calls.push({
        data: marketOrderData({ side: isLong ? ASK : BID, priceInTicks: usdToTicks(m.market, limit), lots, reduceOnly: true, minBaseLotsToFill: lots }),
        accounts: orderAccounts(venue.exchange, ctx.margin, m.market),
      });
    }
    // Amount 0: in a liquidation the validator replaces it with what Phoenix can pay now.
    calls.push({ data: amountData(WITHDRAW_FUNDS, 0n), accounts: withdrawAccounts(venue.exchange, ctx.margin) });

    // phUSD the margin will hold once the calls ran: what is already there plus what Phoenix pays
    // out (the venue's value, capped by the withdraw budget). phUSD is valued at $1.
    const existing = ctx.snapshot.collateral.find((c) => c.mint.equals(phusdAsset.mint))?.amountRaw ?? 0n;
    const venueMicro = venue.valueNano / 1_000n;
    const heldRaw = existing + (venueMicro < venue.withdrawableNow ? venueMicro : venue.withdrawableNow);
    const heldValueNano = heldRaw * 1_000n;

    let best: { debt: DebtPositionView; quote: LiquidationQuote } | null = null;
    for (const debt of ctx.snapshot.debts) {
      if (debt.debtRaw <= 0n) continue;
      const quote = quoteLiquidation({
        healthWad,
        bonusBps: phusdAsset.liquidationBonusBps,
        debtRaw: debt.debtRaw,
        debtValueNano: debt.valueNano,
        heldRaw,
        heldValueNano,
        repay: wallet.balance(debt.mint),
      });
      if (quote && (!best || quote.grossProfitNano > best.quote.grossProfitNano)) best = { debt, quote };
    }
    if (!best) return null;
    const debtAsset = ctx.assetMap.get(best.debt.assetIndex);
    if (!debtAsset) return null;

    return {
      strategy: "phoenix",
      profitUsd: Number(best.quote.grossProfitNano) / 1e9,
      summary: {
        debt: best.debt.symbol,
        collateral: "phUSD",
        repay: best.quote.repaid,
        seize: best.quote.seized,
        full: best.quote.full,
        closes: open.length,
        phoenixUsd: Number(mulDivFloor(venue.valueNano, 1n, 1_000_000_000n)),
      },
      request: {
        settle: {
          debtAsset,
          collateralAsset: phusdAsset,
          repay: repayWithBuffer(best.quote, wallet.balance(best.debt.mint)),
          minSeized: withSlippage(best.quote.seized, config.venueSlippageBps),
        },
        venue: {
          venueAsset: venueAsset.address,
          integration: integrationPda(PHOENIX_PROGRAM_ID),
          targetProgram: PHOENIX_PROGRAM_ID,
          validator: VALIDATOR_PROGRAM_ID,
          calls,
          validatorAccounts: phoenixValidatorAccounts(venue.book, venue.openAssetIds).map(ro),
          touched: [phusdAsset],
        },
      },
    };
  },
};
