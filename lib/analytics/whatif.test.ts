import { describe, expect, it } from "vitest";
import { simulate, simulateAccount, simulateWithdrawal, validateShocks, type BaselineAccount } from "./whatif";

// Test fixtures only.
const acct = (owner: string, solUsd: number, usdcDebt: number): BaselineAccount => ({
  owner, address: `m-${owner}`, collateralUsd: solUsd, debtUsd: usdcDebt,
  collateral: [{ symbol: "SOL", mint: "m", assetIndex: 1, kind: "direct", underlying: "SOL", amount: 1, usd: solUsd }],
  debts: usdcDebt ? [{ symbol: "USDC", mint: "u", assetIndex: 2, amount: usdcDebt, usd: usdcDebt, borrowApr: 0.02 }] : [],
});

describe("what-if engine", () => {
  it("reprices collateral and debt of the shocked asset only", () => {
    const r = simulateAccount(acct("a", 200, 100), { SOL: -50 });
    expect(r.baseline.health).toBeCloseTo(2);
    expect(r.result.collateral).toBeCloseTo(100);
    expect(r.result.debt).toBeCloseTo(100);
    expect(r.result.health).toBeCloseTo(1);
    expect(r.result.eligible).toBe(true);
    expect(r.baseline.eligible).toBe(false);
  });
  it("keeps liquidation eligibility distinct from loss", () => {
    const r = simulateAccount(acct("a", 200, 100), { SOL: -45 }); // health 1.10 exactly → eligible, but no shortfall
    expect(r.result.eligible).toBe(true);
    expect(r.result.shortfall).toBe(0);
  });
  it("moves a shocked debt asset too (net-debt accounts get worse when it rises)", () => {
    const r = simulateAccount(acct("a", 200, 100), { USDC: 50 });
    expect(r.result.debt).toBeCloseTo(150);
    expect(r.result.health).toBeCloseTo(200 / 150);
  });
  it("aggregates and never counts accounts without debt in average health", () => {
    const out = simulate([acct("a", 200, 100), acct("b", 50, 0)], { SOL: -50 });
    expect(out.baseline.accounts).toBe(2);
    expect(out.result.eligibleCount).toBe(1);
    expect(out.result.averageHealth).toBeCloseTo(1);
  });
  it("rejects out-of-range assumptions", () => {
    expect(validateShocks({ SOL: -101 })).not.toBeNull();
    expect(() => simulate([acct("a", 1, 0)], { SOL: 501 })).toThrow();
  });
  it("limits a withdrawal to the cash available", () => {
    const w = simulateWithdrawal({ totalSupplied: 1000, availableLiquidity: 300 }, 50);
    expect(w).toEqual({ requested: 500, executed: 300, unfilled: 200, remaining: 0 });
    expect(() => simulateWithdrawal({ totalSupplied: 1, availableLiquidity: 1 }, 120)).toThrow();
  });
});
