import { describe, expect, it } from "vitest";
import { floorDecimals, hfAfter, maxBorrowUsd, maxLeverage, maxWithdrawUsd, readCan, readHealth, riskGate, sizeLever, usdToUnits } from "../risk";

// Shape verified against vanna_core/contracts/margin.py `health()` and the live `vanna_account` tool.
const healthFixture = {
  margin_account: "GCL2pGFBKnBhkGEPZ3BhC4FuqHnfpJJnr8i9nnLKkTgD",
  collateral: [{ symbol: "SOL", raw_balance: 5_000_000_000, ui_balance: "5", usd_value: "600.00", price: { usd: "120", source: "pyth", fresh: true } }],
  debt: [{ symbol: "USDC", raw_debt: 200_000_000, ui_debt: "200", usd_value: "200.00", price: { usd: "1", source: "pyth", fresh: true } }],
  total_collateral_usd: "600.00",
  total_debt_usd: "200.00",
  health_factor: "3.0",
  is_healthy: true,
  is_liquidatable: false,
  price_checks_pass: true,
};

describe("readHealth", () => {
  it("reads the MCP shape", () => {
    const h = readHealth(healthFixture);
    expect(h).toMatchObject({ hf: 3, collateralUsd: 600, debtUsd: 200, isLiquidatable: false, pricesOk: true });
    expect(h?.collateral[0]).toMatchObject({ symbol: "SOL", units: 5, priceUsd: 120 });
  });

  it("prices a Kamino receipt by its own worth, not the underlying's price the MCP lists beside it", () => {
    // Real account (local MCP, 26 Oct): 8,650.89 kSOL worth $1,009.62 while the row's price is SOL's $100.82.
    const h = readHealth({
      ...healthFixture,
      collateral: [
        { symbol: "SOL", ui_balance: "70.1", usd_value: "7067.60", price: { usd: "100.82169535" } },
        { symbol: "kSOL", ui_balance: "8650.892457", usd_value: "1009.62", price: { usd: "100.82169535" } },
      ],
    });
    const ksol = h?.collateral.find((r) => r.symbol === "kSOL");
    expect(ksol?.priceUsd).toBeCloseTo(1009.62 / 8650.892457, 8);
    expect(ksol!.units * ksol!.priceUsd!).toBeCloseTo(1009.62, 2);
    expect(h?.collateral.find((r) => r.symbol === "SOL")?.priceUsd).toBeCloseTo(100.82169535, 8);
  });

  it("no debt means hf null, not infinity and not a default", () => {
    const h = readHealth({ ...healthFixture, debt: [], total_debt_usd: "0.00", health_factor: null });
    expect(h?.hf).toBeNull();
  });

  it("refuses partial data instead of guessing", () => {
    expect(readHealth({ ...healthFixture, total_collateral_usd: undefined })).toBeNull();
    const noHf: Record<string, unknown> = { ...healthFixture };
    delete noHf.health_factor;
    expect(readHealth(noHf)).toBeNull();
    expect(readHealth({ ...healthFixture, health_factor: null })).toBeNull(); // debt present but no HF: inconsistent
    expect(readHealth({ ...healthFixture, collateral: "x" })).toBeNull();
    expect(readHealth({ ...healthFixture, debt: [{ symbol: "USDC" }] })).toBeNull();
  });
});

describe("readCan", () => {
  it("keeps null (no debt after) distinct from unreported", () => {
    expect(readCan({ allowed: true, projected_health_factor: null })?.projectedHf).toBeNull();
    expect(readCan({ allowed: true })?.projectedHf).toBeUndefined();
    expect(readCan({ allowed: true, projected_health_factor: "1.42" })?.projectedHf).toBeCloseTo(1.42);
    expect(readCan({ nope: 1 })).toBeNull();
  });
});

