/**
 * "Close everything" / "unwind my positions": a plan that exits every position, drawn from live MCP reads.
 *
 * Order is chosen so health can only improve at every step, and so a plan stopped part-way (cancelled, or cut
 * at the step cap) never leaves the account riskier than before:
 *   1. redeem every Kamino position back into the margin account (receipt -> underlying, value unchanged)
 *   2. repay each debt in full: from the margin balance when it covers it, else from the wallet, else first
 *      swap other margin collateral into the debt asset (sized by what must be received) and repay from margin
 *   3. withdraw each remaining collateral to the wallet (only after every debt step)
 *   4. redeem every Earn position
 *   5. close the margin account, only when the user asked for the account to be closed
 * Amounts are "all" and resolved against live balances when each step is built, so accrued interest and the
 * exact Kamino redemption are always current.
 */

import { copilotConfig } from "../config";
import { fmtAmount } from "../explain";
import { LEND_BORROW_ASSETS, RECEIPT_TO_UNDERLYING, type UnwindIntent } from "../intent";
import { mcp } from "../mcp-client";
import { loadHealth, type ReadCtx } from "../mcp-facts";
import { labelFor, MAX_PLAN_STEPS, OUT_PREFIX, planWarnings, type StepSpec } from "../plan";
import { num, tokenDecimals } from "../risk";
import { walletSpendable } from "./steps";
import type { StrategyResult } from "./strategy";

/** Debt keeps accruing between plan and build; cover a little more than today's figure. */
const DEBT_BUFFER = 1.003;
/** Margin collateral left after repaying that is not worth a withdrawal transaction. */
const DUST_UNITS: Record<string, number> = { SOL: 1e-6, USDC: 0.01, USDT: 0.01, JitoSOL: 1e-6, JupSOL: 1e-6 };

const write = (op: StepSpec["op"], asset: string | null, amount: string | null, slots: StepSpec["slots"] = {}): StepSpec => ({ kind: "write", op, asset, amount, slots });

