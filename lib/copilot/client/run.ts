/**
 * Drives one server-held plan from approval to completion, one wallet signature at a time.
 *
 * The server owns the plan; this file only walks it:
 *   approve(digest) -> advance -> [needs a signature] -> wallet signs -> submit -> poll confirm -> advance ...
 *
 * Rules it keeps, mirrored from the server contract:
 *  - A step is never reported done until `confirm` says `confirmed` (the chain, not the wallet).
 *  - A wallet rejection reports NOTHING to the server. The step stays awaiting its signature and the
 *    user decides: sign again, or cancel here (the plan then simply lapses on the server).
 *  - `uncertain` is never retried. `expired` is rebuilt only by an explicit `advance` the user asks for.
 *  - Each signature is an explicit click on the step card; there is no auto-sign path.
 */

import type { PlanStepView, PlanView, StructuredAnswer, UnsignedTx } from "@/lib/copilot/types";
import { advancePlan, approvePlan, confirmStep, CopilotApiError, getWorkflow, submitStep } from "./api";
import { signUnsignedTx, WalletRejectedError, type SignTransaction } from "./sign";

export type RunPhase =
  | "proposed" // plan shown, not approved
  | "approving"
  | "advancing" // server claiming / building the next step
  | "awaiting_signature" // unsigned tx in hand, waiting for the user to sign
  | "signing" // wallet popup open
  | "submitting"
  | "confirming" // signature sent, polling the chain
  | "paused" // server paused the plan (health floor, price moved, ...) or a step expired
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "error"; // the client could not reach the server, or it answered off-contract

export interface RunState {
  workflowId: string;
  plan: PlanView;
  phase: RunPhase;
  /** The write step waiting on the wallet, with the transaction to sign. */
  pending: { step: PlanStepView; tx: UnsignedTx } | null;
  /** Shown under the card: a pause reason, a rejection, an error. */
  message: string | null;
  /** The last wallet prompt was declined; the step is still waiting. */
  rejected: boolean;
  /** Report leg output, when the plan ended with one. */
  answer: StructuredAnswer | null;
}

export const RUN_ACTIVE: ReadonlySet<RunPhase> = new Set(["approving", "advancing", "signing", "submitting", "confirming"]);

export function initialRunState(workflowId: string, plan: PlanView): RunState {
  return {
    workflowId,
    plan,
    phase: phaseFromPlan(plan),
    pending: null,
    message: null,
    rejected: false,
    answer: null,
  };
}

function phaseFromPlan(plan: PlanView): RunPhase {
  switch (plan.state) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "expired": return "expired";
    case "paused": return "paused";
    case "proposed": return "proposed";
    default: return "paused"; // approved / running with nothing in flight here: resume explicitly
  }
}

