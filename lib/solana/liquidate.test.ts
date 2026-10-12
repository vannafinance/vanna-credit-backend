import { describe, expect, it } from "vitest";
import { quoteLiquidation, repayWithBuffer, withSlippage, type LiquidationQuoteInput } from "./liquidate";
import { WAD } from "./math";

const NANO = 1_000_000_000n;
const USDC = 1_000_000n; // 6 decimals
const SOL = 1_000_000_000n; // 9 decimals
const hf = (x: number) => (BigInt(Math.round(x * 1e6)) * WAD) / 1_000_000n;

// $950 USDC debt against 5 SOL worth $1,000 (SOL $200), SOL bonus 5%.
const base: LiquidationQuoteInput = {
  healthWad: hf(1000 / 950),
  bonusBps: 500,
  debtRaw: 950n * USDC,
  debtValueNano: 950n * NANO,
  heldRaw: 5n * SOL,
  heldValueNano: 1000n * NANO,
  repay: 10_000n * USDC,
};

describe("quoteLiquidation", () => {
  it("refuses a healthy account (HF > 1.10)", () => {
    expect(quoteLiquidation({ ...base, healthWad: hf(1.11) })).toBeNull();
  });

  it("liquidates exactly at the 1.10 line", () => {
    expect(quoteLiquidation({ ...base, healthWad: hf(1.1), bonusBps: 500 })).not.toBeNull();
  });

  it("applies the 50% close factor when HF is above 1 + bonus", () => {
    const q = quoteLiquidation(base)!;
    // HF 1000/950 = 1.0526 > 1.05 (1 + bonus), and the debt is over $100.
    expect(q.full).toBe(false);
    expect(q.maxRepay).toBe(475n * USDC);
    expect(q.repaid).toBe(475n * USDC);
    expect(q.bonusWad).toBe((WAD * 10_500n) / 10_000n);
    // $475 × 1.05 = $498.75 of SOL at $200 = 2.49375 SOL.
    expect(q.seized).toBe(2_493_750_000n);
    expect(q.grossProfitNano).toBe(23_750_000_000n);
  });

  it("uses HF itself as the bonus when HF sits between 1 and 1 + bonus, and repays in full", () => {
    const q = quoteLiquidation({ ...base, healthWad: hf(1.03), bonusBps: 500 })!;
    expect(q.full).toBe(true);
    expect(q.bonusWad).toBe(hf(1.03));
    expect(q.maxRepay).toBe(base.debtRaw);
  });

  it("gives the full bonus when the account is underwater (HF < 1)", () => {
    const q = quoteLiquidation({ ...base, healthWad: hf(0.9), heldValueNano: 855n * NANO })!;
    expect(q.bonusWad).toBe((WAD * 10_500n) / 10_000n);
    expect(q.full).toBe(true);
  });

  it("repays a small debt (<= $100) in full even above 1 + bonus", () => {
    const q = quoteLiquidation({ ...base, healthWad: hf(1.08), bonusBps: 200, debtRaw: 90n * USDC, debtValueNano: 90n * NANO })!;
    expect(q.full).toBe(true);
    expect(q.maxRepay).toBe(90n * USDC);
  });

  it("caps the repay at what the liquidator offers", () => {
    const q = quoteLiquidation({ ...base, repay: 100n * USDC })!;
    expect(q.repaid).toBe(100n * USDC);
  });

  it("seizes everything and shrinks the repay when the collateral can't cover the bonus", () => {
    // Underwater: $950 debt, only 1 SOL ($200) of this collateral.
    const q = quoteLiquidation({ ...base, healthWad: hf(0.5), heldRaw: SOL, heldValueNano: 200n * NANO })!;
    expect(q.seized).toBe(SOL);
    // $200 / 1.05 = $190.476... of USDC, rounded up.
    expect(q.repaid).toBe(190_476_191n);
  });

  it("returns null on zero amounts", () => {
    expect(quoteLiquidation({ ...base, repay: 0n })).toBeNull();
    expect(quoteLiquidation({ ...base, heldRaw: 0n })).toBeNull();
    expect(quoteLiquidation({ ...base, debtRaw: 0n })).toBeNull();
  });
});

describe("withSlippage", () => {
  it("takes bps off, rounding down", () => {
    expect(withSlippage(10_000n, 50)).toBe(9_950n);
    expect(withSlippage(3n, 50)).toBe(2n);
  });
});

describe("repayWithBuffer", () => {
  it("offers 0.1% (+1 raw) over the quoted repay so accrued interest leaves no dust", () => {
    const q = quoteLiquidation(base)!;
    expect(repayWithBuffer(q, 10_000n * USDC)).toBe(475n * USDC + 475_000n + 1n);
  });

  it("never offers more than the liquidator holds", () => {
    const q = quoteLiquidation(base)!;
    expect(repayWithBuffer(q, 475n * USDC)).toBe(475n * USDC);
  });
});
