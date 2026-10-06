/**
 * Per-step logic: fresh checks before a step is built, the MCP call that builds it, and read legs.
 *
 * Nothing here moves funds. `buildStepTx` returns an unsigned, MCP-simulated transaction for the
 * user's wallet; a step whose checks, limits or simulation fail is never handed to the wallet.
 * Every MCP action name and argument below is taken from mcp_server/dispatchers/*.py (note the
 * argument names differ by dispatcher: `authority` for margin/swap/farm/wallet, `owner` for earn).
 */

import { copilotConfig } from "../config";
import { humanizeFailure, humanizeMcpError } from "../explain";
import { checkAndConsume, checkSpend, type LimitDenied } from "../limits";
import { mcp, MCPError, parseWriteEnvelope } from "../mcp-client";
import type { Asset } from "../intent";
import { loadFreshPrice, loadHealth, priceDeps, resetPriceRefresh, runRead, sizeSafeBorrow, sizeSafeWithdraw, sizeToHealth, type ReadCtx, type ReadOutcome } from "../mcp-facts";
import { hfTarget, MARGIN_SWAP_BLOCKED_TARGETS, marginSwapBlockedMessage, outTarget, readLegOf, RISK_INCREASING } from "../plan";
import { answerReadLeg } from "../investigation/plan-reads";
import { floorDecimals, hfAfter as ratio, num, readCan, riskGate, simulationFrom, tokenDecimals } from "../risk";
import type { RiskResult, Simulation, UnsignedTx } from "../types";
import { healFromEnvelope, isSwapBuild, MAX_SWAP_HEALS, STALE_FORK_SWAP, swapHealDeps } from "./swap-heal";
import type { StoredStep } from "./types";

/** SOL the MCP keeps back from wallet "max" for fees and rent (TOOLS_CATALOGUE §2.2). */
export const SOL_FEE_RESERVE = 0.05;

export interface McpCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface Prepared {
  usd: number;
  call: McpCall;
  risk: RiskResult;
  simulation: Simulation | null;
  /** Exact amount this build will use ("all" resolved), for the card and audit trail. */
  resolvedAmount: string | null;
  notes: string[];
}

export type PreflightResult =
  | { ok: true; prepared: Prepared }
  | { ok: true; skip: string }
  | { ok: false; code: "limit" | "risk" | "unavailable" | "invalid" | "no_account"; message: string; limit?: LimitDenied };

const fail = (code: Extract<PreflightResult, { ok: false }>["code"], message: string): PreflightResult => ({ ok: false, code, message });

// The stale-price refresh lives in mcp-facts (shared with sizing and strategy); re-exported for the tests.
export { loadFreshPrice, priceDeps, resetPriceRefresh };

const isNoAccount = (e: unknown) => e instanceof MCPError && e.code === "account_not_found";

export async function walletSpendable(asset: string, ctx: ReadCtx): Promise<number | null> {
  try {
    const w = await mcp.wallet(ctx.user.wallet, ctx);
    if (asset === "SOL") {
      const sol = num(w.sol_balance);
      return sol === null ? null : Math.max(0, sol - SOL_FEE_RESERVE);
    }
    const row = Array.isArray(w.assets) ? (w.assets as Array<Record<string, unknown>>).find((a) => a.symbol === asset) : undefined;
    return row ? num(row.wallet_balance) : null;
  } catch {
    return null;
  }
}

function keep(amount: string, asset: string): string {
  return floorDecimals(Number(amount), tokenDecimals(asset));
}

/** Round UP to the token's decimals (an input sized to cover a target must never round below it). */
function ceilUnits(value: number, asset: string): string {
  const dp = tokenDecimals(asset);
  const f = 10 ** dp;
  return (Math.ceil(value * f - 1e-9) / f).toFixed(dp).replace(/\.?0+$/, "");
}

const EXACT_OUT_ROUNDS = 4;

/**
 * The input amount of `from` whose quoted MINIMUM output (after slippage) is at least `target` of `to`.
 * Starts from oracle prices plus the slippage allowance, then corrects from real quotes. The MCP builds swaps
 * by input amount; this keeps "receive at least N" honest without a separate exact-output route.
 */
