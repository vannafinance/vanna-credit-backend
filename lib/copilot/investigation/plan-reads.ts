/**
 * Read legs of a plan: what the user asked to SEE at a point of their plan ("deposit 100 USDC, then show my balance and
 * APY"; "show my health factor, borrow 50 USDC, then show it again").
 *
 * Gemini chose the leg's read tools when it proposed the plan (`decision.ts`); the leg runs when the plan reaches it,
 * after every transaction before it has confirmed, so it reads the account as it is then. The reads go through the same
 * catalogue as an investigation (`catalog.ts`), and Gemini writes the answer from their results alone, under the same
 * grounding check as any answer: a figure that is not in a result is refused. When the model is unavailable, or its
 * answer is refused twice, the leg shows the readers' own wording instead, so a plan never stalls on a read.
 */

import type { AnswerFact, StructuredAnswer } from "../answer-schema";
import { copilotConfig } from "../config";
import { DOMAIN_FIREWALL_SYSTEM } from "../domain-firewall";
import type { ReadLeg } from "../intent";
import type { ReadCtx, ReadOutcome } from "../mcp-facts";
import { debugMcp } from "../debug";
import { getLlm } from "../vertex";
import { calculate, CALCULATE_TOOL } from "./calculate";
import { executeRead, SLOW_READS, type ReadOutput } from "./catalog";
import { DECISION_TOOLS, parseDecision, predictListFilter } from "./decision";
import type { Observation, Rejection } from "./types";

const READ_TIMEOUT_MS = 15_000;
const MAX_OBSERVATION_CHARS = 6_000;
const MAX_ATTEMPTS = 2;
/** Model calls per leg: calculations, then the answer (with one retry). */
const MAX_CALLS = 5;

/** Test seam. */
export const planReadDeps = { executeRead, now: () => Date.now() };

function compact(value: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error("read timed out")), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const ANSWER_TOOLS = [...DECISION_TOOLS.filter((t) => t.name === "answer"), CALCULATE_TOOL];

function system(): string {
  return `You are the Vanna Finance Copilot on Solana. The user approved a plan; it has reached a step where they asked to see something. The tools below were just read, live, after every earlier step of the plan confirmed. Answer what they asked with the answer tool.

${DOMAIN_FIREWALL_SYSTEM}

RULES
- Answer exactly what the user asked to see, using only the tool results below. Lead with the figure they asked for.
- Every figure you state must appear in a tool result, written as it appears there. Never compute in your head: for a total, a difference, a USD value (amount x price) or a percentage no result states, call calculate with the figures copied from the results, then quote its result.
- If a result is missing or failed, say plainly what could not be read; never fill it in.
- Plain language, no internal names (tools, functions, the model). No price predictions and no advice beyond the figures.`;
}

