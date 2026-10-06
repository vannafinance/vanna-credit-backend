/**
 * `simulate`: the account's health under any scenario Gemini describes. Price moves on any assets ("SOL drops 10%"),
 * hypothetical position changes (deposit, withdraw, borrow, repay, swap, farm), or both, in the order given.
 *
 * It starts from the live margin account (or an empty one) and applies the protocol's own health model
 * (HF = collateral USD / debt USD at oracle prices; liquidation at HF <= 1.10; borrowed tokens stay as collateral),
 * the same as `risk.ts` and the program's `risk_engine.rs`. Nothing is built or sent. Swaps are valued at oracle prices
 * with no slippage and farming moves value into its Kamino receipt unchanged; the result says so.
 */

import { copilotConfig } from "../config";
import { normalizeAsset, parseDecimalString, receiptUnderlying, type Asset } from "../intent";
import { loadFreshPrice, loadHealth, type ReadCtx } from "../mcp-facts";
import { LIQUIDATION_HF } from "../risk";

export const SIM_OPS = ["deposit", "withdraw", "borrow", "repay", "swap", "farm_deposit", "farm_redeem"] as const;
type SimOp = (typeof SIM_OPS)[number];

export interface SimChange {
  op: SimOp;
  asset: string;
  to_asset?: string;
  /** Token units, or "all". */
  amount?: string;
  /** A dollar value instead of units. */
  usd?: string;
}
export interface SimPriceMove {
  asset: string;
  /** -10 = the price falls 10%; 25 = it rises 25%. */
  percent: number;
}

/** Why these arguments can't be simulated, or null. */
export function simulateArgsProblem(args: Record<string, unknown>): string | null {
  const moves = Array.isArray(args.price_changes) ? args.price_changes : [];
  const changes = Array.isArray(args.changes) ? args.changes : [];
  if (!moves.length && !changes.length) return "simulate needs price_changes, changes, or both";
  if (moves.length > 12 || changes.length > 12) return "simulate takes at most 12 price changes and 12 changes";
  for (const m of moves as Array<Record<string, unknown>>) {
    if (!m || typeof m.asset !== "string" || !normalizeAsset(m.asset)) return `price_changes: ${String(m?.asset)} is not a product asset`;
    const p = typeof m.percent === "number" ? m.percent : Number(m.percent);
    if (!Number.isFinite(p) || p <= -100 || p > 1000) return "price_changes: percent must be above -100 (e.g. -10 for a 10% drop)";
  }
  for (const c of changes as Array<Record<string, unknown>>) {
    if (!c || !SIM_OPS.includes(c.op as SimOp)) return `changes: op must be one of ${SIM_OPS.join(", ")}`;
    if (typeof c.asset !== "string" || !normalizeAsset(c.asset)) return `changes: ${String(c?.asset)} is not a product asset`;
    if (c.op === "swap" && (typeof c.to_asset !== "string" || !normalizeAsset(c.to_asset))) return "changes: a swap needs to_asset";
    const amount = typeof c.amount === "string" ? c.amount.trim() : typeof c.amount === "number" ? String(c.amount) : "";
    const usd = typeof c.usd === "string" ? c.usd.trim().replace(/^\$/, "") : typeof c.usd === "number" ? String(c.usd) : "";
    if (!(amount === "all" || parseDecimalString(amount)) && !parseDecimalString(usd)) return `changes: ${c.op} ${c.asset} needs an amount (token units or "all") or usd`;
  }
  return null;
}

interface State {
  collateral: Map<string, number>; // symbol -> units
  debt: Map<string, number>;
}

const usd2 = (n: number) => n.toFixed(2);
const hfText = (c: number, d: number) => (d > 0 ? (c / d).toFixed(4) : null);

/** Collateral that moves with `asset`'s price: the asset itself and its Kamino receipt. */
const tracks = (symbol: string, asset: string) => symbol === asset || receiptUnderlying(symbol) === asset;

