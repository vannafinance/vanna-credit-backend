/**
 * Deterministic risk and sizing. Every number here is arithmetic on values the MCP returned;
 * nothing is defaulted, and an unreadable input makes the caller refuse rather than guess.
 *
 * Health model (vanna_core/math_utils.py, program `math/health.rs`): HF = collateral_usd / debt_usd,
 * liquidatable at HF <= 1.10, no debt = HF null. Borrowed funds stay in the margin vault and count
 * as collateral. The Copilot sizes to a 1.15 floor (policy, `copilotConfig.minHealthFactor`).
 */

import type { RiskResult, Simulation } from "./types";

export const LIQUIDATION_HF = 1.1;
/** Ratio above the floor that is still flagged as thin. */
export const THIN_BUFFER = 0.1;
/** Slippage the lever plan assumes the swap may cost (matches the MCP's default `slippage_bps`). */
export const DEFAULT_SLIPPAGE_BPS = 100;

// ── Reading MCP numbers ─────────────────────────────────────────────────────

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface PositionRow {
  symbol: string;
  /** Token units (ui_balance / ui_debt). */
  units: number;
  usd: number;
  priceUsd: number | null;
  /** The MCP's own decimal string, kept for display at full precision. */
  unitsText: string;
}

export interface HealthRead {
  marginAccount: string | null;
  /** null = no debt. */
  hf: number | null;
  collateralUsd: number;
  debtUsd: number;
  collateral: PositionRow[];
  debt: PositionRow[];
  isLiquidatable: boolean;
  pricesOk: boolean;
}

function rows(raw: unknown, unitsKey: "ui_balance" | "ui_debt"): PositionRow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PositionRow[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    const units = num(o[unitsKey]);
    const usd = num(o.usd_value);
    if (typeof o.symbol !== "string" || units === null || usd === null) return null;
    const price = o.price && typeof o.price === "object" ? num((o.price as Record<string, unknown>).usd) : null;
    out.push({ symbol: o.symbol, units, usd, priceUsd: price, unitsText: String(o[unitsKey]) });
  }
  return out;
}

/** Strict read of `vanna_account health`. Null when any required field is missing or malformed. */
export function readHealth(raw: Record<string, unknown>): HealthRead | null {
  if (!("health_factor" in raw)) return null;
  const collateralUsd = num(raw.total_collateral_usd);
  const debtUsd = num(raw.total_debt_usd);
  const collateral = rows(raw.collateral, "ui_balance");
  const debt = rows(raw.debt, "ui_debt");
  if (collateralUsd === null || debtUsd === null || !collateral || !debt) return null;
  let hf: number | null = null;
  if (raw.health_factor !== null) {
    hf = num(raw.health_factor);
    if (hf === null) return null;
  }
  if (hf === null && debtUsd > 0) return null;
  return {
    marginAccount: typeof raw.margin_account === "string" ? raw.margin_account : null,
    hf,
    collateralUsd,
    debtUsd,
    collateral,
    debt,
    isLiquidatable: raw.is_liquidatable === true,
    pricesOk: raw.price_checks_pass !== false,
  };
}

/** Reads `projected_health_factor` of a can_borrow / can_withdraw / can_swap result. */
export interface CanResult {
  allowed: boolean;
  reason: string | null;
  /** undefined = the MCP did not report one; null = no debt after the action. */
  projectedHf: number | null | undefined;
  currentHf: number | null | undefined;
}

export function readCan(raw: Record<string, unknown>): CanResult | null {
  if (typeof raw.allowed !== "boolean") return null;
  const f = (k: string): number | null | undefined => (!(k in raw) ? undefined : raw[k] === null ? null : (num(raw[k]) ?? undefined));
  return {
    allowed: raw.allowed,
    reason: typeof raw.reason === "string" ? raw.reason : null,
    projectedHf: f("projected_health_factor"),
    currentHf: f("current_health_factor"),
  };
}

// ── Formatting (display only; never fed back into an amount) ────────────────

