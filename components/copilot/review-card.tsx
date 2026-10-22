"use client";

import type { PlanStepView, Preview, RiskResult } from "@/lib/copilot/types";
import { ImpactPanel } from "./impact-panel";

/**
 * Review cards for a single action the server has built and simulated.
 *
 * `ActionReviewCard` covers earn / margin / farm writes; `SwapReviewCard` is the same idea drawn as
 * "you spend / you receive" when the slots carry a swap's two sides. Both only display what the
 * server sent. A slot that is absent is not shown, and nothing here computes an amount, a quote or
 * a health factor.
 */

const RISK_TONE = {
  allow: { label: "risk gate · allow", ink: "var(--cp-ok-fg)", tint: "var(--cp-ok-bg)" },
  needs_confirmation: { label: "risk gate · confirm", ink: "var(--cp-warn-fg)", tint: "var(--cp-warn-bg)" },
  block: { label: "risk gate · blocked", ink: "var(--cp-danger-fg)", tint: "var(--cp-danger-bg)" },
} as const;

export function RiskChip({ decision }: { decision: RiskResult["decision"] }) {
  const tone = RISK_TONE[decision];
  return (
    <span
      className="flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em]"
      style={{ color: tone.ink, background: tone.tint }}
    >
      <span className="h-[5px] w-[5px] rounded-full" style={{ background: tone.ink }} />
      {tone.label}
    </span>
  );
}

const label = (key: string) => key.replace(/_/g, " ");

function pick(slots: Preview["slots"], keys: string[]): string | null {
  for (const key of keys) {
    const v = slots[key];
    if (v !== null && v !== undefined && v !== "") return String(v);
  }
  return null;
}

function swapSides(slots: Preview["slots"]) {
  const amountIn = pick(slots, ["amount_in", "amountIn", "amount"]);
  const tokenIn = pick(slots, ["token_in", "asset_in", "from_asset", "from", "asset"]);
  const amountOut = pick(slots, ["expected_out", "amount_out", "out_amount", "min_out"]);
  const tokenOut = pick(slots, ["token_out", "asset_out", "to_asset", "to"]);
  return amountIn && tokenIn && tokenOut ? { amountIn, tokenIn, amountOut, tokenOut } : null;
}

export function isSwapPreview(preview: Preview): boolean {
  return /swap/i.test(preview.template_id) && swapSides(preview.slots) !== null;
}

function Tile({ caption, value }: { caption: string; value: string }) {
  return (
    <div className="rounded-xl border border-vgray-100 bg-vgray-50 p-3.5">
      <dt className="text-[12px] text-vgray-500">{caption}</dt>
      <dd className="mt-1 text-[20px] font-semibold tabular-nums text-vgray-900">{value}</dd>
    </div>
  );
}

export interface ReviewCardProps {
  preview: Preview;
  /** Wallet-signing state for the one step behind this review, rendered by the caller below the card. */
  footer?: React.ReactNode;
  hfFloor?: number;
}

export function ActionReviewCard({ preview, footer, hfFloor }: ReviewCardProps) {
  const swap = isSwapPreview(preview) ? swapSides(preview.slots) : null;
  // `op` is the internal step name ("predict_trade"); the summary above already says what the action does.
  const shown = Object.entries(preview.slots).filter(([k, v]) => k !== "op" && v !== null && v !== "");
  const projected = preview.risk.projected_health_factor;

  return (
    <section aria-label={swap ? "Swap review" : "Action review"} className="rounded-xl border border-violet-100 bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-wide text-violet-500">{swap ? "Review swap" : "Review action"}</p>
          <p className="mt-0.5 text-[13px] text-vgray-500">
            Simulated by the Vanna MCP · {preview.requires_signature ? "needs your wallet signature" : "no signature needed"}
          </p>
        </div>
        <RiskChip decision={preview.risk.decision} />
      </div>

      <p className="mt-3 text-[15px] leading-6 text-vgray-900">{preview.human_summary}</p>

      {swap ? (
        <dl className="mt-4 grid gap-2 sm:grid-cols-2">
          <Tile caption="You spend" value={`${swap.amountIn} ${swap.tokenIn}`} />
          <Tile caption="You receive · estimate" value={swap.amountOut ? `${swap.amountOut} ${swap.tokenOut}` : swap.tokenOut} />
        </dl>
      ) : shown.length > 0 ? (
        <dl className="mt-4 grid gap-2 sm:grid-cols-2">
          {shown.map(([key, value]) => (
            <Tile key={key} caption={label(key)} value={String(value)} />
          ))}
        </dl>
      ) : null}

      {preview.simulation && <ImpactPanel sim={preview.simulation} floor={hfFloor} />}

      {((preview.notes?.length ?? 0) > 0 || preview.risk.reasons.length > 0) && (
        <ul className="mt-3 space-y-1 text-[12.5px] leading-5 text-vgray-600">
          {[...(preview.notes ?? []), ...preview.risk.reasons].map((reason) => (
            <li key={reason} className="flex gap-2">
              <span aria-hidden="true" className="text-vgray-300">•</span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}
      {projected != null && !preview.simulation && (
        <p className="mt-3 text-[12.5px] text-vgray-600">Projected health factor {projected.toFixed(2)}.</p>
      )}

      {footer && <div className="mt-4">{footer}</div>}
    </section>
  );
}

/** Kept as its own export so a swap step inside a plan can reuse the same two-tile layout. */
export function SwapReviewCard({ step }: { step: PlanStepView }) {
  const slots = step.slots ?? {};
  const sides = swapSides(slots);
  if (!sides) return null;
  return (
    <dl className="mt-2 grid gap-2 sm:grid-cols-2">
      <Tile caption="You spend" value={`${sides.amountIn} ${sides.tokenIn}`} />
      <Tile caption="You receive · estimate" value={sides.amountOut ? `${sides.amountOut} ${sides.tokenOut}` : sides.tokenOut} />
    </dl>
  );
}
