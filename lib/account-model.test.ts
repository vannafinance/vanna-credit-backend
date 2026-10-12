import { describe, expect, it } from "vitest";
import { accountNumbers, type ModelState } from "./account-model";

const base: ModelState = { collateral: [], debts: [], phoenixCollateral: 0, perps: [] };

describe("account leverage (gross position value ÷ equity)", () => {
  it("counts idle borrowed stables: deposit $2,140.83, borrow $3,933.35 left in the account → 2.84x", () => {
    const s: ModelState = {
      ...base,
      collateral: [
        { symbol: "JupUSD", usd: 999.33 },
        { symbol: "JupSOL", usd: 914.54 },
        { symbol: "NVDAx", usd: 226.96 },
        { symbol: "USDC", usd: 3433.33 },
        { symbol: "SOL", usd: 500.02 },
      ],
      debts: [
        { symbol: "USDC", usd: 3433.33 },
        { symbol: "SOL", usd: 500.02 },
      ],
    };
    const n = accountNumbers(s);
    expect(n.hf).toBeCloseTo(1.544, 3);
    expect(n.leverage).toBeCloseTo(6074.18 / 2140.83, 3);
  });

  it("is 1x with no debt, stables included", () => {
    expect(accountNumbers({ ...base, collateral: [{ symbol: "USDC", usd: 100 }] }).leverage).toBe(1);
  });

  it("reads a 5x perp as 5x (notional, not its collateral), and idle Phoenix collateral as 1x", () => {
    const perp = { key: "SOL", tokens: 5, entry: 100, index: 100, fundingUsd: 0, takerFee: 0 };
    expect(accountNumbers({ ...base, phoenixCollateral: 100, perps: [perp] }).leverage).toBeCloseTo(5, 6);
    expect(accountNumbers({ ...base, phoenixCollateral: 100 }).leverage).toBe(1);
  });
});
