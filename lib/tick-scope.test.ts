import { describe, expect, it } from "vitest";
import { isQuietRoute } from "./tick-scope";

describe("isQuietRoute", () => {
  it("pauses the tick on Predict and Analytics pages", () => {
    for (const p of ["/predict", "/predict/abc", "/analytics", "/analytics/accounts/xyz"]) expect(isQuietRoute(p)).toBe(true);
  });
  it("keeps it on every page that shows account, price or pool data", () => {
    for (const p of ["/", "/margin", "/earn", "/earn/usdc", "/farm", "/trade/spot", "/trade/perps/SOL", "/portfolio", "/copilot", "/predictions", "/analyticsx"]) {
      expect(isQuietRoute(p)).toBe(false);
    }
  });
  it("treats a missing pathname as live", () => {
    expect(isQuietRoute(null)).toBe(false);
    expect(isQuietRoute(undefined)).toBe(false);
  });
});
