"use client";

import type { PlanStepView, StepStatus } from "@/lib/copilot/types";
import { RUN_ACTIVE, type RunState } from "@/lib/copilot/client/run";
import { ExecutionStepper, type StepperStep } from "./execution-stepper";
import { StepApprovalCard } from "./step-approval-card";
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
  const steps = plan.steps.map(toStepperStep);
  const firstOpen = plan.steps.findIndex((s) => !["confirmed", "done", "skipped", "failed", "expired", "uncertain"].includes(s.status));
  const currentStepIndex = firstOpen === -1 ? Math.max(0, steps.length - 1) : firstOpen;
  const busy = RUN_ACTIVE.has(phase);
  const cancelled = phase === "cancelled";
  const hasSubmitted = plan.steps.some((s) => s.status === "submitted");
  const canContinue =
    phase === "paused" && !hasSubmitted && plan.steps.some((s) => s.status === "pending" || s.status === "expired");

  return (
    <div className="flex flex-col gap-3">
      <ExecutionStepper
        steps={steps}
        currentStepIndex={currentStepIndex}
        cancelled={cancelled}
        busy={busy}
        onStop={!["completed", "failed", "cancelled", "expired"].includes(phase) && phase !== "awaiting_signature" ? onCancel : undefined}
      />

      {pending && (phase === "awaiting_signature" || phase === "signing") && (
        <StepApprovalCard
          step={pending.step}
          totalSteps={plan.steps.length}
          tx={pending.tx}
          projectedHf={null}
          signing={phase === "signing"}
          rejected={run.rejected}
          error={run.rejected ? null : run.message}
          onSign={onSign}
          onCancel={onCancel}
        />
      )}

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

      {phase === "completed" && run.answer && (
        <div className="rounded-2xl border border-vgray-100 bg-surface px-5 py-5">
          <AnswerView answer={run.answer} />
        </div>
      )}
    </div>
  );
}
