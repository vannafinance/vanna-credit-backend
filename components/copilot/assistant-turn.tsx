"use client";

import { Loader2 } from "lucide-react";
import type { ChatResponse } from "@/lib/copilot/types";
import type { RunState } from "@/lib/copilot/client/run";
import { completionSummary } from "@/lib/copilot/client/completion";
import { AnswerView } from "./answer-view";
import { AssistantBody, AssistantMessage, AssistantRow } from "./chat-message";
import { ClarifyOptions } from "./clarify-options";
import { CompletionReply } from "./completion-reply";
import { ExecutionStepper } from "./execution-stepper";
import { ImpactPanel } from "./impact-panel";
import { NeedsLoginCard, type NeedsLoginCardProps } from "./needs-login-card";
import { PlanApprovalCard, PlanCountdown, usePlanCountdown } from "./plan-approval-card";
import { PlanRunCard } from "./plan-run-card";
import { ActionReviewCard, RiskChip } from "./review-card";

export interface PlanHandlers {
  approve: (workflowId: string, digest: string) => void;
  sign: (workflowId: string) => void;
  advance: (workflowId: string) => void;
  recheck: (workflowId: string) => void;
  cancel: (workflowId: string) => void;
}

export interface AssistantTurnProps {
  response: ChatResponse;
  run: RunState | undefined;
  /** Only the newest turn can answer a clarification or be approved; older ones are history. */
  isLatest: boolean;
  busy: boolean;
  plan: PlanHandlers;
  onPickClarify: (pendingId: string, option: { id: string; label: string }) => void;
  onModify: () => void;
  login: Omit<NeedsLoginCardProps, "busy"> & { busy: boolean };
}

/**
 * A single action's Approve / Cancel, with the 5-minute approval window counting down beside them (4:59 to 0:00).
 * Approve is closed once it runs out; once approved the run card replaces this, so the clock goes with it.
 */
function SingleActionFooter({ expiresAt, approving, blocked, onApprove, onCancel }: { expiresAt: number; approving: boolean; blocked: boolean; onApprove: () => void; onCancel: () => void }) {
  const { expired } = usePlanCountdown(expiresAt, !approving);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onApprove}
        disabled={blocked || approving || expired}
        className="inline-flex items-center gap-2 rounded-r2 bg-gradient px-4 py-2.5 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
      >
        {approving && <Loader2 size={14} className="animate-spin" aria-hidden />}
        {approving ? "Checking…" : expired ? "Expired: ask again" : "Approve and run"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={approving}
        className="rounded-r2 border border-vgray-100 px-4 py-2.5 text-[13px] font-semibold text-vgray-700 disabled:opacity-45"
      >
        Cancel
      </button>
      {!approving && (
        <span className="ml-auto">
          <PlanCountdown expiresAt={expiresAt} />
        </span>
      )}
    </div>
  );
}

/** Plan approval while proposed; the live run card once approved; a one-line note if it was dropped. */
function PlanArea({ response, run, plan, busy, onModify }: Pick<AssistantTurnProps, "response" | "run" | "plan" | "busy" | "onModify">) {
  if (!run || !response.workflow_id) return null;
  const id = response.workflow_id;
  const started = run.plan.steps.some((s) => s.status !== "pending");
  const single = run.plan.steps.length === 1 && !!response.preview;

  // Finished: the turn above is now the reply about what was done (CompletionReply), so the review and run cards go.
  if (run.phase === "completed" && completionSummary(run.plan)) return null;

  if (run.phase === "cancelled" && !started) {
    return <p className="mt-3 text-[13px] leading-5 text-vgray-500">Plan cancelled. Nothing was sent.</p>;
  }

  const proposed = run.phase === "proposed" || run.phase === "approving";
  if (proposed) {
    if (single) {
      return (
        <ActionReviewCard
          preview={response.preview!}
          hfFloor={run.plan.hf_floor}
          footer={
            <SingleActionFooter
              expiresAt={run.plan.expires_at}
              approving={run.phase === "approving"}
              blocked={busy || response.preview!.risk.decision === "block"}
              onApprove={() => plan.approve(id, run.plan.digest)}
              onCancel={() => plan.cancel(id)}
            />
          }
        />
      );
    }
    return (
      <>
        <PlanApprovalCard
          plan={run.plan}
          busy={run.phase === "approving"}
          error={run.message}
          onApprove={(digest) => plan.approve(id, digest)}
          onModify={onModify}
          onCancel={() => plan.cancel(id)}
        />
        {run.plan.simulation && <ImpactPanel sim={run.plan.simulation} floor={run.plan.hf_floor} />}
      </>
    );
  }

  return (
    <>
      {response.preview && run.plan.steps.length === 1 && <ActionReviewCard preview={response.preview} hfFloor={run.plan.hf_floor} />}
      <div className={response.preview && run.plan.steps.length === 1 ? "mt-3" : undefined}>
        <PlanRunCard
          run={run}
          onSign={() => plan.sign(id)}
          onContinue={() => plan.advance(id)}
          onRecheck={() => plan.recheck(id)}
          onCancel={() => plan.cancel(id)}
        />
      </div>
    </>
  );
}