export async function planUnwind(intent: UnwindIntent, ctx: ReadCtx): Promise<StrategyResult> {
  const wantMargin = intent.scope === "all" || intent.scope === "margin";
  const wantFarm = intent.scope === "all" || intent.scope === "margin" || intent.scope === "farm";
  const wantEarn = intent.scope === "all" || intent.scope === "earn";

  const [healthR, farmR, earnR] = await Promise.all([
    wantMargin || wantFarm ? loadHealth(ctx) : Promise.resolve(null),
    wantFarm ? mcp.call("vanna_farm_overview", { action: "positions", authority: ctx.user.wallet }, ctx).catch((e: unknown) => e) : Promise.resolve(null),
    wantEarn
      ? Promise.all(LEND_BORROW_ASSETS.map((a) => mcp.earnPosition(ctx.user.wallet, a, ctx).then((p) => ({ a, p })).catch(() => ({ a, p: null }))))
      : Promise.resolve([] as Array<{ a: string; p: Record<string, unknown> | null }>),
  ]);

  if (healthR && (healthR.kind === "unavailable" || healthR.kind === "malformed")) {
    return { ok: false, message: "I couldn't read your margin account, so I won't draw up an exit plan from partial data. Try again in a moment." };
  }
  const health = healthR?.kind === "ok" ? healthR.health : null;

  const steps: StepSpec[] = [];
  const notes: string[] = [];
  // Projected margin balance per asset as the plan runs (units).
  const margin = new Map<string, number>();
  const isReceipt = (symbol: string) => RECEIPT_TO_UNDERLYING[symbol.toLowerCase()] !== undefined;
  for (const r of health?.collateral ?? []) if (!isReceipt(r.symbol) && r.units > 0) margin.set(r.symbol, r.units);

  // 0. Phoenix perps: close every position, then bring the USDC back into the margin account (it then repays like any
  // other margin USDC).
  if (wantMargin && health?.collateral.some((r) => r.symbol === "Phoenix")) {
    try {
      const perps = await mcp.perpsPositions(ctx.user.wallet, ctx);
      const open = Array.isArray(perps.positions) ? (perps.positions as Array<Record<string, unknown>>) : [];
      for (const p of open) {
        steps.push({ kind: "write", op: "perp_close", asset: null, amount: null, slots: { market: String(p.market) } });
      }
      steps.push({ kind: "write", op: "perp_withdraw", asset: null, amount: "all", slots: {} });
      const back = Number(perps.phoenix_value_usd ?? 0);
      if (back > 0) margin.set("USDC", (margin.get("USDC") ?? 0) + back);
      notes.push("Your Phoenix perps are closed first and their USDC comes back to the margin account.");
    } catch {
      return { ok: false, message: "I couldn't read your Phoenix perps, so I won't draw up an exit plan from partial data. Try again in a moment." };
    }
  }

  // 1. Kamino
  if (wantFarm && health && farmR && !(farmR instanceof Error) && typeof farmR === "object") {
    const list = Array.isArray((farmR as Record<string, unknown>).positions) ? ((farmR as Record<string, unknown>).positions as Array<Record<string, unknown>>) : [];
    for (const p of list) {
      const symbol = typeof p.symbol === "string" ? p.symbol : "";
      const underlying = RECEIPT_TO_UNDERLYING[symbol.toLowerCase()];
      const receipt = num(p.receipt_balance);
      if (!underlying || receipt === null || !(receipt > 0)) continue;
      steps.push(write("farm_redeem", underlying, "all"));
      margin.set(underlying, (margin.get(underlying) ?? 0) + (num(p.underlying_amount) ?? 0));
    }
  }

  // 2. Debts
  if (wantMargin && health) {
    for (const d of health.debt) {
      if (!(d.units > 0)) continue;
      const need = d.units * DEBT_BUFFER;
      const held = margin.get(d.symbol) ?? 0;
      if (held >= need) {
        steps.push(write("repay", d.symbol, "all", { source: "margin" }));
        margin.set(d.symbol, held - d.units);
        continue;
      }
      const inWallet = (await walletSpendable(d.symbol, ctx)) ?? 0;
      if (inWallet >= need) {
        steps.push(write("repay", d.symbol, "all", { source: "wallet" }));
        continue;
      }
      // Swap the shortfall in from the most valuable other margin collateral, then repay from margin.
      const shortfall = (need - held) * 1.01;
      const price = d.priceUsd ?? (d.units > 0 ? d.usd / d.units : 0);
      const candidates = [...margin.entries()]
        .filter(([sym, units]) => sym !== d.symbol && units > 0)
        .map(([sym, units]) => {
          const row = health.collateral.find((r) => r.symbol === sym);
          const px = row?.priceUsd ?? (row && row.units > 0 ? row.usd / row.units : 0);
          return { sym, units, usd: units * px };
        })
        .sort((x, y) => y.usd - x.usd);
      const source = candidates.find((c) => c.usd >= shortfall * price * 1.03);
      if (!source) {
        return {
          ok: false,
          message:
            `I can't fully repay your ${fmtAmount(d.unitsText, d.symbol)} debt from your balances: your margin account holds ` +
            `${fmtAmount(String(held), d.symbol)} and your wallet ${fmtAmount(String(inWallet), d.symbol)}. ` +
            `Add ${d.symbol} to your wallet or margin account, then ask again.`,
        };
      }
      const target = shortfall.toFixed(tokenDecimals(d.symbol)).replace(/\.?0+$/, "");
      steps.push(write("swap", source.sym, `${OUT_PREFIX}${target}`, { to_asset: d.symbol, mode: "margin", slippage_bps: 100 }));
      steps.push(write("repay", d.symbol, "all", { source: "margin" }));
      notes.push(`Your margin account is short of ${d.symbol} to repay in full, so ${source.sym} collateral is swapped into about ${target} ${d.symbol} first.`);
      margin.set(d.symbol, 0);
    }

    // 3. Collateral
    for (const [sym, units] of margin.entries()) {
      if (units > (DUST_UNITS[sym] ?? 1e-6)) steps.push(write("withdraw", sym, "all"));
    }
  }

  // 4. Earn
  if (wantEarn) {
    for (const { a, p } of earnR as Array<{ a: string; p: Record<string, unknown> | null }>) {
      if (p && (num(p.share_balance) ?? 0) > 0) steps.push(write("earn_redeem", a, "all"));
    }
  }

  // 5. Account
  if (intent.close_account && wantMargin && health) steps.push(write("close_account", null, null));

  if (!steps.length) {
    const where = { all: "", earn: " in the Earn pools", farm: " on Kamino", margin: " in your margin account" }[intent.scope];
    return { ok: false, message: `You have no open positions${where} to close.` };
  }

  // The step cap: never cut between a swap and the repay it funds.
  let kept = steps;
  if (steps.length > MAX_PLAN_STEPS) {
    let cut = MAX_PLAN_STEPS;
    if (steps[cut - 1].op === "swap") cut -= 1;
    kept = steps.slice(0, cut);
    notes.push(`Closing everything takes ${steps.length} steps; this plan covers the first ${cut}. Ask again afterwards and I'll plan the rest.`);
  }

  const summary = `Unwind: ${kept.map((s) => labelFor(s).replace(/^./, (c) => c.toLowerCase())).join(", then ")}.`;
  return {
    ok: true,
    plan: {
      summary,
      steps: kept,
      warnings: planWarnings(kept, notes),
      simulation: null,
      hfFloor: copilotConfig.minHealthFactor,
    },
  };
}
