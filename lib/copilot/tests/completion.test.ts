import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake model: no Gemini call is ever made by these tests.
const llm = vi.hoisted(() => ({ configured: true, text: "" as string | null }));
vi.mock("../vertex", async (importActual) => ({
  ...(await importActual<typeof import("../vertex")>()),
  llmConfigured: () => llm.configured,
  getLlm: () => ({ generate: async () => ({ text: llm.text, tokens: 1 }) }),
}));

import { completionFacts, composeCompletion, fallbackCompletion } from "../workflow/completion";
import type { StoredStep, WorkflowRecord } from "../workflow/types";

const step = (n: number, label: string, patch: Partial<StoredStep> = {}): StoredStep =>
  ({
    n, kind: "write", op: "deposit", asset: "SOL", amount: "2", slots: {}, label, venue: "margin", status: "confirmed",
    claim: null, claimed_at: null, tx: null, signature: `5fk5PcSig${n}`, submitted_at: null, usd: null, note: null,
    resolved: null, builds: 1, ...patch,
  }) as StoredStep;

const record = (steps: StoredStep[]): WorkflowRecord =>
  ({
    v: 1, id: "wf", subject: "s", wallet: "w", digest: "d", summary: "Deposit 2 SOL, then borrow 400 USDC.", created_at: 0,
    expires_at: 0, approved_at: 0, hf_floor: 1.15, state: "completed", pause_reason: null, warnings: [], simulation: null,
    steps, request_id: null, conversation_id: null, log: [],
  }) as WorkflowRecord;

const rec = record([
  step(1, "Deposit 2 SOL as margin collateral"),
  step(2, "Borrow 400 USDC against your margin collateral", { op: "borrow", asset: "USDC", amount: "400" }),
  step(3, "Show your health factor", {
    kind: "read", op: "report", status: "done", signature: null,
    answer: { headline: "Your health factor is 4.81 on your margin account.", facts: [], venue: "margin" },
  }),
]);

beforeEach(() => {
  llm.configured = true;
  llm.text = null;
});

describe("completion facts", () => {
  it("lists confirmed transactions and report answers, never a signature", () => {
    const facts = completionFacts(rec);
    expect(facts).toContain("Step 1 (transaction, confirmed): Deposit 2 SOL as margin collateral");
    expect(facts).toContain("Your health factor is 4.81");
    expect(facts).not.toContain("5fk5PcSig");
  });
});

describe("composeCompletion", () => {
  it("uses the model's words when every figure is in the facts", async () => {
    llm.text = JSON.stringify({
      headline: "All set: your 2 SOL is in and the 400 USDC loan is out. Your health factor is now 4.81.",
      steps: [{ n: 1, text: "Deposited 2 SOL as collateral" }, { n: 2, text: "Borrowed 400 USDC" }],
    });
    const out = await composeCompletion(rec);
    expect(out.worded).toBe(true);
    expect(out.headline).toContain("4.81");
    expect(out.steps).toEqual([{ n: 1, text: "Deposited 2 SOL as collateral" }, { n: 2, text: "Borrowed 400 USDC" }]);
  });

  it("refuses a headline with a figure the plan does not hold", async () => {
    llm.text = JSON.stringify({ headline: "Done: your health factor is 7.25.", steps: [] });
    expect(await composeCompletion(rec)).toEqual(fallbackCompletion(rec));
  });

  it("keeps a step's own label when the model leaves it out or invents a number", async () => {
    llm.text = JSON.stringify({ headline: "All done.", steps: [{ n: 2, text: "Borrowed 900 USDC" }] });
    const out = await composeCompletion(rec);
    expect(out.worded).toBe(true);
    expect(out.steps).toEqual([
      { n: 1, text: "Deposited 2 SOL as margin collateral" },
      { n: 2, text: "Borrowed 400 USDC against your margin collateral" },
    ]);
  });

  it("falls back to the step labels without a model", async () => {
    llm.configured = false;
    const out = await composeCompletion(rec);
    expect(out).toEqual({
      headline: "Done. All 2 transactions are confirmed on chain.",
      steps: [
        { n: 1, text: "Deposited 2 SOL as margin collateral" },
        { n: 2, text: "Borrowed 400 USDC against your margin collateral" },
      ],
      worded: false,
    });
  });
});