export function AssistantTurn({ response, run, isLatest, busy, plan, onPickClarify, onModify, login }: AssistantTurnProps) {
  const isError = response.kind === "error";
  const hasPlanCard = response.kind === "plan_preview" || response.kind === "preview" || response.kind === "needs_wallet_sign";

  // The review / plan card already says what will happen; the reply written for it (the summary, the step list, "the
  // MCP simulated this", "approve to continue") only repeated the card, so the card stands alone while it is drawn.
  const cardDrawn = hasPlanCard && !!run && !!response.workflow_id;
  const singleCard = cardDrawn && !!response.preview && run!.plan.steps.length === 1;
  const notStarted = !!run && run.plan.steps.every((s) => s.status === "pending");
  // Once the plan has run, the reply is what was done (Gemini's words from the plan's facts), in place of the cards.
  const completed = hasPlanCard && run?.phase === "completed" && !!completionSummary(run.plan);

  let body: React.ReactNode;
  if (completed) {
    body = <CompletionReply run={run!} />;
  } else if (cardDrawn && run!.phase === "cancelled" && notStarted) {
    body = <AssistantBody text={singleCard ? response.preview!.human_summary : run!.plan.summary} />;
  } else if (cardDrawn) {
    body = null;
  } else if (response.kind === "answer" && response.answer) {
    body = <AnswerView answer={response.answer} />;
  } else if (response.kind === "executed" || response.kind === "answer") {
    body = <AssistantBody text={response.message} />;
  } else {
    body = (
      <AssistantMessage tone={isError ? "error" : "default"} note={response.answer?.note ?? null}>
        {response.message}
      </AssistantMessage>
    );
  }

  const showRow = body !== null || !!response.limit || response.kind === "blocked";

  return (
    <div className="flex flex-col gap-3">
      {showRow && (
        <AssistantRow>
          {response.kind === "blocked" && (
            <span className="self-start">
              <RiskChip decision="block" />
            </span>
          )}
          {body}
          {response.limit && (
            <p role="note" className="text-[12.5px] leading-5 text-vgray-500">
              {response.limit.message}
              {response.limit.retry_after_s ? ` Try again in ${Math.ceil(response.limit.retry_after_s)}s.` : ""}
            </p>
          )}
          {response.kind === "clarification" && isLatest && response.clarify_options && response.pending_id && (
            <ClarifyOptions
              options={response.clarify_options}
              disabled={busy}
              onPick={(option) => onPickClarify(response.pending_id!, option)}
            />
          )}
          {response.kind === "executed" && response.execution && (
            <ExecutionStepper
              steps={[
                {
                  id: "direct",
                  label: "",
                  op: response.preview?.template_id ?? "transaction",
                  asset: "",
                  amount: "",
                  status: /confirm|settled|success/i.test(response.execution.status) ? "settled" : "uncertain",
                  ...(response.execution.signature ? { txHash: response.execution.signature } : {}),
                },
              ]}
              currentStepIndex={0}
            />
          )}
          {response.kind === "executed" && response.execution?.hf_after != null && (
            <p className="text-[12.5px] text-vgray-500">Health factor after: {response.execution.hf_after.toFixed(2)}</p>
          )}
        </AssistantRow>
      )}

      {response.kind === "needs_login" && isLatest && <NeedsLoginCard {...login} />}
      {hasPlanCard && <PlanArea response={response} run={run} plan={plan} busy={busy} onModify={onModify} />}
    </div>
  );
}