export async function sizeExactOut(
  from: string,
  to: string,
  target: number,
  slippageBps: number,
  ctx: ReadCtx,
): Promise<{ ok: true; amountIn: string; minOut: string } | { ok: false; message: string }> {
  if (!(target > 0)) return { ok: false, message: "The amount to receive has to be above zero." };
  const [pFrom, pTo] = await Promise.all([loadFreshPrice(from, ctx), loadFreshPrice(to, ctx)]);
  if (!pFrom || !pTo) return { ok: false, message: `I couldn't price ${from} and ${to} right now, so I can't size this swap.` };
  let amountIn = ((target * pTo.usd) / pFrom.usd) * (1 + slippageBps / 10_000) * 1.005;
  for (let round = 0; round < EXACT_OUT_ROUNDS; round++) {
    const text = ceilUnits(amountIn, from);
    let minOut: number | null;
    try {
      const q = await mcp.swapQuote({ from_asset: from, to_asset: to, amount: text, slippage_bps: slippageBps }, ctx);
      minOut = num(q.min_out_amount);
    } catch (err) {
      return { ok: false, message: humanizeMcpError(err).message };
    }
    if (minOut === null || !(minOut > 0)) return { ok: false, message: "The swap route returned no usable quote." };
    if (minOut + 1e-12 >= target) return { ok: true, amountIn: text, minOut: String(minOut) };
    amountIn = Number(text) * (target / minOut) * 1.002;
  }
  return { ok: false, message: `I couldn't find a quote that delivers at least ${target} ${to} right now. Try again in a moment.` };
}

/**
 * Fresh checks for one step against live MCP data. Returns the exact MCP call to make, or why not.
 * `checkSpend` runs here (before any write is built), never after.
 */
