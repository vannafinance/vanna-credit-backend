/**
 * Named strategies, planned from live MCP reads. Today: "lever X Nx".
 *
 * Lever = (deposit X if it is not already margin collateral) -> borrow a stable -> swap it into X
 * INSIDE the margin account (`margin_swap` leaves X in the vault as collateral, so there is no
 * separate "deposit the swap output" step) -> report the final health factor.
 *
 * Sizing is arithmetic on the MCP's collateral/debt/price numbers (risk.ts) with the swap taken at
 * its worst allowed price, so the health floor holds even if the fill is bad. The borrow and swap
 * steps re-check health live again when they are built (steps.ts), and pause rather than push on.
 */

import { copilotConfig } from "../config";
import { fmtAmount, fmtHf, humanizeMcpError } from "../explain";
import type { Asset, AskOption, LeverIntent } from "../intent";
import { mcp } from "../mcp-client";
import { loadFreshPrice, loadHealth, type ReadCtx } from "../mcp-facts";
import { planWarnings, reportStep, type StepSpec } from "../plan";
import { DEFAULT_SLIPPAGE_BPS, floorDecimals, num, simulationFrom, sizeLever, tokenDecimals, usdToUnits } from "../risk";
import type { Simulation } from "../types";
import { walletSpendable } from "./steps";

export interface PlannedWorkflow {
  summary: string;
  steps: StepSpec[];
  warnings: string[];
  simulation: Simulation | null;
  hfFloor: number;
}

export type StrategyResult = { ok: true; plan: PlannedWorkflow } | { ok: false; message: string; options?: AskOption[] };

const no = (message: string, options?: AskOption[]): StrategyResult => ({ ok: false, message, ...(options?.length ? { options } : {}) });

