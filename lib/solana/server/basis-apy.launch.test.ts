import { describe, expect, it } from "vitest";
import { sinceLaunchReturn } from "./basis-apy";

describe("sinceLaunchReturn", () => {
  it("reports the raw share-price change from 1.0, not annualised", () => {
    // SOL Basis on the fork: 0.983 after ~4 days is −1.70%, not a −75% "APY".
    const r = sinceLaunchReturn(0.983, 4.2 * 86400)!;
    expect(r.returnPct).toBeCloseTo(-1.7, 6);
    expect(r.days).toBeCloseTo(4.2, 6);
    expect(sinceLaunchReturn(1.000601, 4.12 * 86400)!.returnPct).toBeCloseTo(0.0601, 6);
  });
  it("is null for a missing price or elapsed time", () => {
    expect(sinceLaunchReturn(0, 5 * 86400)).toBeNull();
    expect(sinceLaunchReturn(1.001, 0)).toBeNull();
  });
});
