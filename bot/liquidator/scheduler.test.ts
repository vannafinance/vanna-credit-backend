import { beforeEach, describe, expect, it } from "vitest";
import type { AccountRow } from "@/lib/analytics/types";
import { dueMargins, estimateHealth, intervalFor, record, resetScheduler, trackedRows } from "./scheduler";

const SOL = 2, USDC = 0;
const ctxAt = (solUsd: number) => ({
  prices: new Map([
    [SOL, { price: BigInt(Math.round(solUsd * 1e8)), exponent: -8 }],
    [USDC, { price: 100_000_000n, exponent: -8 }],
  ]) as never,
});

/** $collateral of SOL against $debt of USDC. */
function row(address: string, collateralUsd: number, debtUsd: number, extra: Partial<AccountRow> = {}): AccountRow {
  const hf = debtUsd > 0 ? collateralUsd / debtUsd : null;
  return {
    owner: `owner-${address}`, address, readAt: 0, status: "healthy", valued: true, reasons: [],
    collateralUsd, debtUsd, equityUsd: collateralUsd - debtUsd, healthFactor: hf, leverage: null, bufferPct: null, bufferUsd: null,
    liquidatable: hf !== null && hf <= 1.1,
    collateral: [{ symbol: "SOL", mint: "sol", assetIndex: SOL, kind: "direct", underlying: "SOL", amount: collateralUsd / 100, usd: collateralUsd }],
    debts: debtUsd > 0 ? [{ symbol: "USDC", mint: "usdc", assetIndex: USDC, amount: debtUsd, usd: debtUsd, borrowApr: null }] : [],
    composition: { direct: collateralUsd, receipt: 0, venue: 0 }, venueHeld: false,
    ...extra,
  } as AccountRow;
}

beforeEach(() => resetScheduler());

describe("intervalFor", () => {
  it("reads closer accounts more often", () => {
    expect(intervalFor(1.05, true, false, true)).toBe(0);
    expect(intervalFor(1.12, false, false, true)).toBe(0);
    expect(intervalFor(1.25, false, false, true)).toBe(30_000);
    expect(intervalFor(1.5, false, false, true)).toBe(120_000);
    expect(intervalFor(2.5, false, false, true)).toBe(300_000);
    expect(intervalFor(10, false, false, true)).toBe(900_000);
    expect(intervalFor(null, false, false, false)).toBe(900_000);
  });

  it("caps Phoenix holders at a minute", () => {
    expect(intervalFor(10, false, true, true)).toBe(60_000);
  });
});

describe("estimateHealth", () => {
  it("scales each line by its asset's price change", () => {
    record([row("a", 2000, 1000)], ctxAt(100), 0);
    const t = { row: trackedRows()[0], readAt: 0, prices: new Map([[SOL, 100], [USDC, 1]]) };
    expect(estimateHealth(t, ctxAt(100))).toBeCloseTo(2);
    expect(estimateHealth(t, ctxAt(55))).toBeCloseTo(1.1);
  });
});

describe("dueMargins", () => {
  it("reads new accounts at once, then only when due", () => {
    const margins = [{ address: "a" }, { address: "b" }];
    expect(dueMargins(margins, ctxAt(100), 0).map((m) => m.address)).toEqual(["a", "b"]);
    record([row("a", 5000, 1000), row("b", 1200, 1000)], ctxAt(100), 0);
    // b (HF 1.2) is due after 30 s, a (HF 5) after 15 min.
    expect(dueMargins(margins, ctxAt(100), 10_000)).toEqual([]);
    expect(dueMargins(margins, ctxAt(100), 31_000).map((m) => m.address)).toEqual(["b"]);
    expect(dueMargins(margins, ctxAt(100), 901_000).map((m) => m.address)).toEqual(["a", "b"]);
  });

  it("reads an account at once when a price drop brings it near the line", () => {
    record([row("a", 3000, 1000)], ctxAt(100), 0);
    expect(dueMargins([{ address: "a" }], ctxAt(100), 1_000)).toEqual([]);
    // SOL −62%: estimated HF 1.14 → due immediately, not in 5 minutes.
    expect(dueMargins([{ address: "a" }], ctxAt(38), 1_000).map((m) => m.address)).toEqual(["a"]);
  });

  it("re-reads liquidatable accounts every loop", () => {
    record([row("a", 1050, 1000)], ctxAt(100), 0);
    expect(dueMargins([{ address: "a" }], ctxAt(100), 1).map((m) => m.address)).toEqual(["a"]);
  });
});
