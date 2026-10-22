/**
 * The reply once a plan has completed: what was done, step by step, and what the user asked to see.
 *
 * WHAT happened comes only from the plan record (its confirmed steps, their labels and the amounts they were built
 * with, and each report leg's answer). Gemini words it for the user; every figure it writes must appear in those facts
 * (`numbersGrounded`), and a reply that fails the checks, or no model at all, falls back to the step labels themselves.
 */
import { answerToText } from "../answer-schema";
import { doneClause } from "../client/completion";
import type { PlanCompletion } from "../types";
import { getLlm, llmConfigured, numbersGrounded } from "../vertex";
import type { StoredStep, WorkflowRecord } from "./types";

const DONE = new Set(["confirmed", "done"]);

const SYSTEM = `You are the Vanna Copilot (Vanna Finance on Solana). The user approved a plan and every step of it is now confirmed on chain. Write the reply they read, from FACTS only.
Rules:
- headline: one or two short, warm sentences: what was done overall and, if FACTS hold a report the user asked for, its answer (e.g. their health factor now). Plain words, no step numbers.
- steps: one entry per TRANSACTION step in FACTS (never for a report step), with its n and one short past-tense line saying what that transaction did, with its amounts and assets exactly as FACTS write them (e.g. "Deposited 2 SOL as margin collateral").
- Use no number that is not in FACTS. No addresses, signatures, links, code or markdown. No price predictions or advice.
- Never mention a step that is not in FACTS, and never say anything failed: every step in FACTS is confirmed.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING", description: "One or two short sentences: what was done, and the answer to any report the user asked for." },
    steps: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { n: { type: "INTEGER" }, text: { type: "STRING", description: "What this transaction did, past tense, one short line." } },
        required: ["n", "text"],
      },
    },
  },
  required: ["headline", "steps"],
} as const;

const writes = (rec: WorkflowRecord): StoredStep[] => rec.steps.filter((s) => s.kind !== "read" && DONE.has(s.status));

/** The plan's facts as the model reads them: no signatures or addresses, only what the user can see on the card. */
export function completionFacts(rec: WorkflowRecord): string {
  const lines = [`PLAN: ${rec.summary}`];
  for (const s of rec.steps) {
    if (s.kind === "read") {
      if (s.status === "done" && s.answer) lines.push(`Step ${s.n} (report the user asked to see): ${s.label}\n${answerToText(s.answer)}`);
      continue;
    }
    if (!DONE.has(s.status)) continue;
    const sent = s.resolved && s.resolved !== s.amount ? ` (amount sent: ${s.resolved} ${s.asset ?? ""})`.replace(/\s+\)/, ")") : "";
    lines.push(`Step ${s.n} (transaction, confirmed): ${s.label}${sent}`);
  }
  return lines.join("\n");
}

/** The reply when the model can't be used: each step's own label, in the past tense. */
export function fallbackCompletion(rec: WorkflowRecord): PlanCompletion {
  const done = writes(rec);
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const headline = done.length === 1
    ? `Done. ${cap(doneClause(done[0]!.label)).replace(/[.\s]+$/, "")}.`
    : `Done. All ${done.length} transactions are confirmed on chain.`;
  return { headline, steps: done.map((s) => ({ n: s.n, text: cap(doneClause(s.label)) })), worded: false };
}

const UNSAFE = /[`*#]|https?:\/\/|www\.|[1-9A-HJ-NP-Za-km-z]{32,}/;

function safe(text: string, facts: string, max: number): boolean {
  return text.length > 0 && text.length <= max && !UNSAFE.test(text) && numbersGrounded(text, [facts]);
}

/** Gemini's reply for a completed plan, checked against its facts; the fallback when it can't be used. */
export async function composeCompletion(rec: WorkflowRecord, signal?: AbortSignal): Promise<PlanCompletion> {
  const fallback = fallbackCompletion(rec);
  if (!llmConfigured() || !fallback.steps.length) return fallback;
  const facts = completionFacts(rec);
  try {
    const res = await getLlm().generate({
      system: SYSTEM,
      user: `FACTS (from the server, accurate):\n${facts}`,
      responseSchema: SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 600,
      thinkingLevel: "LOW",
      signal,
    });
    const parsed = res.text ? (JSON.parse(res.text) as { headline?: unknown; steps?: unknown }) : null;
    const headline = typeof parsed?.headline === "string" ? parsed.headline.trim() : "";
    if (!safe(headline, facts, 400)) return fallback;
    const given = new Map<number, string>();
    for (const item of Array.isArray(parsed?.steps) ? parsed.steps : []) {
      const r = item as { n?: unknown; text?: unknown };
      if (typeof r.n === "number" && typeof r.text === "string" && safe(r.text.trim(), facts, 200)) given.set(r.n, r.text.trim());
    }
    // A transaction the model left out, or wrote unsafely, keeps its own label: every confirmed step is listed.
    const steps = fallback.steps.map((s) => ({ n: s.n, text: given.get(s.n) ?? s.text }));
    return { headline, steps, worded: true };
  } catch {
    return fallback;
  }
}
