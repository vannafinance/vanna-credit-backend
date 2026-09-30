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
import { loadHealth, loadPrice, runRead, sizeSafeBorrow, sizeSafeWithdraw, type ReadCtx, type ReadOutcome } from "../mcp-facts";
import { RISK_INCREASING } from "../plan";
import { floorDecimals, hfAfter as ratio, num, readCan, riskGate, simulationFrom, tokenDecimals } from "../risk";
import type { RiskResult, Simulation, UnsignedTx } from "../types";
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
  const price = await loadPrice(asset, ctx);
  if (!price) return fail("unavailable", `The ${asset} price is unavailable, so I can't value this action against your limits.`);
  if (price.stale) return fail("unavailable", `The ${asset} price is stale right now, so I won't build this. Try again in a minute.`);

  let amount = step.amount;
  const margin = op === "deposit" || op === "withdraw" || op === "borrow" || op === "repay" || op === "farm_deposit" || op === "farm_redeem" || (op === "swap" && step.slots.mode === "margin");
  const healthR = margin ? await loadHealth(ctx) : null;
  if (healthR && healthR.kind === "no_account") return fail("no_account", "You don't have a margin account yet. Open one first.");
  if (healthR && healthR.kind !== "ok") return fail("unavailable", "I couldn't read your margin account just now, so I'm not building this.");
  const health = healthR && healthR.kind === "ok" ? healthR.health : null;

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
      if (amount === "all" || Number(amount) >= receipt) {
        amount = String(pos.receipt_balance);
        usd = underlying * price.usd;
      } else {
        usd = ((Number(amount) / receipt) * underlying) * price.usd;
      }
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
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.call(prepared.call.tool, prepared.call.args, ctx);
  } catch (err) {
    const h = humanizeMcpError(err);
    return { ok: false, code: err instanceof MCPError && err.code && !h.retryable ? "rejected" : "unavailable", message: h.message };
  }
  const env = parseWriteEnvelope(raw);
  if (!env.ok) return { ok: false, code: "rejected", message: humanizeFailure(env.reason) };
  return { ok: true, tx: env.tx };
}

/** Read legs ("report"): run inline once every write before them has settled. */
export async function runReadStep(_step: StoredStep, ctx: ReadCtx): Promise<ReadOutcome> {
  // The only read leg the planner emits is the closing health report.
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
