import { describe, expect, it } from "vitest";
import { MAX_PLAN_STEPS, PLAN_TTL_MS, labelFor, planDigest, planWarnings, signatureCount, stepFromWrite, validateSteps, type StepSpec } from "../plan";
import { WALLET_A, WALLET_B } from "./helpers";

const borrow: StepSpec = { kind: "write", op: "borrow", asset: "USDC", amount: "100", slots: {} };
const swap: StepSpec = { kind: "write", op: "swap", asset: "USDC", amount: "100", slots: { to_asset: "SOL", mode: "margin", slippage_bps: 100 } };

describe("plan digest", () => {
  it("is stable: the same plan always hashes the same, regardless of slot key order", () => {
    const a = planDigest(WALLET_A, 1.15, [borrow, { ...swap, slots: { slippage_bps: 100, mode: "margin", to_asset: "SOL" } }]);
    const b = planDigest(WALLET_A, 1.15, [borrow, swap]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when ANY executable slot changes (tamper detection)", () => {
    const base = planDigest(WALLET_A, 1.15, [borrow, swap]);
    const variants: Array<[string, string]> = [
      ["amount", planDigest(WALLET_A, 1.15, [{ ...borrow, amount: "101" }, swap])],
      ["asset", planDigest(WALLET_A, 1.15, [{ ...borrow, asset: "USDT" }, swap])],
      ["op", planDigest(WALLET_A, 1.15, [{ ...borrow, op: "repay" }, swap])],
      ["slot value", planDigest(WALLET_A, 1.15, [borrow, { ...swap, slots: { ...swap.slots, to_asset: "JitoSOL" } }])],
      ["slot added", planDigest(WALLET_A, 1.15, [borrow, { ...swap, slots: { ...swap.slots, extra: true } }])],
      ["mode", planDigest(WALLET_A, 1.15, [borrow, { ...swap, slots: { ...swap.slots, mode: "wallet" } }])],
      ["step dropped", planDigest(WALLET_A, 1.15, [borrow])],
      ["step order", planDigest(WALLET_A, 1.15, [swap, borrow])],
      ["health floor", planDigest(WALLET_A, 1.05, [borrow, swap])],
      ["wallet", planDigest(WALLET_B, 1.15, [borrow, swap])],
      ["read step added", planDigest(WALLET_A, 1.15, [borrow, swap, { kind: "read", op: "report", asset: null, amount: null, slots: { report: "health" } }])],
    ];
    for (const [what, d] of variants) expect(d, what).not.toBe(base);
  });

  it("ignores presentation: labels are not part of the approval", () => {
    const a = planDigest(WALLET_A, 1.15, [borrow]);
    expect(labelFor(borrow)).toContain("Borrow");
    expect(planDigest(WALLET_A, 1.15, [{ ...borrow }])).toBe(a);
  });
});

describe("plan rules", () => {
  it("TTL for approval is five minutes", () => {
    expect(PLAN_TTL_MS).toBe(300_000);
  });

  it("rejects empty, oversized and incomplete plans", () => {
    expect(validateSteps([])).not.toBeNull();
    expect(validateSteps(Array.from({ length: MAX_PLAN_STEPS + 1 }, () => borrow))).not.toBeNull();
    expect(validateSteps([{ ...borrow, amount: null }])).not.toBeNull();
    expect(validateSteps([{ ...borrow, asset: null }])).not.toBeNull();
    expect(validateSteps([{ kind: "write", op: "create_account", asset: null, amount: null, slots: {} }])).toBeNull();
    expect(validateSteps([borrow, swap])).toBeNull();
  });

  it("counts only writes as signatures, and warns about several", () => {
    const report: StepSpec = { kind: "read", op: "report", asset: null, amount: null, slots: { report: "health" } };
    expect(signatureCount([borrow, swap, report])).toBe(2);
    expect(planWarnings([borrow, swap, report]).join(" ")).toMatch(/2 separate wallet signatures/);
    expect(planWarnings([borrow])).toEqual([]);
  });

  it("swap defaults to the wallet and repay to the wallet unless margin is named", () => {
    expect(stepFromWrite({ op: "swap", asset: "SOL", to_asset: "USDC", amount: null }, "1").slots.mode).toBe("wallet");
    expect(stepFromWrite({ op: "swap", asset: "SOL", to_asset: "USDC", amount: null, source: "margin" }, "1").slots.mode).toBe("margin");
    expect(stepFromWrite({ op: "repay", asset: "USDC", amount: null }, "1").slots.source).toBe("wallet");
  });
});