function prompt(leg: ReadLeg, evidence: Observation[], rejections: Rejection[]): string {
  return [
    `WHAT THE USER ASKED TO SEE: ${leg.question || leg.label}`,
    `TOOL RESULTS:\n${evidence.map((o, i) => `[${i + 1}] ${o.tool}(${JSON.stringify(o.args)}) ${o.ok ? "->" : "FAILED ->"} ${o.result}`).join("\n")}`,
    rejections.length ? `REJECTED (fix this):\n${rejections.map((r) => `- ${r.reason}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The readers' own wording, used when the model can't write the answer. Nothing is computed. */
function fallbackAnswer(leg: ReadLeg, outputs: Array<{ tool: string; args: Record<string, unknown>; out: ReadOutput | null }>): StructuredAnswer {
  const headlines: string[] = [];
  const facts: AnswerFact[] = [];
  const notes: string[] = [];
  for (const { out } of outputs) {
    if (!out) continue;
    const r = (out.result ?? {}) as Record<string, unknown>;
    if (typeof r.summary === "string" && r.summary) headlines.push(r.summary);
    if (Array.isArray(r.facts)) for (const f of r.facts as AnswerFact[]) if (f && typeof f.label === "string" && typeof f.value === "string") facts.push({ label: f.label, value: f.value });
    if (typeof r.note === "string" && r.note) notes.push(r.note);
    if (typeof r.summary !== "string") {
      // A computed read (Earn balances, leverage capacity): its plain values, as returned.
      const walk = (v: unknown, path: string[]) => {
        if (facts.length >= 12) return;
        if (v === null || v === undefined) return;
        if (typeof v === "object") {
          for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, [...path, k]);
          return;
        }
        if (path.length) facts.push({ label: path.join(" ").replace(/_/g, " "), value: String(v) });
      };
      walk(r, []);
    }
  }
  const failed = outputs.filter((o) => !o.out || !o.out.ok).length;
  // A Predict market list is shown whole, from the website's own list (answer-schema `list`), never as picked rows.
  const markets = outputs.find((o) => o.tool === "get_predict_markets" && o.out?.ok);
  return {
    ...(markets ? { list: { kind: "predict_markets" as const, ...predictListFilter(markets.args) } } : {}),
    headline: headlines.join(" ") || (failed === outputs.length ? `I couldn't read this right now: ${leg.label || leg.question}.` : leg.label || "Here is what I read."),
    facts: facts.slice(0, 12),
    ...(notes.length ? { note: notes.join(" ").slice(0, 400) } : failed && failed < outputs.length ? { note: "Part of this couldn't be read right now." } : {}),
    venue: "none",
  };
}

/** Run one read leg: its reads now, then Gemini's grounded answer (or the readers' wording). */
export async function answerReadLeg(leg: ReadLeg, ctx: ReadCtx): Promise<ReadOutcome> {
  const outputs = await Promise.all(
    leg.reads.map(async (r) => {
      try {
        return { tool: r.tool, args: r.args, out: await withTimeout(planReadDeps.executeRead(r.tool, r.args, ctx), SLOW_READS[r.tool] ?? READ_TIMEOUT_MS) };
      } catch (err) {
        return { tool: r.tool, args: r.args, out: null as ReadOutput | null, error: err instanceof Error ? err.message : "read failed" };
      }
    }),
  );
  const evidence: Observation[] = outputs.map((o) => ({
    tool: o.tool,
    args: o.args,
    ok: !!o.out?.ok,
    result: compact(o.out ? o.out.result : { error: "error" in o ? o.error : "read failed" }, MAX_OBSERVATION_CHARS),
    ms: 0,
  }));
  const anyOk = evidence.some((o) => o.ok);
  const data = Object.fromEntries(outputs.map((o, i) => [`${i + 1}:${o.tool}`, o.out?.result ?? null]));
  if (!anyOk) return { ok: false, answer: fallbackAnswer(leg, outputs), data };

  const rejections: Rejection[] = [];
  let failedAnswers = 0;
  for (let n = 0; n < MAX_CALLS && failedAnswers < MAX_ATTEMPTS; n++) {
    let res;
    try {
      res = await getLlm().generate({
        system: system(),
        user: prompt(leg, evidence, rejections),
        tools: ANSWER_TOOLS,
        forceTool: true,
        thinkingLevel: copilotConfig.followupThinking,
        maxOutputTokens: 2048,
      });
    } catch {
      break;
    }
    const calls = res.calls ?? [];
    const call = calls.find((c) => c.name === "answer");
    if (!call) {
      const calcs = calls.filter((c) => c.name === CALCULATE_TOOL.name);
      if (!calcs.length) {
        failedAnswers++;
        rejections.push({ tool: "(none)", reason: "call the answer tool" });
        continue;
      }
      for (const c of calcs) {
        const a = (c.args ?? {}) as Record<string, unknown>;
        const out = calculate(a, [leg.question, ...evidence.filter((o) => o.ok).map((o) => o.result)]);
        debugMcp("plan-read:calculate", a, out.ok, out.result);
        evidence.push({ tool: CALCULATE_TOOL.name, args: a, ok: out.ok, result: compact(out.result, 1_000), ms: 0 });
      }
      continue;
    }
    const parsed = parseDecision("answer", call.args ?? {}, { message: leg.question, history: [], evidence });
    if (parsed.ok && parsed.outcome.kind === "answer") return { ok: true, answer: parsed.outcome.answer, data };
    failedAnswers++;
    rejections.push({ tool: "answer", reason: parsed.ok ? "answer the question" : parsed.reason });
  }
  return { ok: true, answer: fallbackAnswer(leg, outputs), data };
}
