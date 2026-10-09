import { describe, expect, it } from "vitest";
import { classify, derivedFigures, inBand, liquidationPrices, matchesFilter, protocolsOf, searchRows, sortRows, summarize } from "./risk";
import type { AccountRow } from "./types";

/** Test fixtures only - never shipped to the UI. */
function row(over: Partial<AccountRow> & { owner: string; collateralUsd?: number | null; debtUsd?: number | null }): AccountRow {
  const valued = over.valued ?? true;
  const c = over.collateralUsd ?? 0, d = over.debtUsd ?? 0;
  const f = valued ? derivedFigures(c, d) : null;
  const liquidatable = valued && d > 0 && c / d <= 1.1;
  const base: AccountRow = {
    owner: over.owner, address: `m-${over.owner}`, valued, reasons: [], readAt: 0,
    collateralUsd: valued ? c : null, debtUsd: valued ? d : null, equityUsd: f?.equityUsd ?? null,
    healthFactor: f?.healthFactor ?? null, leverage: f?.leverage ?? null, bufferPct: f?.bufferPct ?? null, bufferUsd: f?.bufferUsd ?? null,
    liquidatable, collateral: [], debts: [], composition: { direct: c, receipt: 0, venue: 0 }, venueHeld: false,
    status: classify({ valued, collateralUsd: valued ? c : null, debtUsd: valued ? d : null, healthFactor: f?.healthFactor ?? null, liquidatable }),
  };
  return { ...base, ...over, collateralUsd: base.collateralUsd, debtUsd: base.debtUsd } as AccountRow;
}

describe("classify", () => {
  it("never claims health for an account it could not value", () => {
    expect(classify({ valued: false, collateralUsd: null, debtUsd: null, healthFactor: null, liquidatable: false })).toBe("incomplete");
  });
  it("separates empty, no-debt and debt-bearing accounts", () => {
    expect(classify({ valued: true, collateralUsd: 0, debtUsd: 0, healthFactor: null, liquidatable: false })).toBe("empty");
    expect(classify({ valued: true, collateralUsd: 50, debtUsd: 0, healthFactor: null, liquidatable: false })).toBe("nodebt");
    expect(classify({ valued: true, collateralUsd: 100, debtUsd: 100, healthFactor: 1.0, liquidatable: true })).toBe("liquidatable");
    expect(classify({ valued: true, collateralUsd: 115, debtUsd: 100, healthFactor: 1.15, liquidatable: false })).toBe("critical");
    expect(classify({ valued: true, collateralUsd: 140, debtUsd: 100, healthFactor: 1.4, liquidatable: false })).toBe("warning");
    expect(classify({ valued: true, collateralUsd: 300, debtUsd: 100, healthFactor: 3, liquidatable: false })).toBe("healthy");
  });
});

describe("derivedFigures", () => {
  it("computes equity, leverage and the room before the liquidation line", () => {
    const f = derivedFigures(200, 100);
    expect(f.equityUsd).toBe(100);
    expect(f.healthFactor).toBe(2);
    expect(f.leverage).toBe(2);
    expect(f.bufferUsd).toBeCloseTo(90);
    expect(f.bufferPct).toBeCloseTo(0.45);
  });
  it("has no health factor or buffer without debt", () => {
    const f = derivedFigures(50, 0);
    expect(f.healthFactor).toBeNull();
    expect(f.bufferPct).toBeNull();
  });
});

