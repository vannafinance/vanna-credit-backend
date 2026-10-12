import { describe, expect, it } from "vitest";
import { liquidationBandBps } from "./phoenix";

describe("liquidationBandBps (the validator's band for a liquidation close)", () => {
  it("is 500 × 10,000 / max leverage", () => {
    expect(liquidationBandBps(200_000)).toBe(25); // 20x
    expect(liquidationBandBps(100_000)).toBe(50); // 10x
  });

  it("is capped at 300 bps for low-leverage markets", () => {
    expect(liquidationBandBps(20_000)).toBe(250); // 2x
    expect(liquidationBandBps(10_000)).toBe(300); // 1x → 500, capped
  });
});