export async function preflightStep(step: StoredStep, ctx: ReadCtx): Promise<PreflightResult> {
  const { user } = ctx;
  const wallet = user.wallet;
  const floor = copilotConfig.minHealthFactor;
  const asset = step.asset;
  const op = step.op;
  const notes: string[] = [];

  if (step.kind !== "write") return fail("invalid", "Only write steps are built.");

  // Known to exceed Solana's transaction size at any amount: say so now instead of failing at build time.
  const target = String(step.slots.to_asset ?? "");
  if (op === "swap" && step.slots.mode === "margin" && MARGIN_SWAP_BLOCKED_TARGETS.has(target)) {
    return fail("invalid", marginSwapBlockedMessage(target));
  }

  // ── account lifecycle ──
  if (op === "create_account") {
    try {
      const r = await mcp.accountResolve(wallet, ctx);
      if (r.exists === true) return { ok: true, skip: "You already have a margin account." };
    } catch (err) {
      return fail("unavailable", humanizeMcpError(err).message);
    }
    return { ok: true, prepared: { usd: 0, call: { tool: "vanna_account", args: { action: "create", authority: wallet } }, risk: { decision: "allow", reasons: [] }, simulation: null, resolvedAmount: null, notes } };
  }
  if (op === "close_account") {
    const h = await loadHealth(ctx);
    if (h.kind === "no_account") return { ok: true, skip: "You don't have a margin account." };
    if (h.kind !== "ok") return fail("unavailable", "I couldn't read your account, so I won't close it.");
    if (h.health.collateral.some((r) => r.units > 0) || h.health.debt.length) {
      return fail("invalid", "A margin account can only be closed when it holds no collateral and no debt. Repay and withdraw everything first.");
    }
    return { ok: true, prepared: { usd: 0, call: { tool: "vanna_account", args: { action: "close", authority: wallet } }, risk: { decision: "allow", reasons: [] }, simulation: null, resolvedAmount: null, notes } };
  }

  if (!asset) return fail("invalid", "This step is missing its asset.");
  const price = await loadFreshPrice(asset, ctx);
  if (!price) return fail("unavailable", `The ${asset} price is unavailable, so I can't value this action against your limits.`);
  // A price still flagged stale after the keeper refresh does NOT block the build. On the fork the MCP's oracle
  // read stays "stale" until its own write build restamps the feeds it needs, so refusing here made every
  // write wait for a refresh that only the build could trigger. The build is the authoritative check: the MCP
  // refreshes, simulates, and fails closed (StalePrice) if the price is genuinely too old. The number is still
  // the current value; only its freshness flag lags, which is irrelevant to the cap checks below.

  let amount = step.amount;
  const margin = op === "deposit" || op === "withdraw" || op === "borrow" || op === "repay" || op === "farm_deposit" || op === "farm_redeem" || (op === "swap" && step.slots.mode === "margin");
  const healthR = margin ? await loadHealth(ctx) : null;
  if (healthR && healthR.kind === "no_account") return fail("no_account", "You don't have a margin account yet. Open one first.");
  if (healthR && healthR.kind !== "ok") return fail("unavailable", "I couldn't read your margin account just now, so I'm not building this.");
  const health = healthR && healthR.kind === "ok" ? healthR.health : null;

  // "borrow down to a health factor of 1.5", "repay up to 2": sized now, from the account after every earlier step.
  const hfGoal = hfTarget(amount);
  if (hfGoal !== null) {
    const sized = await sizeToHealth(op, asset as Asset, hfGoal, ctx, { hint: healthR ?? undefined, fromMargin: step.slots.source === "margin" });
    if (!sized.ok) return fail("risk", sized.reason);
    if ("skip" in sized) return { ok: true, skip: sized.skip };
    amount = sized.amount;
    notes.push(`Sized to leave your health factor at about ${hfGoal.toFixed(2)}: ${sized.amount} ${asset}.`);
  }

  let usd = 0;
  let call: McpCall;
  let hfAfterValue: number | null | undefined = health?.hf ?? undefined;
  let collateralAfter = health?.collateralUsd ?? 0;
  let debtAfter = health?.debtUsd ?? 0;

  switch (op) {
    case "earn_supply": {
      if (amount === "all") {
        const spend = await walletSpendable(asset, ctx);
        if (spend === null || !(spend > 0)) return fail("invalid", `Your wallet has no spendable ${asset}.`);
        amount = keep(String(spend), asset);
      }
      usd = Number(amount) * price.usd;
      call = { tool: "vanna_earn_write", args: { action: "supply", owner: wallet, asset, amount } };
      break;
    }
    case "earn_redeem": {
      let pos: Record<string, unknown>;
      try {
        pos = await mcp.earnPosition(wallet, asset, ctx);
      } catch (err) {
        return fail("unavailable", humanizeMcpError(err).message);
      }
      const shares = num(pos.share_balance);
      const redeemable = num(pos.redeemable_underlying);
      if (shares === null || redeemable === null) return fail("unavailable", "I couldn't read your Earn balance.");
      if (!(shares > 0)) return fail("invalid", `You have nothing supplied to the ${asset} Earn pool.`);
      let sharesToBurn: string;
      if (amount === "all" || Number(amount) >= redeemable) {
        sharesToBurn = String(pos.share_balance);
        amount = String(pos.redeemable_underlying);
      } else {
        sharesToBurn = floorDecimals((Number(amount) * shares) / redeemable, tokenDecimals(asset));
      }
      if (!(Number(sharesToBurn) > 0)) return fail("invalid", "That amount is too small to redeem.");
      usd = Number(amount) * price.usd;
      call = { tool: "vanna_earn_write", args: { action: "redeem", owner: wallet, asset, shares: sharesToBurn } };
      notes.push(`Burns ${sharesToBurn} pool shares for about ${amount} ${asset}.`);
      break;
    }
    case "deposit": {
      if (amount === "all") {
        const spend = await walletSpendable(asset, ctx);
        if (spend === null || !(spend > 0)) return fail("invalid", `Your wallet has no spendable ${asset}.`);
        amount = keep(String(spend), asset);
      }
      usd = Number(amount) * price.usd;
      collateralAfter = (health?.collateralUsd ?? 0) + usd;
      hfAfterValue = ratio(collateralAfter, debtAfter);
      call = { tool: "vanna_margin_trade", args: { action: "deposit", authority: wallet, asset, amount } };
      break;
    }
    case "withdraw": {
      if (amount === "all") {
        const s = await sizeSafeWithdraw(asset as Asset, ctx, { hint: healthR ?? undefined });
        if (!s.ok) return fail("risk", s.reason);
        amount = s.amount;
      }
      usd = Number(amount) * price.usd;
      let can;
      try {
        can = readCan(await mcp.canWithdraw({ authority: wallet, asset, amount: amount as string }, ctx));
      } catch (err) {
        return fail("unavailable", humanizeMcpError(err).message);
      }
      if (!can) return fail("unavailable", "I couldn't check this withdrawal against your health factor.");
      if (!can.allowed) return fail("risk", humanizeFailure(can.reason));
      hfAfterValue = can.projectedHf;
      collateralAfter = (health?.collateralUsd ?? 0) - usd;
      call = { tool: "vanna_margin_trade", args: { action: "withdraw", authority: wallet, asset, amount } };
      break;
    }
    case "borrow": {
      if (amount === "all") {
        const s = await sizeSafeBorrow(asset as Asset, ctx, { hint: healthR ?? undefined });
        if (!s.ok) return fail("risk", s.reason);
        amount = s.amount;
      }
      usd = Number(amount) * price.usd;
      let can;
      try {
        can = readCan(await mcp.canBorrow({ authority: wallet, asset, amount: amount as string }, ctx));
      } catch (err) {
        return fail("unavailable", humanizeMcpError(err).message);
      }
      if (!can) return fail("unavailable", "I couldn't check this borrow against your health factor.");
      if (!can.allowed) return fail("risk", humanizeFailure(can.reason));
      hfAfterValue = can.projectedHf;
      collateralAfter = (health?.collateralUsd ?? 0) + usd; // borrowed funds stay in the margin vault
      debtAfter = (health?.debtUsd ?? 0) + usd;
      call = { tool: "vanna_margin_trade", args: { action: "borrow", authority: wallet, asset, amount } };
      break;
    }
    case "repay": {
      const debtRow = health?.debt.find((r) => r.symbol === asset);
      if (!debtRow || !(debtRow.units > 0)) return fail("invalid", `You have no ${asset} debt to repay.`);
      const all = amount === "all" || Number(amount) >= debtRow.units;
      usd = all ? debtRow.usd : Number(amount) * price.usd;
      const fromMargin = step.slots.source === "margin";
      debtAfter = Math.max(0, (health?.debtUsd ?? 0) - usd);
      if (fromMargin) collateralAfter = Math.max(0, (health?.collateralUsd ?? 0) - usd);
      hfAfterValue = ratio(collateralAfter, debtAfter);
      if (all) {
        amount = debtRow.unitsText;
        notes.push("Repays the full outstanding balance, including interest accrued until it lands.");
      }
      const base = { authority: wallet, asset, ...(all ? { repay_all: true } : { amount }) };
      call = fromMargin
        ? { tool: "vanna_margin_trade", args: { action: "repay", ...base } }
        : { tool: "vanna_margin_trade", args: { action: "repay_from_wallet", payer: wallet, ...base } };
      break;
    }
    case "swap": {
      const to = String(step.slots.to_asset ?? "");
      if (!to) return fail("invalid", "This swap is missing the asset to buy.");
      const target = outTarget(amount);
      if (target) {
        // "Swap SOL to get 100 USDC": size the input from live quotes so the MINIMUM received covers the target.
        const sized = await sizeExactOut(asset, to, Number(target), num(step.slots.slippage_bps) ?? 100, ctx);
        if (!sized.ok) return fail("unavailable", sized.message);
        const available =
          step.slots.mode === "margin" ? (health?.collateral.find((r) => r.symbol === asset)?.units ?? 0) : ((await walletSpendable(asset, ctx)) ?? 0);
        const where = step.slots.mode === "margin" ? "your margin account holds" : "your wallet can spend";
        if (available + 1e-9 < Number(sized.amountIn)) {
          return fail("invalid", `To receive at least ${target} ${to} you need about ${sized.amountIn} ${asset}, and ${where} ${keep(String(available), asset)} ${asset}.`);
        }
        amount = sized.amountIn;
        notes.push(`Sized from a live quote so you receive at least ${target} ${to}: spending ${sized.amountIn} ${asset}, minimum received ${sized.minOut} ${to}.`);
      }
      if (amount === "all") {
        if (step.slots.mode === "margin") {
          const row = health?.collateral.find((r) => r.symbol === asset);
          if (!row || !(row.units > 0)) return fail("invalid", `You have no ${asset} collateral to swap.`);
          amount = row.unitsText;
        } else {
          const spend = await walletSpendable(asset, ctx);
          if (spend === null || !(spend > 0)) return fail("invalid", `Your wallet has no spendable ${asset}.`);
          amount = keep(String(spend), asset);
        }
      }
      usd = Number(amount) * price.usd;
      const slippage = num(step.slots.slippage_bps) ?? 100;
      const swapArgs = { from_asset: asset, to_asset: to, amount: amount as string, slippage_bps: slippage };
      try {
        const q = await mcp.swapQuote(swapArgs, ctx);
        if (num(q.out_amount) !== null) notes.push(`Quote: about ${q.out_amount} ${to} (minimum ${q.min_out_amount}).`);
      } catch {
        /* the build below is the authoritative route check */
      }
      if (step.slots.mode === "margin") {
        let can;
        try {
          can = readCan(await mcp.canSwap({ ...swapArgs, authority: wallet }, ctx));
        } catch (err) {
          return fail("unavailable", humanizeMcpError(err).message);
        }
        if (!can) return fail("unavailable", "I couldn't check this swap against your health factor.");
        if (!can.allowed) return fail("risk", humanizeFailure(can.reason));
        hfAfterValue = can.projectedHf;
        call = { tool: "vanna_swap", args: { action: "margin_swap", authority: wallet, ...swapArgs } };
      } else {
        call = { tool: "vanna_swap", args: { action: "wallet_swap", authority: wallet, ...swapArgs } };
      }
      break;
    }
    case "farm_deposit": {
      const row = health?.collateral.find((r) => r.symbol === asset);
      if (amount === "all") {
        if (!row || !(row.units > 0)) return fail("invalid", `You have no ${asset} collateral in your margin account to farm.`);
        amount = row.unitsText;
      } else if (!row || row.units + 1e-9 < Number(amount)) {
        return fail("invalid", `Your margin account holds ${row ? row.unitsText : "0"} ${asset}, less than ${amount}. Deposit the difference first.`);
      }
      usd = Number(amount) * price.usd;
      call = { tool: "vanna_farm_kamino", args: { action: "deposit", authority: wallet, underlying: asset, amount } };
      notes.push("Converts margin collateral into the Kamino receipt token, which still counts as collateral.");
      break;
    }
    case "farm_redeem": {
      let farm: Record<string, unknown>;
      try {
        farm = await mcp.call("vanna_farm_overview", { action: "positions", authority: wallet }, ctx);
      } catch (err) {
        return fail(isNoAccount(err) ? "no_account" : "unavailable", humanizeMcpError(err).message);
      }
      const list = Array.isArray(farm.positions) ? (farm.positions as Array<Record<string, unknown>>) : [];
      const pos = list.find((p) => typeof p.symbol === "string" && p.symbol.toLowerCase() === `k${asset}`.toLowerCase());
      const receipt = pos ? num(pos.receipt_balance) : null;
      const underlying = pos ? num(pos.underlying_amount) : null;
      if (!pos || receipt === null || underlying === null || !(receipt > 0)) return fail("invalid", `You have no Kamino ${asset} position to redeem.`);
      let underlyingOut: number;
      if (amount === "all" || Number(amount) >= receipt) {
        amount = String(pos.receipt_balance);
        underlyingOut = underlying;
        usd = underlying * price.usd;
      } else {
        underlyingOut = (Number(amount) / receipt) * underlying;
        usd = underlyingOut * price.usd;
      }
      // The amount is in k${asset} receipt tokens, not the underlying: say what it is worth so it is not read as SOL.
      const worth = Number(underlyingOut.toFixed(6));
      notes.push(`That is ${amount} k${asset} receipt tokens, worth about ${worth} ${asset}.`);
      call = { tool: "vanna_farm_kamino", args: { action: "redeem", authority: wallet, underlying: asset, amount } };
      break;
    }
    default:
      return fail("invalid", "That step is not supported.");
  }

  if (!(Number.isFinite(usd) && usd >= 0)) return fail("unavailable", "I couldn't value this action, so it is not allowed.");
  const spend = await checkSpend(user, usd);
  if (!spend.ok) return { ok: false, code: "limit", message: spend.message, limit: spend };

  const risk = riskGate({ increasesRisk: RISK_INCREASING.has(op) && !(op === "swap" && step.slots.mode !== "margin"), hfAfter: hfAfterValue, floor });
  if (risk.decision === "block") return fail("risk", risk.reasons.join(" "));

  const simulation = health
    ? simulationFrom({ health, hfAfter: hfAfterValue, collateralAfter, debtAfter, amountUsd: usd, asset, marginApplicable: true })
    : simulationFrom({
        health: { marginAccount: null, hf: null, collateralUsd: 0, debtUsd: 0, collateral: [], debt: [], isLiquidatable: false, pricesOk: true },
        hfAfter: undefined,
        collateralAfter: 0,
        debtAfter: 0,
        amountUsd: usd,
        asset,
        marginApplicable: false,
      });
  return { ok: true, prepared: { usd, call, risk, simulation, resolvedAmount: amount, notes } };
}

