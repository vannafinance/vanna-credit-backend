import { describe, expect, it } from "vitest";
import { describeActivity } from "./activity";
import type { MarginHistoryRow } from "@/lib/solana/history";

const row = (over: Partial<MarginHistoryRow>): MarginHistoryRow => ({ type: "borrow", symbol: "USDC", amount: "1,615.55", amountRaw: 0n, timestamp: 1_791_000_000_000, signature: "sig", ...over });

describe("describeActivity", () => {
  it("words a borrow with its amount and converts the time to unix seconds", () => {
    const a = describeActivity(row({}));
    expect(a).toMatchObject({ title: "Borrowed", detail: "1,615.55 USDC", time: 1_791_000_000, signature: "sig", tone: "warn", healthFactor: null });
  });
  it("rounds long amounts for reading", () => {
    expect(describeActivity(row({ amount: "11266.602925" })).detail).toBe("11,266.6029 USDC");
  });
  it("says collateral for deposits and withdrawals", () => {
    expect(describeActivity(row({ type: "deposit", symbol: "SOL", amount: "2" })).detail).toBe("2 SOL as collateral");
    expect(describeActivity(row({ type: "withdraw", symbol: "SOL", amount: "2" })).detail).toBe("2 SOL of collateral");
  });
  it("does not invent an amount when there is none", () => {
    expect(describeActivity(row({ type: "create", symbol: "", amount: "0" }))).toMatchObject({ title: "Margin account opened", detail: "" });
    expect(describeActivity(row({ type: "perp-order", symbol: "", amount: "" })).detail).toBe("");
  });
  it("describes swaps on both sides and carries the health factor", () => {
    const a = describeActivity(row({ type: "swap", symbol: "USDC", amount: "100", toSymbol: "SOL", toAmount: "0.9", via: "Jupiter", healthFactor: 1.8 }));
    expect(a.detail).toBe("100 USDC for 0.9 SOL via Jupiter");
    expect(a.healthFactor).toBe(1.8);
  });
});
