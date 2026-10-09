/**
 * What-if engine. Pure and read-only: it reprices a SAVED baseline (the collateral and debt lines
 * of accounts the server could value) under the user's assumptions. It never transacts, never
 * touches chain state and never invents inputs. Outputs are simulated estimates.
 *
 * Model "immediate-repricing-v1": a shock moves every line priced off that asset at once
 * (collateral AND debt; a Kamino receipt moves with its underlying, its exchange rate held fixed).
 * Collateral rounds down and debt rounds up (in nano-USD) so rounding never flatters the result.
 * No interest, no liquidations executing, no recovery: those are NOT modelled and are stated so.
 */
import { LIQUIDATION_LINE } from "./risk";
import type { CollateralLine, DebtLine } from "./types";

export const WHATIF_MODEL = "immediate-repricing-v1";
const NANO = 1_000_000_000n;
const nanos = (usd: number) => BigInt(Math.round(usd * 1e9));

export interface BaselineAccount {
  owner: string;
  address: string;
  collateral: CollateralLine[];
  debts: DebtLine[];
  collateralUsd: number | null;
  debtUsd: number | null;
}

export interface Side {
  collateral: number;
  debt: number;
  equity: number;
  health: number | null;
  noDebt: boolean;
  /** Liquidation eligibility (health at or below the line) — NOT the same as loss. */
  eligible: boolean;
  /** Debt not covered by collateral. */
  shortfall: number;
}

export interface AccountResult { owner: string; address: string; baseline: Side; result: Side; affected: number }

export interface SimulationResult {
  model: string;
  shocks: Record<string, number>;
  covered: AccountResult[];
  baseline: Totals;
  result: Totals;
}
export interface Totals {
  accounts: number;
  collateral: number;
  debt: number;
  eligibleCount: number;
  eligibleDebt: number;
  shortfall: number;
  underwaterCount: number;
  averageHealth: number | null;
}

const LINE_WAD = BigInt(Math.round(LIQUIDATION_LINE * 1e6)); // 1.10 → 1_100_000 (per 1e6)

function side(C: bigint, D: bigint): Side {
  const noDebt = D === 0n;
  const eligible = !noDebt && C * 1_000_000n <= LINE_WAD * D;
  return {
    collateral: Number(C) / 1e9, debt: Number(D) / 1e9, equity: Number(C - D) / 1e9,
    health: noDebt ? null : Number((C * NANO) / D) / 1e9, noDebt, eligible,
    shortfall: Number(D > C ? D - C : 0n) / 1e9,
  };
}

/** Validates user-entered percentages (−100 … +500). */
export function validateShocks(shocks: Record<string, number>): string | null {
  for (const [, p] of Object.entries(shocks)) {
    if (!Number.isFinite(p) || p < -100 || p > 500) return "Enter price changes between −100% and +500%.";
  }
  return null;
}

export function simulateAccount(account: BaselineAccount, shocks: Record<string, number>): AccountResult {
  const factors = new Map(Object.entries(shocks).filter(([, p]) => p !== 0).map(([s, p]) => [s, BigInt(Math.round((1 + p / 100) * 1e6))]));
  let C = 0n, D = 0n, affected = 0;
  for (const l of account.collateral) {
    const v = nanos(l.usd), f = factors.get(l.underlying);
    C += f !== undefined ? (v * f) / 1_000_000n : v;
    if (f !== undefined) affected++;
  }
  for (const l of account.debts) {
    const v = nanos(l.usd), f = factors.get(l.symbol);
    D += f !== undefined ? (v * f + 999_999n) / 1_000_000n : v;
    if (f !== undefined) affected++;
  }
  const baselineC = account.collateral.reduce((a, l) => a + nanos(l.usd), 0n);
  const baselineD = account.debts.reduce((a, l) => a + nanos(l.usd), 0n);
  return { owner: account.owner, address: account.address, baseline: side(baselineC, baselineD), result: side(C, D), affected };
}

function totals(sides: Side[]): Totals {
  const debtors = sides.filter((s) => !s.noDebt);
  const debtSum = debtors.reduce((a, s) => a + s.debt, 0);
  return {
    accounts: sides.length,
    collateral: sides.reduce((a, s) => a + s.collateral, 0),
    debt: sides.reduce((a, s) => a + s.debt, 0),
    eligibleCount: sides.filter((s) => s.eligible).length,
    eligibleDebt: sides.filter((s) => s.eligible).reduce((a, s) => a + s.debt, 0),
    shortfall: sides.reduce((a, s) => a + s.shortfall, 0),
    underwaterCount: sides.filter((s) => s.shortfall > 0).length,
    averageHealth: debtSum > 0 ? debtors.reduce((a, s) => a + s.collateral, 0) / debtSum : null,
  };
}

/** Runs one shock set over every covered account. */
export function simulate(accounts: BaselineAccount[], shocks: Record<string, number>): SimulationResult {
  const error = validateShocks(shocks);
  if (error) throw new Error(error);
  const covered = accounts.map((a) => simulateAccount(a, shocks));
  return {
    model: WHATIF_MODEL,
    shocks: Object.fromEntries(Object.entries(shocks).filter(([, p]) => p !== 0)),
    covered,
    baseline: totals(covered.map((c) => c.baseline)),
    result: totals(covered.map((c) => c.result)),
  };
}

/** Liquidity withdrawal: what share of a requested withdrawal the pool's cash can honour right now. */
export function simulateWithdrawal(pool: { totalSupplied: number; availableLiquidity: number }, percent: number) {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("Withdrawal assumption must be between 0% and 100%.");
  if (!(pool.totalSupplied >= 0) || !(pool.availableLiquidity >= 0)) throw new Error("Valid pool balances are required.");
  const requested = (pool.totalSupplied * percent) / 100;
  const executed = Math.min(requested, pool.availableLiquidity);
  return { requested, executed, unfilled: Math.max(0, requested - executed), remaining: pool.availableLiquidity - executed };
}
