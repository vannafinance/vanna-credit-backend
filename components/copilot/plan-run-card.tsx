"use client";

import type { PlanStepView, StepStatus } from "@/lib/copilot/types";
import { RUN_ACTIVE, type RunState } from "@/lib/copilot/client/run";
import { ExecutionStepper, type StepperStep } from "./execution-stepper";
import { AnswerView } from "./answer-view";

/**
 * The live execution card: one stepper that advances in place, the wallet checkpoint for the
 * step waiting on a signature, and the one honest sentence about why a run is paused.
 *
 * Every state comes from the server's `PlanView` (and the run controller that walks it), so the
 * card cannot claim a step finished before the chain confirmed it.
 */

function stepperStatus(status: StepStatus): StepperStep["status"] {
  switch (status) {
    case "building": return "claiming";
    case "awaiting_signature": return "signing";
    case "submitted": return "submitting";
    case "confirmed":
    case "done": return "settled";
    case "failed":
    case "expired": return "failed";
    case "uncertain": return "uncertain";
    default: return "pending";
  }
}

function toStepperStep(step: PlanStepView): StepperStep {
  return {
    id: `${step.n}-${step.op}`,
    label: step.label,
    op: step.op,
    asset: step.asset ?? "",
    amount: step.amount ?? "",
    status: stepperStatus(step.status),
    ...(step.signature ? { txHash: step.signature } : {}),
    ...(step.status === "expired"
      ? { error: "The transaction expired before it landed. Nothing was spent; it can be rebuilt." }
      : step.note
        ? { error: step.note }
        : {}),
  };
}

export interface PlanRunCardProps {
  run: RunState;
  onSign: () => void;
  onContinue: () => void;
  onRecheck: () => void;
  onCancel: () => void;
}

export function PlanRunCard({ run, onSign, onContinue, onRecheck, onCancel }: PlanRunCardProps) {
  const { plan, phase, pending } = run;
  const firstOpen = plan.steps.findIndex((s) => !["confirmed", "done", "skipped", "failed", "expired", "uncertain"].includes(s.status));
  const currentStepIndex = firstOpen === -1 ? Math.max(0, plan.steps.length - 1) : firstOpen;
  const busy = RUN_ACTIVE.has(phase);
  // While the server approves the plan or builds and checks the next transaction, the plan it last sent still shows
  // that step as pending, so nothing on the card moved until the wallet opened. Show the work: the step being
  // prepared spins with "Checking it before it is sent…" until the server answers.
  const preparing = (phase === "approving" || phase === "advancing") && firstOpen !== -1 && plan.steps[firstOpen]?.status === "pending";
  // Spinners mean "something is happening right now". Once the run has stopped (cancelled, failed, expired, paused,
  // an error), the server can still list a step as building or awaiting its signature: that step was never sent, so
  // it reads as not sent instead of spinning forever. A transaction that was sent and never confirmed reads as unknown.
  const stoppedRun = ["cancelled", "failed", "expired", "completed", "error", "paused"].includes(phase);
  const settle = (s: StepperStep): StepperStep =>
    !stoppedRun ? s
      : s.status === "claiming" || s.status === "signing" ? { ...s, status: "pending" }
        : s.status === "submitting" ? { ...s, status: "uncertain" }
          : s;
  const steps = plan.steps.map((s, i) => settle(preparing && i === firstOpen ? { ...toStepperStep(s), status: "claiming" as const } : toStepperStep(s)));
  const cancelled = phase === "cancelled";
  const hasSubmitted = plan.steps.some((s) => s.status === "submitted");
  const canContinue =
    phase === "paused" && !hasSubmitted && plan.steps.some((s) => s.status === "pending" || s.status === "expired");

  // One card for the whole run: the signature button sits on the step that waits for it (no second "wallet signature needed" card).
  const awaitingSignature = !!pending && (phase === "awaiting_signature" || phase === "signing");
  return (
    <div className="flex flex-col gap-3">
      <ExecutionStepper
        steps={steps}
        currentStepIndex={currentStepIndex}
        cancelled={cancelled}
        busy={busy}
        {...(awaitingSignature
          ? {
              onSign,
              walletOpen: phase === "signing",
              signDisabled: !pending!.tx.simulation_success,
              signNote: run.rejected ? null : run.message,
              rejected: run.rejected,
            }
          : {})}
        onStop={!["completed", "failed", "cancelled", "expired", "signing"].includes(phase) ? onCancel : undefined}
      />

      {phase === "confirming" && (
        <p role="status" className="flex items-center gap-3 text-[12.5px] leading-5 text-vgray-500">
          <span>{run.message ?? "Signature sent. Waiting for the chain to confirm."}</span>
          {run.message && run.message.startsWith("Still waiting") && (
            <button type="button" onClick={onRecheck} className="font-semibold text-violet-500 hover:text-violet-600">
              Check again
            </button>
          )}
        </p>
      )}

      {phase === "paused" && run.message && (
        <div
          role="note"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-[13px] leading-5"
          style={{ borderColor: "var(--pc-warn-bd)", background: "var(--pc-warn-bg)", color: "var(--pc-warn-fg)" }}
        >
          <span className="min-w-0 flex-1">{run.message}</span>
          <span className="flex shrink-0 items-center gap-2">
            {hasSubmitted && (
              <button type="button" onClick={onRecheck} className="rounded-lg border border-vgray-100 bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-vgray-800">
                Check again
              </button>
            )}
            {canContinue && (
              <button type="button" onClick={onContinue} className="rounded-lg bg-[image:var(--cp-gradient)] px-3.5 py-1.5 text-[12.5px] font-semibold text-white">
                Re-check and continue
              </button>
            )}
          </span>
        </div>
      )}

      {(phase === "failed" || phase === "error" || phase === "expired" || phase === "cancelled") && run.message && (
        <p role="alert" className="text-[12.5px] leading-5" style={{ color: phase === "cancelled" ? "var(--cp-g500)" : "var(--cp-danger-fg)" }}>
          {run.message}
        </p>
      )}
      {phase === "error" && (
        <button type="button" onClick={onContinue} className="self-start text-[12.5px] font-semibold text-violet-500 hover:text-violet-600">
          Try again
        </button>
      )}

      <RunReadAnswers run={run} />
    </div>
  );
}

/** What the user asked to see along the way, each at its own step, as soon as the plan reaches it (and a report the plan ended with). */
function RunReadAnswers({ run }: { run: RunState }) {
  const readAnswers = run.plan.steps.filter((s) => s.kind === "read" && s.status === "done" && s.answer);
  return (
    <>
      {readAnswers.map((s) => (
        <div key={s.n} className="rounded-2xl border border-vgray-100 bg-surface px-5 py-5">
          <p className="m-0 mb-3 text-[11px] font-semibold uppercase tracking-[.14em] text-vgray-500">
            Step {s.n} · {s.label}
          </p>
          <AnswerView answer={s.answer as NonNullable<typeof s.answer>} />
        </div>
      ))}
      {run.phase === "completed" && !readAnswers.length && run.answer && (
        <div className="rounded-2xl border border-vgray-100 bg-surface px-5 py-5">
          <AnswerView answer={run.answer} />
        </div>
      )}
    </>
  );
}
