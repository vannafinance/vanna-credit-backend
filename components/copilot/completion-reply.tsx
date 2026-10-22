"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { PlanCompletion, StructuredAnswer } from "@/lib/copilot/types";
import type { RunState } from "@/lib/copilot/client/run";
import { getPlanSummary } from "@/lib/copilot/client/api";
import { completionSummary, doneClause } from "@/lib/copilot/client/completion";
import { explorerUrl } from "@/lib/solana/config";
import { AnswerView } from "./answer-view";

/**
 * A finished plan's reply, in place of its approval and run cards: Gemini's sentence about what was done, then one row
 * per transaction (what it did, and its link), then what the user asked to see along the way, inline.
 *
 * The words come from the server (`/workflow/[id]/summary`, composed once from the plan's own facts and kept on it).
 * If that can't be had, the rows are the step labels themselves and the reports keep their own headlines.
 */

/** Replies already fetched, so a turn that re-mounts (scroll, a new message) does not ask again. */
const fetched = new Map<string, PlanCompletion>();

function fallback(run: RunState): PlanCompletion {
  const steps = run.plan.steps
    .filter((s) => s.kind === "write" && (s.status === "confirmed" || s.status === "done"))
    .map((s) => {
      const text = doneClause(s.label);
      return { n: s.n, text: text.charAt(0).toUpperCase() + text.slice(1) };
    });
  return { headline: completionSummary(run.plan) ?? "Done.", steps, worded: false };
}

/** Whether an answer has anything to show beyond its headline. */
function hasFigures(a: StructuredAnswer): boolean {
  return (a.facts?.length ?? 0) > 0 || (a.sections?.length ?? 0) > 0 || (a.tables?.some((t) => t.rows.length > 0) ?? false) || (a.table?.rows.length ?? 0) > 0 || !!a.list;
}

function shortSig(sig: string): string {
  return sig.length > 12 ? `${sig.slice(0, 6)}…${sig.slice(-4)}` : sig;
}

export function CompletionReply({ run }: { run: RunState }) {
  const id = run.workflowId;
  // What the server answered for this plan: its reply, or "failed" (the step labels are shown instead).
  const [got, setGot] = useState<{ id: string; reply: PlanCompletion | "failed" } | null>(null);
  const answered = fetched.get(id) ?? (got?.id === id ? got.reply : null);
  const reply = answered === "failed" ? fallback(run) : answered;

  useEffect(() => {
    if (fetched.has(id)) return;
    const controller = new AbortController();
    void (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const completion = await getPlanSummary(id, controller.signal);
          if (completion.worded) fetched.set(id, completion);
          setGot({ id, reply: completion });
          return;
        } catch {
          if (controller.signal.aborted) return;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
      if (!controller.signal.aborted) setGot({ id, reply: "failed" });
    })();
    return () => controller.abort();
  }, [id]);

  if (!reply) {
    return (
      <p role="status" className="flex items-center gap-2 text-[13px] leading-[20px] text-violet-500">
        <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden />
        <span>Summing up what was done…</span>
      </p>
    );
  }

  const byN = new Map(run.plan.steps.map((s) => [s.n, s]));
  const stepAnswers = run.plan.steps.flatMap((s) => (s.kind === "read" && s.status === "done" && s.answer ? [{ key: String(s.n), answer: s.answer }] : []));
  const answers = stepAnswers.length ? stepAnswers : run.answer ? [{ key: "report", answer: run.answer }] : [];
  // With Gemini's sentence above, a report that is only a sentence is already said there.
  const reports = reply.worded ? answers.filter((r) => hasFigures(r.answer)) : answers;

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[16px] leading-[26px] text-vgray-800" style={{ textWrap: "pretty" }}>
        {reply.headline}
      </p>

      {reply.steps.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {reply.steps.map((row) => {
            const sig = byN.get(row.n)?.signature ?? null;
            return (
              <li key={row.n} className="flex items-start gap-2.5 text-[14px] leading-[21px] text-vgray-700">
                <span
                  aria-hidden
                  className="mt-[3px] flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full"
                  style={{ background: "var(--cp-ok-bg)", color: "var(--cp-ok-fg)" }}
                >
                  <Check size={10} strokeWidth={3} />
                </span>
                <span className="min-w-0 flex-1" style={{ textWrap: "pretty" }}>{row.text}</span>
                {sig && (
                  <a
                    href={explorerUrl("tx", sig)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`View transaction ${sig} on the explorer`}
                    className="shrink-0 whitespace-nowrap font-mono text-[12px] leading-[21px] text-violet-500 hover:text-violet-600"
                  >
                    {shortSig(sig)} ↗
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* What the user asked to see along the way. Gemini's sentence already gives its answer, so only the figures
          below it stay; without that sentence each keeps its own headline. */}
      {reports.map((r) => (
        <div key={r.key} className="border-t border-vgray-100 pt-3">
          <AnswerView answer={r.answer} hideHeadline={reply.worded} />
        </div>
      ))}
    </div>
  );
}