export async function simulate(args: Record<string, unknown>, ctx: ReadCtx): Promise<{ ok: boolean; result: unknown }> {
  const problem = simulateArgsProblem(args);
  if (problem) return { ok: false, result: { error: problem } };
  const h = await loadHealth(ctx);
  if (h.kind === "unavailable" || h.kind === "malformed") return { ok: false, result: { error: "account data unavailable" } };

  const state: State = { collateral: new Map(), debt: new Map() };
  const price = new Map<string, number>();
  if (h.kind === "ok") {
    for (const r of h.health.collateral) {
      state.collateral.set(r.symbol, (state.collateral.get(r.symbol) ?? 0) + r.units);
      if (r.units > 0) price.set(r.symbol, r.priceUsd ?? r.usd / r.units);
    }
    for (const r of h.health.debt) {
      state.debt.set(r.symbol, (state.debt.get(r.symbol) ?? 0) + r.units);
      if (r.units > 0 && !price.has(r.symbol)) price.set(r.symbol, r.priceUsd ?? r.usd / r.units);
    }
  }
  const priceOf = async (symbol: string): Promise<number | null> => {
    if (price.has(symbol)) return price.get(symbol) as number;
    const p = await loadFreshPrice(symbol as Asset, ctx);
    if (!p) return null;
    price.set(symbol, p.usd);
    return p.usd;
  };
  const value = (s: State, px: Map<string, number>) => {
    let c = 0;
    let d = 0;
    for (const [sym, u] of s.collateral) c += u * (px.get(sym) ?? 0);
    for (const [sym, u] of s.debt) d += u * (px.get(sym) ?? 0);
    return { c, d };
  };
  const snapshot = (s: State, px: Map<string, number>) => {
    const { c, d } = value(s, px);
    const hf = d > 0 ? c / d : null;
    return {
      collateral_usd: usd2(c),
      debt_usd: usd2(d),
      health_factor: hfText(c, d),
      liquidatable: hf !== null && hf <= LIQUIDATION_HF,
      below_copilot_floor: hf !== null && hf < copilotConfig.minHealthFactor,
      collateral: [...s.collateral].filter(([, u]) => u > 1e-12).map(([sym, u]) => ({ symbol: sym, units: Number(u.toFixed(9)), usd: usd2(u * (px.get(sym) ?? 0)) })),
      debt: [...s.debt].filter(([, u]) => u > 1e-12).map(([sym, u]) => ({ symbol: sym, units: Number(u.toFixed(9)), usd: usd2(u * (px.get(sym) ?? 0)) })),
    };
  };

  const before = h.kind === "ok" ? snapshot(state, price) : null;
  const notes: string[] = [];
  if (h.kind === "no_account") notes.push("No margin account yet: the simulation starts from an empty account.");

  // Position changes, in order, at today's prices.
  for (const raw of (Array.isArray(args.changes) ? args.changes : []) as Array<Record<string, unknown>>) {
    const op = raw.op as SimOp;
    const asset = normalizeAsset(String(raw.asset)) as string;
    const p = await priceOf(asset);
    if (p === null) return { ok: false, result: { error: `${asset} price unavailable` } };
    const amountText = typeof raw.amount === "string" ? raw.amount.trim() : typeof raw.amount === "number" ? String(raw.amount) : "";
    const usdText = typeof raw.usd === "string" ? raw.usd.trim().replace(/^\$/, "") : typeof raw.usd === "number" ? String(raw.usd) : "";
    const receipt = `k${asset}`;
    const heldFor = (o: SimOp) => (o === "repay" ? state.debt.get(asset) ?? 0 : o === "farm_redeem" ? (state.collateral.get(receipt) ?? 0) : state.collateral.get(asset) ?? 0);
    let units = amountText === "all" ? heldFor(op) : parseDecimalString(amountText) ? Number(amountText) : Number(usdText) / p;
    if (!(units > 0)) return { ok: false, result: { error: `${op} ${asset}: nothing to move` } };
    const add = (m: Map<string, number>, k: string, u: number) => m.set(k, (m.get(k) ?? 0) + u);
    switch (op) {
      case "deposit":
        add(state.collateral, asset, units);
        break;
      case "borrow":
        add(state.debt, asset, units);
        add(state.collateral, asset, units); // borrowed tokens stay in the margin account
        break;
      case "withdraw":
      case "repay": {
        const held = heldFor(op);
        if (units > held + 1e-9) return { ok: false, result: { error: `${op} ${asset}: the account holds ${held} ${op === "repay" ? "of debt" : ""}`.trim() } };
        if (op === "withdraw") add(state.collateral, asset, -units);
        else {
          add(state.debt, asset, -units);
          if (raw.source === "margin") add(state.collateral, asset, -Math.min(units, state.collateral.get(asset) ?? 0));
        }
        break;
      }
      case "swap": {
        const to = normalizeAsset(String(raw.to_asset)) as string;
        const pt = await priceOf(to);
        if (pt === null) return { ok: false, result: { error: `${to} price unavailable` } };
        const held = state.collateral.get(asset) ?? 0;
        if (units > held + 1e-9) return { ok: false, result: { error: `swap ${asset}: the margin account holds ${held}` } };
        add(state.collateral, asset, -units);
        add(state.collateral, to, (units * p) / pt);
        if (!notes.includes("Swaps are valued at oracle prices, before slippage and fees.")) notes.push("Swaps are valued at oracle prices, before slippage and fees.");
        break;
      }
      case "farm_deposit":
      case "farm_redeem": {
        // Farming keeps the value as collateral; the receipt is tracked in underlying-equivalent units here.
        if (!price.has(receipt) || !state.collateral.has(receipt)) price.set(receipt, p);
        const pr = price.get(receipt) as number;
        if (op === "farm_deposit") {
          const held = state.collateral.get(asset) ?? 0;
          if (units > held + 1e-9) return { ok: false, result: { error: `farm ${asset}: the margin account holds ${held}` } };
          add(state.collateral, asset, -units);
          add(state.collateral, receipt, (units * p) / pr);
        } else {
          const held = state.collateral.get(receipt) ?? 0;
          const rUnits = amountText === "all" ? held : (units * p) / pr;
          if (rUnits > held + 1e-9) return { ok: false, result: { error: `farm redeem ${asset}: the account holds ${held} ${receipt}` } };
          add(state.collateral, receipt, -rUnits);
          add(state.collateral, asset, (rUnits * pr) / p);
          units = (rUnits * pr) / p;
        }
        if (!notes.includes("Farming keeps the value as collateral (Kamino interest not included).")) notes.push("Farming keeps the value as collateral (Kamino interest not included).");
        break;
      }
    }
  }
  const afterChanges = (args.changes as unknown[] | undefined)?.length ? snapshot(state, price) : null;

  // Price moves on top. A Kamino receipt moves with its underlying; liquid-staking tokens have their own prices.
  const moves = ((Array.isArray(args.price_changes) ? args.price_changes : []) as Array<Record<string, unknown>>).map((m) => ({
    asset: normalizeAsset(String(m.asset)) as string,
    percent: typeof m.percent === "number" ? m.percent : Number(m.percent),
  }));
  let afterPrices = null;
  const toLiquidation: Array<Record<string, unknown>> = [];
  if (moves.length) {
    for (const m of moves) await priceOf(m.asset);
    const shocked = new Map(price);
    for (const [sym, p] of price) {
      const m = moves.find((x) => tracks(sym, x.asset));
      if (m) shocked.set(sym, p * (1 + m.percent / 100));
    }
    afterPrices = { ...snapshot(state, shocked), price_changes: moves.map((m) => ({ asset: m.asset, percent: m.percent, price_before: usd2(price.get(m.asset) ?? 0), price_after: usd2((price.get(m.asset) ?? 0) * (1 + m.percent / 100)) })) };
    // How far each moved asset alone could fall (from the post-change position) before HF reaches the liquidation line:
    // HF(k) = (C_other + k*C_a) / (D_other + k*D_a) = L  ->  k = (L*D_other - C_other) / (C_a - L*D_a).
    for (const m of moves) {
      let ca = 0, co = 0, da = 0, dOther = 0;
      for (const [sym, u] of state.collateral) (tracks(sym, m.asset) ? (ca += u * (price.get(sym) ?? 0)) : (co += u * (price.get(sym) ?? 0)));
      for (const [sym, u] of state.debt) (tracks(sym, m.asset) ? (da += u * (price.get(sym) ?? 0)) : (dOther += u * (price.get(sym) ?? 0)));
      if (da + dOther <= 0) {
        toLiquidation.push({ asset: m.asset, note: "no debt, so no price move can liquidate the account" });
        continue;
      }
      const denom = ca - LIQUIDATION_HF * da;
      const k = denom !== 0 ? (LIQUIDATION_HF * dOther - co) / denom : NaN;
      if (denom > 0 && k > 0 && k < 1) toLiquidation.push({ asset: m.asset, drop_to_liquidation_percent: ((1 - k) * 100).toFixed(2), liquidation_price: usd2((price.get(m.asset) ?? 0) * k) });
      else if (denom > 0 && k >= 1) toLiquidation.push({ asset: m.asset, note: "already at or below the liquidation line at today's prices" });
      else if (denom < 0 && k > 1) toLiquidation.push({ asset: m.asset, rise_to_liquidation_percent: ((k - 1) * 100).toFixed(2), liquidation_price: usd2((price.get(m.asset) ?? 0) * k) });
      else toLiquidation.push({ asset: m.asset, note: `no move in ${m.asset} alone liquidates the account` });
    }
  }

  return {
    ok: true,
    result: {
      model: `HF = collateral USD / debt USD at oracle prices; liquidation at HF <= ${LIQUIDATION_HF.toFixed(2)}; the Copilot's floor is ${copilotConfig.minHealthFactor.toFixed(2)}`,
      now: before,
      ...(afterChanges ? { after_changes: afterChanges } : {}),
      ...(afterPrices ? { after_price_changes: afterPrices } : {}),
      ...(toLiquidation.length ? { price_move_to_liquidation: toLiquidation } : {}),
      ...(notes.length ? { notes } : {}),
    },
  };
}
