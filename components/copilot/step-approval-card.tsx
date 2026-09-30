"use client";

import { ChevronRight, Loader2, XCircle } from "lucide-react";
import type { PlanStepView, UnsignedTx } from "@/lib/copilot/types";

export interface StepApprovalCardProps {
  step: PlanStepView;
  totalSteps: number;
  /** The transaction the server built and simulated for this step. */
  tx: UnsignedTx;
  projectedHf?: string | null;
  /** The wallet popup is open. */
  signing?: boolean;
  /** The last prompt was declined in the wallet: the same transaction can be signed again. */
  rejected?: boolean;
  error?: string | null;
  onSign: () => void;
  onCancel?: () => void;
}

const BTN_GRADIENT = "bg-[linear-gradient(135deg,#ff6b6e_0%,#8557ef_100%)] text-white hover:opacity-95 active:opacity-100 transition-opacity shadow-sm";

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

/** The per-step wallet checkpoint: what this one signature does, then the button that opens the wallet. */
export function StepApprovalCard({ step, totalSteps, tx, projectedHf, signing = false, rejected = false, error = null, onSign, onCancel }: StepApprovalCardProps) {
  const label = step.label || `${step.op.replace(/_/g, " ")} ${step.amount ?? ""} ${step.asset ?? ""}`.trim();
  return (
    <div
      role="region"
      aria-label={`Step ${step.n} approval`}
      className="rounded-xl border border-violet-500/50 bg-surface p-4 text-vgray-900 shadow-md"
      style={{ borderLeft: "3px solid var(--violet-500, #8b5cf6)" }}
    >
      <div className="mb-3 flex items-center justify-between border-b border-vgray-100 pb-2.5">
        <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-violet-500">Wallet signature needed</span>
        <span className="font-mono text-[11px] text-vgray-500">Step {step.n} of {totalSteps}</span>
      </div>

      <div className="mb-3">
        <h4 className="text-[14px] font-semibold leading-snug text-vgray-900">{label}</h4>
        <p className="mt-0.5 font-mono text-[12px] text-vgray-500">
          {step.amount != null && step.asset ? (
            <>Amount: <span className="font-bold text-vgray-800">{step.amount} {step.asset}</span></>
          ) : null}
          {projectedHf && (
            <span className={step.amount != null ? "ml-2.5 border-l border-vgray-200 pl-2.5" : ""}>
              Projected HF: <span className="font-bold text-violet-500">{projectedHf}</span>
            </span>
          )}
        </p>
      </div>

      <div className="mb-3.5 rounded-lg border border-vgray-100 bg-vgray-50 p-2.5 font-mono text-[11px] text-vgray-600">
        <div className="flex items-center justify-between">
          <span className="text-vgray-400">Simulation:</span>
          <span className="font-semibold text-vgray-700">{tx.simulation_success ? "passed" : "failed"}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-vgray-400">Blockhash:</span>
          <span className="text-vgray-700" title={tx.blockhash}>{short(tx.blockhash)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-vgray-400">Valid until block:</span>
          <span className="text-vgray-700">{tx.lastValidBlockHeight.toLocaleString("en-US")}</span>
        </div>
      </div>

      {rejected && !error && (
        <p role="status" className="mb-3 text-[12.5px] leading-5 text-vgray-600">
          You declined this in your wallet. Nothing was sent. Sign again when you are ready, or stop here.
        </p>
      )}
      {error && (
        <div role="alert" className="mb-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-[12px] text-red-700">
          <XCircle size={14} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        {onCancel ? (
          <button type="button" onClick={onCancel} disabled={signing}
            className="text-[12px] font-medium text-vgray-400 transition-colors hover:text-red-500 disabled:opacity-50">
            Stop here
          </button>
        ) : <div />}

        <button
          type="button"
          onClick={onSign}
          disabled={signing || !tx.simulation_success}
          className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12.5px] font-bold ${BTN_GRADIENT} disabled:opacity-60`}
        >
          {signing ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              <span>Waiting for your wallet…</span>
            </>
          ) : (
            <>
              <span>{rejected ? "Try signing again" : `Sign & execute step ${step.n}`}</span>
              <ChevronRight size={13} />
            </>
          )}
        </button>
      </div>
    </div>
  );
}