export type BuildResult =
  | { ok: true; tx: UnsignedTx }
  | { ok: false; code: "limit" | "rejected" | "unavailable"; message: string; limit?: LimitDenied };

/** Consumes one write-build from the per-user rate, calls the MCP and accepts only a simulated, signable transaction. */
export async function buildStepTx(prepared: Prepared, ctx: ReadCtx): Promise<BuildResult> {
  const rate = await checkAndConsume(ctx.user, "write");
  if (!rate.ok) return { ok: false, code: "limit", message: rate.message, limit: rate };
  const swap = isSwapBuild(prepared.call);
  for (let attempt = 0; ; attempt++) {
    let raw: Record<string, unknown>;
    try {
      raw = await mcp.call(prepared.call.tool, prepared.call.args, ctx);
    } catch (err) {
      const h = humanizeMcpError(err);
      return { ok: false, code: err instanceof MCPError && err.code && !h.retryable ? "rejected" : "unavailable", message: h.message };
    }
    const env = parseWriteEnvelope(raw);
    if (env.ok) return { ok: true, tx: env.tx };
    // A swap that failed only because the fork's cloned pool state is stale is repaired and rebuilt, as the
    // app's own swap does. A genuine refusal (health, balance, size) does not match and is reported at once.
    if (swap && attempt < MAX_SWAP_HEALS && STALE_FORK_SWAP.test(env.reason)) {
      const healed = await healFromEnvelope(raw);
      await swapHealDeps.sleep(healed > 0 ? 500 : 1500);
      continue;
    }
    return { ok: false, code: "rejected", message: humanizeFailure(env.reason) };
  }
}

