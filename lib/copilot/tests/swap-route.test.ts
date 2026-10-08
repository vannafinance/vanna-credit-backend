/** A swap route named in the user's own words (Jupiter or Titan), whichever router read the message. */
import { describe, expect, it } from "vitest";
import { providerFromText, withNamedProvider, type Intent } from "../intent";
import { labelFor, stepFromWrite } from "../plan";

describe("swap route from the user's words", () => {
  it("reads one named route and ignores Jupiter's tokens", () => {
    expect(providerFromText("swap 1 SOL to USDC via Titan")).toBe("titan");
    expect(providerFromText("use jupiter for it")).toBe("jupiter");
    expect(providerFromText("swap SOL to JupSOL")).toBeNull();
    expect(providerFromText("swap to JupUSD")).toBeNull();
    expect(providerFromText("titan or jupiter, whichever")).toBeNull();
    expect(providerFromText("swap 1 SOL to USDC")).toBeNull();
  });

  it("sets it on swaps that have none, in a write or a chain", () => {
    const swap = { op: "swap" as const, asset: "SOL" as const, to_asset: "USDC" as const, amount: { kind: "exact" as const, value: "1" } };
    const w = withNamedProvider({ lane: "write", write: swap }, "via titan") as Extract<Intent, { lane: "write" }>;
    expect(w.write.provider).toBe("titan");
    const c = withNamedProvider({ lane: "chain", steps: [{ write: { ...swap, provider: "jupiter" } }, { write: swap }] }, "via titan") as Extract<Intent, { lane: "chain" }>;
    expect(c.steps.map((s) => ("write" in s ? s.write.provider : null))).toEqual(["jupiter", "titan"]);
  });

  it("carries the route into the plan step and its label", () => {
    const step = stepFromWrite({ op: "swap", asset: "SOL", to_asset: "USDC", amount: null, source: "margin", provider: "titan" }, "1");
    expect(step.slots.provider).toBe("titan");
    expect(labelFor(step)).toBe("Swap 1 SOL to USDC via Titan inside your margin account");
  });
});
