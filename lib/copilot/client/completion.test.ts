import { describe, expect, it } from "vitest";
import type { PlanStepView, PlanView } from "@/lib/copilot/types";
import { completionSummary, doneClause } from "./completion";

const step = (n: number, label: string, patch: Partial<PlanStepView> = {}): PlanStepView => ({
  n,
  kind: "write",
  op: "earn_supply",
  asset: "USDC",
  amount: "5",
  label,
  venue: "earn",
  status: "confirmed",
  signature: `sig${n}`,
  ...patch,
});

const plan = (steps: PlanStepView[], state: PlanView["state"] = "completed"): PlanView => ({
  plan_id: "p",
  digest: "d",
  summary: "s",
  created_at: 0,
  expires_at: 0,
  signature_count: steps.length,
  warnings: [],
  hf_floor: 1.15,
  state,
  steps,
});

describe("doneClause", () => {
  it("turns the label's verb into the past tense and keeps the rest as written", () => {
    expect(doneClause("Supply 5 USDC to the Vanna Earn pool")).toBe("supplied 5 USDC to the Vanna Earn pool");
    expect(doneClause("Repay 10 USDC from your wallet")).toBe("repaid 10 USDC from your wallet");
  });

  it("reads a Predict trade's legs, each with its own verb", () => {
    expect(doneClause("Predict: Sell 2.881844 Yes shares of SF 49ers (Who will win the 2026 NFL championship?)"))
      .toBe("sold 2.881844 Yes shares of SF 49ers (Who will win the 2026 NFL championship?)");
    expect(doneClause("Predict: Buy Yes on A for 1 CASH, sell 2 No shares of B (Event)"))
      .toBe("bought Yes on A for 1 CASH, sold 2 No shares of B (Event)");
  });

  it("leaves a label with no known verb as it is", () => {
    expect(doneClause("Report your health factor")).toBe("Report your health factor");
  });
});

describe("completionSummary", () => {
  it("is null until the plan has completed", () => {
    expect(completionSummary(plan([step(1, "Supply 5 USDC to the Vanna Earn pool")], "running"))).toBeNull();
  });

  it("names what one step did", () => {
    expect(completionSummary(plan([step(1, "Supply 5 USDC to the Vanna Earn pool")]))).toBe("Done. Supplied 5 USDC to the Vanna Earn pool.");
  });

  it("joins a few steps in order and leaves read legs out", () => {
    const steps = [
      step(1, "Deposit 1 SOL as margin collateral"),
      step(2, "Report your health factor", { kind: "read", op: "report", status: "done", signature: null }),
      step(3, "Borrow 50 USDC against your margin collateral"),
    ];
    expect(completionSummary(plan(steps))).toBe("Done. Deposited 1 SOL as margin collateral, then borrowed 50 USDC against your margin collateral.");
  });

  it("counts a long plan instead of listing it", () => {
    const steps = [1, 2, 3, 4].map((n) => step(n, `Supply ${n} USDC to the Vanna Earn pool`));
    expect(completionSummary(plan(steps))).toBe("Done. All 4 transactions are confirmed on chain.");
  });
});
