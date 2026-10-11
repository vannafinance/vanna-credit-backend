import { describe, expect, it } from "vitest";
import { farmEarnedBySymbol, vaultEarnedUsd } from "@/components/portfolio/portfolio-math";
import type { HistoryPage, MarginHistoryRow } from "@/lib/solana/history";

const row = (r: Partial<MarginHistoryRow>): MarginHistoryRow => ({ type: "farm-deposit", symbol: "USDC", amount: "0", amountRaw: 0n, timestamp: 0, signature: "s", ...r });
const page = (rows: MarginHistoryRow[]): HistoryPage<MarginHistoryRow> => ({ rows, complete: true, scanned: rows.length });

describe("portfolio trading P&L", () => {
  it("does not count Basis / Perena vault USDC as a Kamino USDC loss", () => {
    // Account 34iZ…: 100 USDC + 20 SOL into Kamino, 330 USDC into Basis / Perena vaults. The
    // vault rows used to be summed as Kamino supply (−$330 "Trading").
    const h = page([
      row({ amount: "50", vaultId: "basis-btc" }),
      row({ amount: "50", vaultId: "basis-eth" }),
      row({ symbol: "SOL", amount: "20" }),
      row({ amount: "10", vaultId: "perena-usdstar" }),
      row({ amount: "100" }),
      row({ amount: "220", vaultId: "basis-sol" }),
    ]);
    const by = farmEarnedBySymbol(h, [
      { symbol: "USDC", underlying: 100.009 },
      { symbol: "SOL", underlying: 20.0017 },
    ])!;
    expect(by.USDC).toBeCloseTo(0.009, 6);
    expect(by.SOL).toBeCloseTo(0.0017, 6);
  });
  it("sums vault earnings, unknown when any vault's cost basis is", () => {
    expect(vaultEarnedUsd([{ earnedUsd: 0.27 }, { earnedUsd: -0.01 }, { earnedUsd: 0 }])).toBeCloseTo(0.26, 9);
    expect(vaultEarnedUsd([{ earnedUsd: 1 }, { earnedUsd: null }])).toBeNull();
  });
});