describe("summarize", () => {
  const rows = [
    row({ owner: "a", collateralUsd: 300, debtUsd: 100 }),
    row({ owner: "b", collateralUsd: 105, debtUsd: 100 }),
    row({ owner: "c", collateralUsd: 40, debtUsd: 100 }),
    row({ owner: "d", collateralUsd: 70, debtUsd: 0 }),
    row({ owner: "e", valued: false, reasons: [{ code: "stale_price", symbols: ["SOL"] }] }),
  ];
  const s = summarize(rows);
  it("counts only valued accounts in totals and reports the rest as incomplete", () => {
    expect(s.total).toBe(5);
    expect(s.valued).toBe(4);
    expect(s.incomplete).toBe(1);
    expect(s.collateralUsd).toBe(515);
    expect(s.debtUsd).toBe(300);
  });
  it("derives liquidation exposure and bad debt from the rows", () => {
    expect(s.liquidatableCount).toBe(2);
    expect(s.liquidatableDebtUsd).toBe(200);
    expect(s.badDebtUsd).toBe(60);
    expect(s.underwaterCount).toBe(1);
    expect(s.averageHealth).toBeCloseTo(445 / 300);
  });
  it("keeps status counts over every account", () => {
    expect(s.statusCounts.incomplete).toBe(1);
    expect(s.statusCounts.nodebt).toBe(1);
  });
  it("returns nulls, not zeros, when nothing can be computed", () => {
    const none = summarize([row({ owner: "x", valued: false })]);
    expect(none.averageHealth).toBeNull();
    expect(none.concentration.top1).toBeNull();
  });
});

describe("filter, sort and search", () => {
  const rows = [
    row({ owner: "aaa", collateralUsd: 300, debtUsd: 100 }),
    row({ owner: "bbb", collateralUsd: 105, debtUsd: 100 }),
    row({ owner: "ccc", valued: false }),
    row({ owner: "ddd", collateralUsd: 70, debtUsd: 0 }),
  ];
  it("sorts riskiest first and puts accounts with no health last", () => {
    expect(sortRows(rows, "health", 1).map((r) => r.owner)).toEqual(["bbb", "aaa", "ddd", "ccc"]);
  });
  it("keeps accounts without a value last when sorting either way", () => {
    expect(sortRows(rows, "health", -1).map((r) => r.owner)).toEqual(["aaa", "bbb", "ddd", "ccc"]);
    expect(sortRows(rows, "buffer", -1).map((r) => r.owner).slice(-2)).toEqual(["ddd", "ccc"]);
  });
  it("filters by status", () => {
    expect(rows.filter((r) => matchesFilter(r, "incomplete")).map((r) => r.owner)).toEqual(["ccc"]);
    expect(rows.filter((r) => matchesFilter(r, "nodebt")).map((r) => r.owner)).toEqual(["ddd"]);
  });
  it("filters by health band and searches by address", () => {
    expect(rows.filter((r) => inBand(r, "1.1-1.3")).map((r) => r.owner)).toEqual([]);
    expect(rows.filter((r) => inBand(r, "1-1.1")).map((r) => r.owner)).toEqual(["bbb"]);
    expect(searchRows(rows, "BB").map((r) => r.owner)).toEqual(["bbb"]);
  });
});

describe("liquidationPrices", () => {
  // $200 of SOL collateral against $100 of USDC debt: health 2.0. SOL can fall until 200f / 100 = 1.1 → f = 0.55.
  const base = row({ owner: "p", collateralUsd: 200, debtUsd: 100 });
  const r: AccountRow = {
    ...base,
    collateral: [{ symbol: "SOL", mint: "m", assetIndex: 1, kind: "direct", underlying: "SOL", amount: 2, usd: 200 }],
    debts: [{ symbol: "USDC", mint: "u", assetIndex: 2, amount: 100, usd: 100, borrowApr: 0.02 }],
  };
  it("solves the single-asset price that reaches the liquidation line", () => {
    const [sol] = liquidationPrices(r, { SOL: 100, USDC: 1 });
    expect(sol.symbol).toBe("SOL");
    expect(sol.direction).toBe("down");
    expect(sol.change).toBeCloseTo(-0.45, 6);
    expect(sol.price).toBeCloseTo(55, 6);
  });
  it("reports nothing when an asset price is unknown or the account is already liquidatable", () => {
    expect(liquidationPrices(r, {})).toEqual([]);
    expect(liquidationPrices(row({ owner: "z", collateralUsd: 100, debtUsd: 100 }), { SOL: 100 })).toEqual([]);
  });
  it("describes where collateral is deployed", () => {
    expect(protocolsOf({ ...r, composition: { direct: 10, receipt: 5, venue: 0 } })).toEqual(["Kamino", "Held in account"]);
  });
});