/** Round DOWN to `dp` decimals as a plain decimal string (no exponent, trailing zeros trimmed). */
export function floorDecimals(n: number, dp: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const f = 10 ** dp;
  const v = Math.floor(n * f + 1e-9) / f;
  const s = v.toFixed(dp);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export function tokenDecimals(symbol: string): number {
  return symbol === "USDC" || symbol === "USDT" ? 6 : 9;
}

export function usdToUnits(usd: number, priceUsd: number, symbol: string): string {
  if (!(priceUsd > 0)) return "0";
  return floorDecimals(usd / priceUsd, tokenDecimals(symbol));
}

// ── Sizing ───────────────────────────────────────────────────────────────────

/** Largest USD borrow that keeps HF >= h. The borrowed asset counts as collateral when `borrowedIsCollateral`. */
export function maxBorrowUsd(c: number, d: number, h: number, borrowedIsCollateral = true): number {
  const x = borrowedIsCollateral ? (c - h * d) / (h - 1) : c / h - d;
  return Math.max(0, x);
}

/** Largest USD of collateral that can leave while HF stays >= h. With no debt everything can leave. */
export function maxWithdrawUsd(c: number, d: number, h: number): number {
  if (d <= 0) return c;
  return Math.max(0, c - h * d);
}

export function hfAfter(c: number, d: number): number | null {
  return d > 0 ? c / d : null;
}

/** Highest leverage on `equityUsd` that holds HF >= h given existing collateral/debt and swap slippage. */
export function maxLeverage(args: {
  collateralUsd: number;
  debtUsd: number;
  equityUsd: number;
  /** USD of new collateral added from the wallet before borrowing (0 when levering the existing balance). */
  depositUsd: number;
  floor: number;
  slippageBps: number;
}): number {
  const { collateralUsd, debtUsd, equityUsd, depositUsd, floor, slippageBps } = args;
  if (!(equityUsd > 0)) return 1;
  const s = 1 - slippageBps / 10_000;
  const c0 = collateralUsd + depositUsd;
  // HF = (c0 + b*s) / (debtUsd + b) >= floor  =>  b <= (c0 - floor*debt) / (floor - s)
  const denom = floor - s;
  const b = denom > 0 ? (c0 - floor * debtUsd) / denom : Infinity;
  if (!(b > 0)) return 1;
  return 1 + b / equityUsd;
}

export interface LeverSize {
  ok: true;
  borrowUsd: number;
  hfAfter: number;
}
export interface LeverRefusal {
  ok: false;
  reason: string;
  /** Highest leverage that would hold the floor, when at least a little is possible. */
  maxLeverage: number | null;
}

/**
 * "Lever X Nx": borrow (N-1) x equity in a stable, swap it to X inside the margin account.
 * Worst case HF is taken with the swap at its minimum received (slippage), so the floor holds
 * even when the quote moves against the user.
 */
export function sizeLever(args: {
  collateralUsd: number;
  debtUsd: number;
  equityUsd: number;
  depositUsd: number;
  leverage: number;
  floor: number;
  slippageBps?: number;
}): LeverSize | LeverRefusal {
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const { collateralUsd, debtUsd, equityUsd, depositUsd, leverage, floor } = args;
  if (!(equityUsd > 0)) return { ok: false, reason: "There is no balance of that asset to lever.", maxLeverage: null };
  const borrowUsd = (leverage - 1) * equityUsd;
  const s = 1 - slippageBps / 10_000;
  const worst = hfAfter(collateralUsd + depositUsd + borrowUsd * s, debtUsd + borrowUsd);
  if (worst !== null && worst < floor) {
    const max = maxLeverage({ collateralUsd, debtUsd, equityUsd, depositUsd, floor, slippageBps });
    // Round DOWN to one decimal so the offered figure is itself safe.
    const safe = Math.floor(max * 10) / 10;
    return {
      ok: false,
      reason: `${leverage}x would take your health factor to about ${worst.toFixed(2)}, below the ${floor} floor.`,
      maxLeverage: safe > 1 ? safe : null,
    };
  }
  return { ok: true, borrowUsd, hfAfter: worst ?? Infinity };
}

// ── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Risk decision for one action. Only actions that can lower health are gated; an action that
 * adds collateral or repays debt is always allowed, even from an unhealthy account (that is how
 * the user gets out).
 */
export function riskGate(args: {
  increasesRisk: boolean;
  /** undefined = unknown (fail closed); null = no debt afterwards. */
  hfAfter: number | null | undefined;
  floor: number;
}): RiskResult {
  if (!args.increasesRisk) return { decision: "allow", reasons: [], projected_health_factor: args.hfAfter ?? null };
  if (args.hfAfter === undefined) {
    return {
      decision: "block",
      reasons: ["I could not get a projected health factor for this action, so I will not build it."],
      projected_health_factor: null,
    };
  }
  if (args.hfAfter === null) return { decision: "allow", reasons: [], projected_health_factor: null };
  if (args.hfAfter < args.floor) {
    return {
      decision: "block",
      reasons: [
        `This would take your health factor to ${args.hfAfter.toFixed(2)}, below the ${args.floor.toFixed(2)} safety floor (liquidation is at ${LIQUIDATION_HF.toFixed(2)}).`,
      ],
      projected_health_factor: args.hfAfter,
    };
  }
  if (args.hfAfter < args.floor + THIN_BUFFER) {
    return {
      decision: "needs_confirmation",
      reasons: [`Your health factor would be ${args.hfAfter.toFixed(2)}, close to the ${args.floor.toFixed(2)} floor. A small price move could push it lower.`],
      projected_health_factor: args.hfAfter,
    };
  }
  return { decision: "allow", reasons: [], projected_health_factor: args.hfAfter };
}

export function simulationFrom(args: {
  health: HealthRead;
  hfAfter: number | null | undefined;
  collateralAfter: number;
  debtAfter: number;
  amountUsd: number;
  asset: string | null;
  marginApplicable: boolean;
}): Simulation {
  return {
    hf_before: args.health.hf,
    hf_after: args.hfAfter ?? null,
    collateral_before: args.health.collateralUsd,
    collateral_after: Math.max(0, args.collateralAfter),
    debt_before: args.health.debtUsd,
    debt_after: Math.max(0, args.debtAfter),
    liquidation_threshold: LIQUIDATION_HF,
    amount_usd: args.amountUsd,
    asset: args.asset,
    margin_applicable: args.marginApplicable,
  };
}
