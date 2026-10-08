import { expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { receiptPreview } from "./receipt-preview";
const rate = { liquidityMint: PublicKey.default, liquidityDecimals: 9, totalLiquidity: 12_000_000_000n, collateralSupply: 10_000_000n };
it("uses SOL's 9 decimals and receipt's 6 decimals, not a 1:1 ratio", () => {
  expect(receiptPreview(rate, "10")).toBe("8.333333");
  expect(receiptPreview(rate, "10.")).toBe("8.333333");
});
it("supports tokens with six decimals and floors receipts", () => {
  expect(receiptPreview({ ...rate, liquidityDecimals: 6, totalLiquidity: 12_000_000n }, "10")).toBe("8.333333");
});
it("does not invent a quote without a usable rate or valid amount", () => {
  expect(receiptPreview(undefined, "10")).toBeNull();
  expect(receiptPreview({ ...rate, totalLiquidity: 0n }, "10")).toBeNull();
  expect(receiptPreview(rate, ".")).toBeNull();
  expect(receiptPreview(rate, "0")).toBeNull();
});