/**
 * Read legs: run inline once every write before them has settled. A leg Gemini planned runs its own reads and is
 * answered from them (`investigation/plan-reads.ts`); the health report runs the health read.
 */
export async function runReadStep(step: StoredStep, ctx: ReadCtx): Promise<ReadOutcome> {
  const leg = readLegOf(step);
  if (leg) return answerReadLeg(leg, ctx);
  return runRead({ kind: "health" }, ctx);
}

/**
 * "50% of my X" resolved against the live figure it is a share of, once, when the plan is drawn.
 * The frozen plan then carries an exact amount (only "all" stays live, and says so).
 */
export async function resolvePercent(
  op: StoredStep["op"],
  asset: string,
  pct: number,
  opts: { margin?: boolean },
  ctx: ReadCtx,
): Promise<{ ok: true; amount: string } | { ok: false; message: string }> {
  let base: number | null = null;
  try {
    if (op === "deposit" || op === "earn_supply" || (op === "swap" && !opts.margin)) {
      base = await walletSpendable(asset, ctx);
    } else if (op === "earn_redeem") {
      base = num((await mcp.earnPosition(ctx.user.wallet, asset, ctx)).redeemable_underlying);
    } else if (op === "farm_redeem") {
      const farm = await mcp.call("vanna_farm_overview", { action: "positions", authority: ctx.user.wallet }, ctx);
      const list = Array.isArray(farm.positions) ? (farm.positions as Array<Record<string, unknown>>) : [];
      base = num(list.find((p) => typeof p.symbol === "string" && p.symbol.toLowerCase() === `k${asset}`.toLowerCase())?.receipt_balance);
    } else if (op === "borrow") {
      const s = await sizeSafeBorrow(asset as Asset, ctx);
      if (!s.ok) return { ok: false, message: s.reason };
      base = Number(s.amount);
    } else {
      const h = await loadHealth(ctx);
      if (h.kind === "no_account") return { ok: false, message: "You don't have a margin account yet." };
      if (h.kind !== "ok") return { ok: false, message: "I couldn't read your account to work out that percentage." };
      const rows = op === "repay" ? h.health.debt : h.health.collateral;
      base = rows.find((r) => r.symbol === asset)?.units ?? 0;
    }
  } catch (err) {
    return { ok: false, message: humanizeMcpError(err).message };
  }
  if (base === null) return { ok: false, message: "I couldn't read the balance that percentage applies to." };
  if (!(base > 0)) return { ok: false, message: `You have no ${asset} for that.` };
  const amount = floorDecimals((base * pct) / 100, tokenDecimals(asset));
  if (!(Number(amount) > 0)) return { ok: false, message: "That percentage works out to an amount too small to use." };
  return { ok: true, amount };
}