describe("sizing", () => {
  it("max borrow keeps HF at the floor exactly (borrowed funds count as collateral)", () => {
    const c = 600;
    const d = 200;
    const floor = 1.15;
    const x = maxBorrowUsd(c, d, floor, true);
    expect(hfAfter(c + x, d + x)).toBeCloseTo(floor, 9);
    expect(maxBorrowUsd(100, 100, 1.15)).toBe(0);
  });

  it("max borrow of a non-collateral asset uses C/h - D", () => {
    const x = maxBorrowUsd(600, 200, 1.15, false);
    expect(hfAfter(600, 200 + x)).toBeCloseTo(1.15, 9);
  });

  it("max withdraw leaves HF at the floor; with no debt everything can go", () => {
    const w = maxWithdrawUsd(600, 200, 1.15);
    expect(hfAfter(600 - w, 200)).toBeCloseTo(1.15, 9);
    expect(maxWithdrawUsd(600, 0, 1.15)).toBe(600);
    expect(maxWithdrawUsd(100, 200, 1.15)).toBe(0);
  });

  it("lever sizes (N-1) x equity and holds the floor even at worst-case slippage", () => {
    const r = sizeLever({ collateralUsd: 1000, debtUsd: 0, equityUsd: 1000, depositUsd: 0, leverage: 2, floor: 1.15 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.borrowUsd).toBe(1000);
      // worst case: (1000 + 1000*0.99) / 1000
      expect(r.hfAfter).toBeCloseTo(1.99, 6);
      expect(r.hfAfter).toBeGreaterThanOrEqual(1.15);
    }
  });

  it("lever refuses when the floor would break, and offers a safe maximum that itself passes", () => {
    const r = sizeLever({ collateralUsd: 1000, debtUsd: 0, equityUsd: 1000, depositUsd: 0, leverage: 20, floor: 1.15 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.maxLeverage).not.toBeNull();
      const again = sizeLever({ collateralUsd: 1000, debtUsd: 0, equityUsd: 1000, depositUsd: 0, leverage: r.maxLeverage as number, floor: 1.15 });
      expect(again.ok).toBe(true);
      // and a hair above the offered max does not
      expect(sizeLever({ collateralUsd: 1000, debtUsd: 0, equityUsd: 1000, depositUsd: 0, leverage: (r.maxLeverage as number) + 1, floor: 1.15 }).ok).toBe(false);
    }
  });

  it("existing debt lowers the safe leverage", () => {
    const clean = maxLeverage({ collateralUsd: 1000, debtUsd: 0, equityUsd: 1000, depositUsd: 0, floor: 1.15, slippageBps: 100 });
    const indebted = maxLeverage({ collateralUsd: 1000, debtUsd: 400, equityUsd: 1000, depositUsd: 0, floor: 1.15, slippageBps: 100 });
    expect(indebted).toBeLessThan(clean);
  });

  it("a deposit counts toward collateral before the borrow", () => {
    const r = sizeLever({ collateralUsd: 0, debtUsd: 0, equityUsd: 500, depositUsd: 500, leverage: 3, floor: 1.15 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.borrowUsd).toBe(1000);
  });

  it("formats amounts rounding down, never up", () => {
    expect(floorDecimals(1.23456789, 4)).toBe("1.2345");
    expect(floorDecimals(0.9999999, 2)).toBe("0.99");
    expect(floorDecimals(5, 6)).toBe("5");
    expect(floorDecimals(-1, 6)).toBe("0");
    expect(usdToUnits(119.99, 120, "SOL")).toBe("0.999916666");
    expect(usdToUnits(10, 0, "SOL")).toBe("0");
  });
});

describe("risk gate", () => {
  const floor = 1.15;
  it("blocks a risk-increasing action that lands below the floor", () => {
    const r = riskGate({ increasesRisk: true, hfAfter: 1.12, floor });
    expect(r.decision).toBe("block");
    expect(r.reasons[0]).toMatch(/1\.12/);
  });
  it("fails closed when the projection is unknown", () => {
    expect(riskGate({ increasesRisk: true, hfAfter: undefined, floor }).decision).toBe("block");
  });
  it("flags a thin buffer and allows comfortable ones and no-debt", () => {
    expect(riskGate({ increasesRisk: true, hfAfter: 1.2, floor }).decision).toBe("needs_confirmation");
    expect(riskGate({ increasesRisk: true, hfAfter: 1.6, floor }).decision).toBe("allow");
    expect(riskGate({ increasesRisk: true, hfAfter: null, floor }).decision).toBe("allow");
  });
  it("never blocks an action that cannot lower health (deposit / repay), even from an unhealthy account", () => {
    expect(riskGate({ increasesRisk: false, hfAfter: 1.02, floor }).decision).toBe("allow");
    expect(riskGate({ increasesRisk: false, hfAfter: undefined, floor }).decision).toBe("allow");
  });
  it("exactly at the floor is allowed", () => {
    expect(riskGate({ increasesRisk: true, hfAfter: 1.15, floor }).decision).not.toBe("block");
  });
});