export async function planLever(intent: LeverIntent, ctx: ReadCtx): Promise<StrategyResult> {
  const asset = intent.asset as Asset;

  if (!intent.borrow_asset) {
    const pick = (b: "USDC" | "USDT"): AskOption => ({
      label: `Borrow ${b}`,
      description: `Fund the extra exposure by borrowing ${b}, then swap it into ${asset}.`,
      apply: { lane: "lever", lever: { ...intent, borrow_asset: b } },
    });
    const options = (["USDC", "USDT"] as const).filter((b) => b !== (asset as string)).map(pick);
    return no(`To lever ${asset} ${intent.leverage}x I borrow a stable and swap it into ${asset}. Which one should I borrow?`, options);
  }
  const borrowAsset = intent.borrow_asset;

  const floor = Math.max(copilotConfig.minHealthFactor, intent.min_hf ?? 0);
  const [healthR, pAsset, pBorrow] = await Promise.all([loadHealth(ctx), loadFreshPrice(asset, ctx), loadFreshPrice(borrowAsset, ctx)]);
  if (healthR.kind === "unavailable") return no(humanizeMcpError(healthR.error).message);
  if (healthR.kind === "malformed") return no("I couldn't read your account data, so I can't size a leveraged position.");
  // A price still flagged stale after the keeper refresh is sized with its current value: every step re-checks
  // health live when it is built, and the MCP fails closed on a genuinely stale price.
  if (!pAsset) return no(`The ${asset} price is unavailable right now, so I can't size this safely. Try again in a minute.`);
  if (!pBorrow) return no(`The ${borrowAsset} price is unavailable right now, so I can't size this safely. Try again in a minute.`);

  const hasAccount = healthR.kind === "ok";
  const health = hasAccount ? healthR.health : null;
  const marginUnits = health?.collateral.find((r) => r.symbol === asset)?.units ?? 0;

  let equityUnits: number;
  let depositUnits = 0;
  if (intent.amount) {
    const want = Number(intent.amount);
    equityUnits = want;
    depositUnits = Math.max(0, want - marginUnits);
  } else {
    if (!(marginUnits > 0)) {
      return no(`You have no ${asset} collateral in your margin account. Tell me how much ${asset} to lever, for example "lever 5 ${asset} ${intent.leverage}x", and I'll deposit it from your wallet first.`);
    }
    equityUnits = marginUnits;
  }
  if (!(equityUnits > 0)) return no("The amount to lever has to be above zero.");

  if (depositUnits > 0) {
    const spendable = await walletSpendable(asset, ctx);
    if (spendable === null) return no("I couldn't read your wallet balance, so I can't plan the deposit.");
    if (spendable + 1e-9 < depositUnits) {
      return no(`Your wallet has ${fmtAmount(spendable, asset)} available${asset === "SOL" ? " (keeping a little SOL for fees)" : ""}, less than the ${fmtAmount(depositUnits, asset)} this plan would deposit.`);
    }
  }

  const equityUsd = equityUnits * pAsset.usd;
  const depositUsd = depositUnits * pAsset.usd;
  const size = sizeLever({
    collateralUsd: health?.collateralUsd ?? 0,
    debtUsd: health?.debtUsd ?? 0,
    equityUsd,
    depositUsd,
    leverage: intent.leverage,
    floor,
  });
  if (!size.ok) {
    const options: AskOption[] = size.maxLeverage
      ? [{ label: `Use ${size.maxLeverage.toFixed(1)}x instead`, description: `The most I can size while keeping your health factor at ${floor.toFixed(2)} or above.`, apply: { lane: "lever", lever: { ...intent, leverage: size.maxLeverage } } }]
      : [];
    return no(`${size.reason}${size.maxLeverage ? ` The most I can do is about ${size.maxLeverage.toFixed(1)}x.` : " There is no safe leverage available on this balance."}`, options);
  }

  const borrowAmount = usdToUnits(size.borrowUsd, pBorrow.usd, borrowAsset);
  if (!(Number(borrowAmount) > 0)) return no("That leverage works out to a borrow too small to build.");

  // Pool liquidity is a hard gate the health maths cannot see.
  try {
    const pool = await mcp.poolStats(borrowAsset, ctx);
    const avail = num(pool.available_liquidity);
    if (avail !== null && avail < Number(borrowAmount)) {
      return no(`The ${borrowAsset} pool only has ${fmtAmount(avail, borrowAsset)} available to borrow, less than the ${fmtAmount(borrowAmount, borrowAsset)} this needs.`);
    }
  } catch (err) {
    return no(humanizeMcpError(err).message);
  }

  // The MCP's own borrow check, when the equity is already collateral (otherwise it runs live at that step).
  if (hasAccount && depositUnits === 0) {
    try {
      const can = await mcp.canBorrow({ authority: ctx.user.wallet, asset: borrowAsset, amount: borrowAmount }, ctx);
      if (can.allowed !== true) return no(`The program would refuse that borrow: ${typeof can.reason === "string" ? can.reason : "it does not pass its checks"}.`);
    } catch (err) {
      return no(humanizeMcpError(err).message);
    }
  }

  let expectedOut: string | null = null;
  try {
    const q = await mcp.swapQuote({ from_asset: borrowAsset, to_asset: asset, amount: borrowAmount, slippage_bps: DEFAULT_SLIPPAGE_BPS }, ctx);
    if (num(q.out_amount) === null) return no("I couldn't get a usable swap quote, so I can't plan this.");
    expectedOut = String(q.out_amount);
  } catch (err) {
    return no(humanizeMcpError(err).message);
  }

  const steps: StepSpec[] = [];
  if (!hasAccount) steps.push({ kind: "write", op: "create_account", asset: null, amount: null, slots: {} });
  if (depositUnits > 0) {
    steps.push({ kind: "write", op: "deposit", asset, amount: floorDecimals(depositUnits, tokenDecimals(asset)), slots: {} });
  }
  steps.push({ kind: "write", op: "borrow", asset: borrowAsset, amount: borrowAmount, slots: {} });
  steps.push({ kind: "write", op: "swap", asset: borrowAsset, amount: borrowAmount, slots: { to_asset: asset, mode: "margin", slippage_bps: DEFAULT_SLIPPAGE_BPS } });
  steps.push(reportStep());

  const s = 1 - DEFAULT_SLIPPAGE_BPS / 10_000;
  const hfBefore = health?.hf ?? null;
  const simulation = simulationFrom({
    health: health ?? { marginAccount: null, hf: null, collateralUsd: 0, debtUsd: 0, collateral: [], debt: [], isLiquidatable: false, pricesOk: true },
    hfAfter: size.hfAfter === Infinity ? null : size.hfAfter,
    collateralAfter: (health?.collateralUsd ?? 0) + depositUsd + size.borrowUsd * s,
    debtAfter: (health?.debtUsd ?? 0) + size.borrowUsd,
    amountUsd: size.borrowUsd,
    asset: borrowAsset,
    marginApplicable: true,
  });

  const summary =
    `Lever ${asset} ${intent.leverage}x: ${depositUnits > 0 ? `deposit ${fmtAmount(depositUnits, asset)}, ` : ""}borrow ${fmtAmount(borrowAmount, borrowAsset)}, ` +
    `swap it into about ${fmtAmount(expectedOut, asset)} inside your margin account. Worst-case health factor ${fmtHf(size.hfAfter === Infinity ? null : size.hfAfter)} (floor ${floor.toFixed(2)}).`;
  const warnings = planWarnings(steps, [
    `Sized with the swap at its worst allowed price (${DEFAULT_SLIPPAGE_BPS / 100}% slippage); health before: ${fmtHf(hfBefore)}.`,
    "Prices move between steps, so the borrow and the swap are each re-checked against your live health factor and pause if they would fall below the floor.",
    "Leverage magnifies losses: if the price of " + asset + " falls your health factor falls with it, and at 1.10 your account can be liquidated.",
  ]);
  return { ok: true, plan: { summary, steps, warnings, simulation, hfFloor: floor } };
}
