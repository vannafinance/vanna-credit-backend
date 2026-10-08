import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  approvePlan: vi.fn(),
  advancePlan: vi.fn(),
  submitStep: vi.fn(),
  confirmStep: vi.fn(),
  getWorkflow: vi.fn(),
  cancelPlan: vi.fn(),
}));
const sign = vi.hoisted(() => ({ signUnsignedTx: vi.fn() }));

vi.mock("../client/api", async (orig) => ({ ...(await orig<typeof import("../client/api")>()), ...api }));
vi.mock("../client/sign", async (orig) => ({ ...(await orig<typeof import("../client/sign")>()), ...sign }));

import { createRunController, initialRunState } from "../client/run";
import { WalletRejectedError } from "../client/sign";
import type { PlanStepView, PlanView, UnsignedTx } from "../types";

const step = (n: number, status: PlanStepView["status"] = "pending"): PlanStepView => ({ n, kind: "write", op: n === 1 ? "deposit" : "borrow", asset: n === 1 ? "SOL" : "USDC", amount: "1", label: `step ${n}`, venue: "margin", status });
const plan = (state: PlanView["state"], steps: PlanStepView[]): PlanView => ({ plan_id: "p", digest: "d", summary: "s", created_at: 0, expires_at: 1, signature_count: 2, warnings: [], hf_floor: 1.15, state, steps });
const tx = (n: number): UnsignedTx => ({ transaction: `tx${n}`, blockhash: "b", lastValidBlockHeight: 1, simulation_success: true });

function run() {
  const states: string[] = [];
  const ctl = createRunController({ initial: initialRunState("w", plan("proposed", [step(1), step(2)])), onState: (s) => states.push(s.phase) });
  return { ctl, states };
}

describe("a plan runs from one approval", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    sign.signUnsignedTx.mockReset();
    api.approvePlan.mockResolvedValue({ plan: plan("approved", [step(1), step(2)]) });
    api.submitStep.mockImplementation(async (_id: string, body: { step_n: number }) => ({ plan: plan("running", [step(1, "submitted"), step(2)]), signature: `sig${body.step_n}`, status: "submitted" }));
    api.confirmStep.mockResolvedValue({ plan: plan("running", [step(1, "confirmed"), step(2)]), status: "confirmed", signature: "sig" });
  });

  it("asks the wallet for step 2 by itself after step 1 confirms, then completes", async () => {
    api.advancePlan
      .mockResolvedValueOnce({ plan: plan("running", [step(1, "awaiting_signature"), step(2)]), step: step(1, "awaiting_signature"), unsigned_tx: tx(1) })
      .mockResolvedValueOnce({ plan: plan("running", [step(1, "confirmed"), step(2, "awaiting_signature")]), step: step(2, "awaiting_signature"), unsigned_tx: tx(2) })
      .mockResolvedValueOnce({ plan: plan("completed", [step(1, "confirmed"), step(2, "confirmed")]), message: "All steps are confirmed." });
    sign.signUnsignedTx.mockResolvedValue("signed");

    const { ctl } = run();
    await ctl.approve("d"); // the ONLY user action

    expect(sign.signUnsignedTx).toHaveBeenCalledTimes(2);
    expect(api.submitStep).toHaveBeenCalledTimes(2);
    expect(api.submitStep.mock.calls.map((c) => c[1].step_n)).toEqual([1, 2]);
    expect(ctl.state().phase).toBe("completed");
  });

  it("stops and waits when the wallet prompt for a later step is declined", async () => {
    api.advancePlan
      .mockResolvedValueOnce({ plan: plan("running", [step(1, "awaiting_signature"), step(2)]), step: step(1, "awaiting_signature"), unsigned_tx: tx(1) })
      .mockResolvedValueOnce({ plan: plan("running", [step(1, "confirmed"), step(2, "awaiting_signature")]), step: step(2, "awaiting_signature"), unsigned_tx: tx(2) });
    sign.signUnsignedTx.mockResolvedValueOnce("signed").mockRejectedValueOnce(new WalletRejectedError());

    const { ctl } = run();
    await ctl.approve("d");

    expect(api.submitStep).toHaveBeenCalledTimes(1);
    expect(ctl.state().phase).toBe("awaiting_signature");
    expect(ctl.state().rejected).toBe(true);
  });

  it("does not continue past a paused plan (health floor, price moved)", async () => {
    api.advancePlan
      .mockResolvedValueOnce({ plan: plan("running", [step(1, "awaiting_signature"), step(2)]), step: step(1, "awaiting_signature"), unsigned_tx: tx(1) })
      .mockResolvedValueOnce({ plan: plan("paused", [step(1, "confirmed"), step(2)]), step: step(2), pause_reason: "That borrow would push your health factor below 1.15." });
    sign.signUnsignedTx.mockResolvedValue("signed");

    const { ctl } = run();
    await ctl.approve("d");

    expect(sign.signUnsignedTx).toHaveBeenCalledTimes(1);
    expect(ctl.state().phase).toBe("paused");
    expect(ctl.state().message).toMatch(/health factor/);
  });

  it("retries by itself when a step is paused only by a stale or slow read", async () => {
    vi.useFakeTimers();
    try {
      api.advancePlan
        .mockResolvedValueOnce({ plan: plan("paused", [step(1), step(2)]), step: step(1), pause_reason: "The SOL price is stale right now, so I won't build this. Try again in a minute." })
        .mockResolvedValueOnce({ plan: plan("running", [step(1, "awaiting_signature"), step(2)]), step: step(1, "awaiting_signature"), unsigned_tx: tx(1) })
        .mockResolvedValueOnce({ plan: plan("completed", [step(1, "confirmed"), step(2, "confirmed")]) });
      sign.signUnsignedTx.mockResolvedValue("signed");
      const { ctl } = run();
      const done = ctl.approve("d");
      await vi.advanceTimersByTimeAsync(10_000);
      await done;
      expect(api.advancePlan).toHaveBeenCalledTimes(3);
      expect(sign.signUnsignedTx).toHaveBeenCalledTimes(1);
      expect(ctl.state().phase).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cancel", () => {
  beforeEach(() => Object.values(api).forEach((f) => f.mockReset()));

  it("stops at once and ends the plan on the server, so a reopened chat cannot resume it", async () => {
    api.cancelPlan.mockResolvedValue({ plan: plan("cancelled", [step(1, "confirmed"), step(2)]) });
    const { ctl } = run();
    const done = ctl.cancel();
    expect(ctl.state().phase).toBe("cancelled");
    await done;
    expect(api.cancelPlan).toHaveBeenCalledWith("w");
    expect(ctl.state().phase).toBe("cancelled");
    expect(ctl.state().plan.state).toBe("cancelled");
  });

  it("stays stopped here when the server cannot be reached", async () => {
    api.cancelPlan.mockRejectedValue(new Error("offline"));
    const { ctl } = run();
    await ctl.cancel();
    expect(ctl.state().phase).toBe("cancelled");
  });
});
