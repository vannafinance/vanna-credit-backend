import { describe, expect, it } from "vitest";
import type { AccountRow } from "@/lib/analytics/types";
import { answer } from "./commands";
import type { BotSnapshot } from "./state";

function row(address: string, collateralUsd: number, debtUsd: number): AccountRow {
  const hf = debtUsd > 0 ? collateralUsd / debtUsd : null;
  return {
    owner: `W${address}`, address, readAt: 0, status: hf !== null && hf <= 1.1 ? "liquidatable" : "healthy", valued: true, reasons: [],
    collateralUsd, debtUsd, equityUsd: collateralUsd - debtUsd, healthFactor: hf, leverage: 2, bufferPct: 0.1, bufferUsd: 10,
    liquidatable: hf !== null && hf <= 1.1,
    collateral: [{ symbol: "USDC", mint: "m", assetIndex: 0, kind: "direct", underlying: "USDC", amount: collateralUsd, usd: collateralUsd }],
    debts: [{ symbol: "USDC", mint: "m", assetIndex: 0, amount: debtUsd, usd: debtUsd, borrowApr: 0.05 }],
    composition: { direct: collateralUsd, receipt: 0, venue: 0 }, venueHeld: false,
  } as AccountRow;
}

const snapshot: BotSnapshot = {
  at: Date.now(),
  rows: [row("AAAA1111", 1050, 1000), row("BBBB2222", 3000, 1000), row("CCCC3333", 1300, 1000)],
  coverage: { accountsFound: 3, transactionsScanned: 10, complete: true } as never,
  wallet: { USDC: "1000" },
  liquidator: "LiqWallet111",
  dryRun: true,
};

describe("answer", () => {
  it("ignores text that isn't a command", () => {
    expect(answer("hello", snapshot)).toBeNull();
  });

  it("says it is starting before the first loop", () => {
    expect(answer("/stats", null)).toMatch(/Still starting/);
  });

  it("/stats shows totals and the liquidatable count", () => {
    const text = answer("/stats", snapshot)!;
    expect(text).toMatch(/Accounts 3/);
    expect(text).toMatch(/Liquidatable now: <b>1<\/b>/);
  });

  it("/risky lists lowest health first", () => {
    const text = answer("/risky", snapshot)!;
    expect(text.indexOf("AAAA")).toBeLessThan(text.indexOf("CCCC"));
    expect(text.indexOf("CCCC")).toBeLessThan(text.indexOf("BBBB"));
  });

  it("/liquidatable lists only accounts at or below the line", () => {
    const text = answer("/liquidatable@Vanna_Liquidator_Alerts_bot", snapshot)!;
    expect(text).toMatch(/AAAA/);
    expect(text).not.toMatch(/BBBB/);
  });

  it("/account finds by margin or wallet address", () => {
    expect(answer("/account AAAA1111", snapshot)).toMatch(/HF <b>1\.050<\/b>/);
    expect(answer("/account WBBBB2222", snapshot)).toMatch(/HF <b>3\.000<\/b>/);
    expect(answer("/account nope", snapshot)).toMatch(/No account/);
  });
});
