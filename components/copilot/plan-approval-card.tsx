"use client";

/**
 * Plan approval card: the checkpoint between a server-held plan and the first wallet signature.
 *
 * Renders the real `plan_preview` payload. Approving posts only the plan's digest: amounts,
 * assets and instructions stay on the server, and the approval is refused there if the plan
 * changed or its 5-minute window has passed. The card mirrors that window with a live clock
 * and stops offering Approve once it lapses.
 *
 * The card owns its colours through `--pc-*` (the `.plan-card` block in app/globals.css) rather
 * than the shared `--cp-*` scale. It is the gate in front of transactions that move real money,
 * so it has to stay legible in both themes and cannot lose a colour to a token declared in one
 * theme block only. Busy never repaints the primary button grey; only an expired or empty plan
 * does.
 *
 * A missing amount renders as "amount to be confirmed", never blank or 0.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { LIQUIDATION_HF_TEXT } from "@/lib/copilot/protocol-constants";
import type { PlanStepView, PlanView, Venue } from "@/lib/copilot/types";

const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

function venueTokens(venue: Venue) {
  // Swaps settle through Jupiter into a venue position, so they share the farm palette.
  const key = venue === "swap" ? "farm" : venue === "other" ? "wallet" : venue === "perps" ? "margin" : venue;
  return {
    fg: `var(--pc-${key}-fg)`,
    bg: `var(--pc-${key}-bg)`,
    bd: `var(--pc-${key}-bd)`,
  };
}

function formatAmount(amount: string | null): string | null {
  if (amount == null || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return n.toLocaleString(undefined, { maximumFractionDigits: 9 });
}

function slotNumber(step: PlanStepView, key: string): number {
  const v = step.slots?.[key];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function planExecutionSummary(plan: Pick<PlanView, "steps" | "signature_count">) {
  const writeCount = plan.steps.filter((s) => s.kind !== "read").length;
  const readCount = plan.steps.filter((s) => s.kind === "read").length;
  return {
    stepCount: plan.steps.length,
    writeCount,
    readCount,
    signatureCount: plan.signature_count || writeCount,
  };
}

export interface PlanApprovalCardProps {
  plan: PlanView;
  /** Approve by digest. */
  onApprove: (digest: string) => void;
  /** Put the original prompt back in the composer for editing. */
  onModify: () => void;
  onCancel: () => void;
  /** True while the approval or the run is in flight. */
  busy?: boolean;
  /** The plan is past `proposed` (approved, running, finished): Approve is not offered again. */
  disabled?: boolean;
  /** An approval attempt failed on the server; shown with the plan's own warnings. */
  error?: string | null;
}

