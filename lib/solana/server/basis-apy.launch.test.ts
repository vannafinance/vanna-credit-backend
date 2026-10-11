import { describe, expect, it } from "vitest";
import { sinceLaunchApy } from "./basis-apy";

describe("sinceLaunchApy", () => {
  it("annualises the share price from 1.0 by the second, compounded", () => {
    // BTC Basis on the fork: 1.000601 after 4.12 days ≈ 5.46%.
    expect(sinceLaunchApy(1.000601, 4.12 * 86400)!).toBeCloseTo(5.46, 1);
  });
  it("is null for under a day or a missing price", () => {
    expect(sinceLaunchApy(1.001, 3600)).toBeNull();
    expect(sinceLaunchApy(0, 5 * 86400)).toBeNull();
  });
});