const CONFIRM_INTERVAL_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 120_000;
const TERMINAL_STEP = new Set(["confirmed", "failed", "expired", "uncertain", "skipped", "done"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RunController {
  approve(digest: string): Promise<void>;
  /** Claim the next step (also used to resume a paused plan or rebuild an expired step). */
  advance(): Promise<void>;
  /** The user clicked Sign on the pending step. */
  sign(): Promise<void>;
  /** Poll the chain again for a step that was sent but not yet seen confirmed. */
  recheck(): Promise<void>;
  /** Stop here. The plan lapses on the server; nothing is reported to it. */
  cancel(): void;
  /** Re-read the plan from the server (used when a stored conversation is reopened). */
  refresh(): Promise<void>;
  state(): RunState;
}

export interface RunOptions {
  initial: RunState;
  onState: (state: RunState) => void;
  /** Called after a step is confirmed on chain, so balances and health can be re-read. */
  onSettled?: (plan: PlanView) => void;
  signTransaction?: SignTransaction;
}

function describe(error: unknown): string {
  if (error instanceof CopilotApiError) {
    if (error.status === 0) return "The Copilot server is not reachable. Your plan is unchanged.";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function createRunController(opts: RunOptions): RunController {
  let current = opts.initial;
  let cancelled = false;
  let inFlight = false;

  const set = (patch: Partial<RunState>) => {
    current = { ...current, ...patch };
    opts.onState(current);
  };
  const setPlan = (plan: PlanView, patch: Partial<RunState> = {}) => set({ plan, ...patch });

  /** Run one action at a time: a double click must never claim or send a step twice. */
  async function exclusive(fn: () => Promise<void>): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      await fn();
    } finally {
      inFlight = false;
    }
  }

  async function advanceLoop(): Promise<void> {
    while (!cancelled) {
      set({ phase: "advancing", message: null, rejected: false, pending: null });
      let res;
      try {
        res = await advancePlan(current.workflowId);
      } catch (error) {
        set({ phase: "error", message: describe(error) });
        return;
      }
      setPlan(res.plan);
      if (res.answer) set({ answer: res.answer });

      if (res.unsigned_tx && res.step) {
        set({ phase: "awaiting_signature", pending: { step: res.step, tx: res.unsigned_tx }, message: res.message ?? null });
        return;
      }
      if (res.pause_reason) {
        set({ phase: "paused", message: res.pause_reason });
        return;
      }
      const terminal = phaseFromPlan(res.plan);
      if (terminal === "completed" || terminal === "failed" || terminal === "cancelled" || terminal === "expired") {
        set({ phase: terminal, message: res.message ?? null });
        opts.onSettled?.(res.plan);
        return;
      }
      if (!res.step) {
        // Nothing claimed and nothing said: stop rather than spin against the server.
        set({ phase: "paused", message: res.message ?? "The plan has nothing more to run right now." });
        return;
      }
      // A read leg ran inline on the server; take the next step.
    }
  }

  async function confirmLoop(stepN: number): Promise<"settled" | "stopped"> {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (!cancelled) {
      set({ phase: "confirming" });
      try {
        const res = await confirmStep(current.workflowId, { step_n: stepN });
        setPlan(res.plan);
        if (TERMINAL_STEP.has(res.status)) {
          if (res.status === "confirmed" || res.status === "done") {
            opts.onSettled?.(res.plan);
            return "settled";
          }
          if (res.status === "expired") {
            set({ phase: "paused", pending: null, message: res.message ?? "The transaction expired before it landed. Nothing was spent; rebuild it to continue." });
          } else if (res.status === "uncertain") {
            set({ phase: "paused", pending: null, message: res.message ?? "It is not known whether this landed. Check the explorer before doing anything else." });
          } else {
            set({ phase: "failed", pending: null, message: res.message ?? "The transaction failed on chain." });
          }
          return "stopped";
        }
      } catch (error) {
        set({ phase: "confirming", message: describe(error) });
      }
      if (Date.now() > deadline) {
        set({ phase: "confirming", message: "Still waiting for the chain to confirm. You can check again." });
        return "stopped";
      }
      await sleep(CONFIRM_INTERVAL_MS);
    }
    return "stopped";
  }

  return {
    state: () => current,

    approve: (digest) =>
      exclusive(async () => {
        set({ phase: "approving", message: null });
        try {
          const res = await approvePlan(current.workflowId, { digest });
          setPlan(res.plan);
        } catch (error) {
          set({ phase: "proposed", message: describe(error) });
          return;
        }
        await advanceLoop();
      }),

    advance: () => exclusive(advanceLoop),

    sign: () =>
      exclusive(async () => {
        const pending = current.pending;
        if (!pending) return;
        set({ phase: "signing", message: null, rejected: false });
        let signed: string;
        try {
          signed = await signUnsignedTx(pending.tx.transaction, opts.signTransaction);
        } catch (error) {
          if (error instanceof WalletRejectedError) {
            // Nothing is reported to the server; the same transaction can be signed again.
            set({ phase: "awaiting_signature", rejected: true, message: error.message });
            return;
          }
          set({ phase: "awaiting_signature", message: describe(error) });
          return;
        }
        set({ phase: "submitting" });
        try {
          const res = await submitStep(current.workflowId, { step_n: pending.step.n, signed_tx: signed });
          setPlan(res.plan);
          if (res.status === "failed" || res.status === "expired") {
            set({ phase: res.status === "failed" ? "failed" : "paused", pending: null, message: res.message ?? "The server did not send the transaction." });
            return;
          }
        } catch (error) {
          // The signed bytes may or may not have been sent: never resend from here.
          set({ phase: "paused", pending: null, message: `${describe(error)} Check the step before continuing.` });
          return;
        }
        set({ pending: null });
        const outcome = await confirmLoop(pending.step.n);
        if (outcome === "settled") await advanceLoop();
      }),

    recheck: () =>
      exclusive(async () => {
        const step = current.plan.steps.find((s) => s.status === "submitted");
        if (!step) return;
        const outcome = await confirmLoop(step.n);
        if (outcome === "settled") await advanceLoop();
      }),

    cancel: () => {
      cancelled = true;
      set({ phase: "cancelled", pending: null, message: "Stopped here. Steps already confirmed stay on chain; nothing further will be sent." });
    },

    refresh: async () => {
      try {
        const plan = await getWorkflow(current.workflowId);
        setPlan(plan, { phase: current.pending ? current.phase : phaseFromPlan(plan) });
      } catch {
        /* a stored plan the server no longer knows stays as last seen */
      }
    },
  };
}