export function PlanApprovalCard({ plan, onApprove, onModify, onCancel, busy = false, disabled = false, error = null }: PlanApprovalCardProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (plan.state !== "proposed") return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [plan.state]);

  const remaining = plan.expires_at - now;
  const expired = remaining <= 0 || plan.state === "expired";
  const clock = mmss(remaining);

  const meta = useMemo(() => {
    const stepCount = plan.steps.length;
    const sigs = plan.signature_count || stepCount;
    // Venues describe where funds GO; a read leg has none.
    const venues: string[] = [];
    for (const s of plan.steps) if (s.kind !== "read" && !venues.includes(s.venue)) venues.push(s.venue);
    return {
      stepsText: stepCount === 1 ? "1 step" : `${stepCount} steps`,
      sigText: sigs === 1 ? "1 signature" : `${sigs} signatures`,
      sigNote: sigs > stepCount ? " (a levered step signs more than once)" : "",
      levered: sigs > stepCount,
      venueText: venues.join(" → "),
    };
  }, [plan.steps, plan.signature_count]);

  const execution = useMemo(() => planExecutionSummary(plan), [plan]);

  const unusable = expired || plan.steps.length === 0 || disabled;
  const approveBlocked = unusable || busy;
  const approveLabel = expired ? "Plan expired" : busy ? "Running…" : "Approve & run";

  const clockColor = expired ? "var(--pc-danger-fg)" : "var(--pc-heading)";
  const clockLabelColor = expired ? "var(--pc-danger-fg)" : "var(--pc-muted)";

  const warnings = error ? [...plan.warnings, error] : plan.warnings;
  const showNotices = expired || warnings.length > 0;

  return (
    <div
      className="plan-card mt-7"
      role="group"
      aria-label="Plan approval"
      style={{
        border: "1px solid var(--pc-line)",
        borderRadius: 14,
        background: "var(--pc-surface)",
        padding: "20px 22px 18px",
      }}
    >
      {/* header: stage label, waiting is not a timeout */}
      <div className="flex items-center justify-between gap-5">
        <p
          className="m-0 uppercase"
          style={{
            fontFamily: MONO,
            fontSize: 11,
            letterSpacing: ".2em",
            color: "var(--pc-muted)",
          }}
        >
          <span style={{ color: "var(--pc-accent)" }}>03</span> · approve plan
        </p>
        <p
          aria-live="polite"
          className="m-0 flex items-baseline gap-2"
          style={{
            fontFamily: MONO,
            fontVariantNumeric: "tabular-nums",
            color: clockColor,
          }}
        >
          <span
            className="uppercase"
            style={{
              fontSize: 10,
              letterSpacing: ".18em",
              color: clockLabelColor,
            }}
          >
            {expired ? "expired" : `expires in ${clock}`}
          </span>
        </p>
      </div>

      <h2
        className="m-0 mt-3.5 font-semibold"
        style={{
          fontSize: 20,
          lineHeight: "29px",
          color: "var(--pc-heading)",
          textWrap: "pretty",
        }}
      >
        {plan.summary}
      </h2>

      {/* execution plan */}
      <div
        className="mt-4"
        style={{
          border: "1px solid var(--pc-line-soft)",
          borderRadius: 12,
          background: "var(--pc-inset)",
          padding: "4px 16px",
        }}
      >
        {plan.steps.map((s, i) => {
          const v = venueTokens(s.venue);
          const last = i === plan.steps.length - 1;
          const amount = formatAmount(s.amount);
          return (
            <div key={`${s.n}-${s.op}`} className="flex items-stretch gap-3.5">
              {/* rail: number + connector */}
              <div className="flex w-[26px] flex-shrink-0 flex-col items-center pt-[15px]">
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 17,
                    lineHeight: "20px",
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--pc-accent)",
                  }}
                >
                  {s.n}
                </span>
                <span
                  className="mt-1.5 w-px flex-1"
                  style={{
                    background: last ? "transparent" : "var(--pc-line)",
                  }}
                />
              </div>

              <div
                className="flex min-w-0 flex-1 items-start justify-between gap-[18px]"
                style={{
                  padding: "14px 0",
                  borderBottom: `1px solid ${last ? "transparent" : "var(--pc-line-soft)"}`,
                }}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-[9px]">
                    <span
                      className="uppercase"
                      style={{
                        border: `1px solid ${v.bd}`,
                        background: v.bg,
                        color: v.fg,
                        borderRadius: 5,
                        padding: "3px 8px",
                        fontFamily: MONO,
                        fontSize: 9.5,
                        fontWeight: 700,
                        letterSpacing: ".18em",
                      }}
                    >
                      {s.venue}
                    </span>
                    <span
                      className="uppercase"
                      style={{
                        fontFamily: MONO,
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: ".14em",
                        color: "var(--pc-muted)",
                      }}
                    >
                      {s.kind === "read" ? "report" : s.op.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p
                    className="m-0 mt-2"
                    style={{
                      fontSize: 14.5,
                      lineHeight: "21px",
                      color: "var(--pc-body)",
                      textWrap: "pretty",
                    }}
                  >
                    {s.label}
                  </p>
                </div>

                <div className="flex-shrink-0 text-right">
                  {/* A read leg has no size and asks for no signature, so it gets neither
                      the amount figure nor the "amount to be confirmed" warning — that
                      warning is about a write that will stop mid-plan to ask. */}
                  {s.kind === "read" ? (
                    <p
                      className="m-0"
                      style={{
                        fontFamily: MONO,
                        fontSize: 11.5,
                        lineHeight: "26px",
                        fontWeight: 600,
                        letterSpacing: ".12em",
                        color: "var(--pc-muted)",
                      }}
                    >
                      no signature
                    </p>
                  ) : amount ? (
                    <p
                      className="m-0"
                      style={{
                        fontFamily: MONO,
                        fontSize: 21,
                        lineHeight: "26px",
                        fontWeight: 600,
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--pc-heading)",
                      }}
                    >
                      {amount}
                    </p>
                  ) : slotNumber(s, "leverage") > 1 ? (
                    <p
                      className="m-0"
                      style={{
                        fontFamily: MONO,
                        fontSize: 16,
                        lineHeight: "26px",
                        fontWeight: 700,
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--pc-heading)",
                      }}
                    >
                      {`${slotNumber(s, "leverage")}× AUTO`}
                    </p>
                  ) : (
                    <p
                      className="m-0"
                      style={{
                        fontFamily: MONO,
                        fontSize: 11.5,
                        lineHeight: "26px",
                        fontWeight: 600,
                        color: "var(--pc-warn-fg)",
                        maxWidth: 124,
                      }}
                    >
                      amount to be confirmed
                    </p>
                  )}
                  {s.asset ? (
                    <p
                      className="m-0 mt-0.5"
                      style={{
                        fontFamily: MONO,
                        fontSize: 11.5,
                        fontWeight: 600,
                        letterSpacing: ".12em",
                        color: "var(--pc-muted)",
                      }}
                    >
                      {slotNumber(s, "leverage") > 1 ? `AUTO-SIZED · ${s.asset}` : s.asset}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Signature count can exceed step count. That difference is not a typo, so it is
          weighted differently from the rest of the line. */}
      <p
        className="m-0 mt-3"
        style={{
          fontFamily: MONO,
          fontSize: 11.5,
          lineHeight: "18px",
          color: "var(--pc-muted)",
        }}
      >
        {meta.stepsText} ·{" "}
        <span
          style={{
            color: meta.levered ? "var(--pc-accent)" : "var(--pc-body)",
            fontWeight: 700,
          }}
        >
          {meta.sigText}
        </span>
        {meta.sigNote}
        {meta.venueText ? ` · ${meta.venueText}` : ""}
      </p>

      <div
        className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5"
        role="note"
        aria-label="Execution preview"
        style={{
          border: "1px solid var(--pc-line-soft)",
          borderRadius: 9,
          background: "var(--pc-inset)",
          padding: "9px 12px",
          fontFamily: MONO,
          fontSize: 10.5,
          lineHeight: "17px",
          color: "var(--pc-muted)",
        }}
      >
        <span style={{ color: "var(--pc-body)", fontWeight: 700 }}>execution preview</span>
        <span>{execution.stepCount} planned {execution.stepCount === 1 ? "step" : "steps"}</span>
        <span>{execution.signatureCount} wallet {execution.signatureCount === 1 ? "signature" : "signatures"}</span>
        {execution.readCount > 0 ? <span>{execution.readCount} read-only</span> : null}
        <span>health floor {plan.hf_floor.toFixed(2)} · liquidation at {LIQUIDATION_HF_TEXT}</span>
      </div>

      {/* Warnings — never dismissable, always above the buttons. One tinted block holding
          compact rows rather than a stack of full-size panels: boxed panels each the
          height of a paragraph pushed Approve below the fold, which made the plan itself
          the smaller element. */}
      {showNotices ? (
        <div
          className="mt-3.5 flex flex-col gap-1.5"
          style={{
            border: `1px solid ${expired ? "var(--pc-danger-bd)" : "var(--pc-warn-bd)"}`,
            background: expired ? "var(--pc-danger-bg)" : "var(--pc-warn-bg)",
            borderRadius: 10,
            padding: "9px 12px",
          }}
        >
          {expired ? (
            <p
              role="alert"
              className="m-0 flex items-start gap-[9px]"
              style={{
                fontSize: 13,
                lineHeight: "19px",
                color: "var(--pc-danger-fg)",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  fontWeight: 700,
                  lineHeight: "19px",
                }}
              >
                !
              </span>
              This plan passed its 5-minute approval window. Nothing was sent. Ask again for a fresh one.
            </p>
          ) : null}
          {warnings.map((text) => (
            <p
              key={text}
              role="note"
              className="m-0 flex items-start gap-[9px]"
              style={{
                fontSize: 13,
                lineHeight: "19px",
                color: expired ? "var(--pc-danger-fg)" : "var(--pc-warn-fg)",
                textWrap: "pretty",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  fontFamily: MONO,
                  fontSize: 12,
                  fontWeight: 700,
                  lineHeight: "19px",
                }}
              >
                !
              </span>
              {text}
            </p>
          ))}
        </div>
      ) : null}

      {/* actions */}
      <div className="mt-4 flex items-stretch gap-2.5">
        <button
          type="button"
          onClick={() => onApprove(plan.digest)}
          disabled={approveBlocked}
          aria-disabled={approveBlocked ? "true" : "false"}
          className="pc-btn-1 flex-1"
          style={{
            border: "1px solid transparent",
            borderRadius: 10,
            padding: "14px 22px",
            fontFamily: "inherit",
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: ".01em",
            cursor: unusable ? "not-allowed" : busy ? "progress" : "pointer",
            background: unusable
              ? "var(--pc-btn-off-bg)"
              : "var(--pc-btn-fill)",
            color: unusable ? "var(--pc-btn-off-fg)" : "var(--pc-btn-fg)",
          }}
        >
          {busy && !unusable ? (
            <span className="inline-flex items-center justify-center gap-2">
              <Loader2 size={15} className="animate-spin" aria-hidden />
              {approveLabel}
            </span>
          ) : approveLabel}
        </button>
        <button
          type="button"
          onClick={onModify}
          className="pc-btn-2 cursor-pointer transition-colors"
          // Border and colour come from .pc-btn-2 in globals.css — inline values here
          // would outrank the :hover rule and kill the tint.
          style={{
            borderRadius: 10,
            background: "transparent",
            padding: "14px 20px",
            fontFamily: "inherit",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Modify
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="pc-btn-3 cursor-pointer transition-colors"
          style={{
            borderRadius: 10,
            background: "transparent",
            padding: "14px",
            fontFamily: "inherit",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          Cancel
        </button>
      </div>

      {/* plan_id — the proof that what executes is what was shown */}
      <p
        className="m-0 mt-3 text-right"
        title={`plan_id ${plan.plan_id}`}
        style={{
          fontFamily: MONO,
          fontSize: 11,
          letterSpacing: ".04em",
          color: "var(--pc-quiet)",
        }}
      >
        plan {plan.plan_id.slice(0, 10)}…{plan.plan_id.slice(-3)} · digest {plan.digest.slice(0, 8)}
      </p>
    </div>
  );
}
