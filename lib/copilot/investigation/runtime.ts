/**
 * Stage 2: the investigation loop.
 *
 * Each turn is one Gemini call (stateless: the conversation, the evidence gathered so far and any rejected decision
 * are restated in the prompt). Gemini must call tools: read tools to gather facts (several at once when they are
 * independent) or one decision tool to finish. Reads run against the MCP with a time limit each; a decision goes
 * through `parseDecision`, and a rejected one is fed back so the next turn can correct it. Budgets on turns, reads,
 * observation size and wall time keep a turn bounded; when they run out the last turn may only decide.
 */

import { copilotConfig } from "../config";
import { debugMcp } from "../debug";
import { getLlm, LlmUnavailable } from "../vertex";
import type { ReadCtx } from "../mcp-facts";
import { calculate, CALCULATE_TOOL } from "./calculate";
import { executeRead, READ_TOOL_NAMES, READ_TOOLS, SLOW_READS, type ReadOutput } from "./catalog";
import { DECISION_NAMES, DECISION_TOOLS, parseDecision } from "./decision";
import { systemPrompt, turnPrompt } from "./prompt";
import type { InvestigationLimits, InvestigationResult, InvestigationTrace, Observation, Rejection } from "./types";

export function investigationLimits(): InvestigationLimits {
  return {
    maxTurns: copilotConfig.investigationMaxTurns,
    maxReads: 16,
    maxDurationMs: copilotConfig.investigationTimeoutMs,
    maxReadDurationMs: 15_000,
    maxObservationChars: 6_000,
  };
}

/** Test seam. */
/**
 * `prefetchWaitMs`: how long the first model call waits for the prefetched account health. When it is back by then it
 * goes into the first turn's evidence, so a question about the account is answered in one model turn instead of two;
 * when it isn't, the first turn starts without it, as before.
 */
export const investigationDeps = { now: () => Date.now(), executeRead, prefetch: true, prefetchWaitMs: 1_500 };
/** A read that failed is asked for at most this many times in one investigation (a timeout tends to repeat). */
const MAX_READ_ATTEMPTS = 2;

const verbose = () => !copilotConfig.isProduction;

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

export async function investigate(args: {
  message: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  ctx: ReadCtx;
  signal?: AbortSignal;
  limits?: Partial<InvestigationLimits>;
}): Promise<InvestigationResult> {
  const limits = { ...investigationLimits(), ...(args.limits ?? {}) };
  const started = investigationDeps.now();
  const evidence: Observation[] = [];
  const rejections: Rejection[] = [];
  const trace: InvestigationTrace = { turns: 0, reads: [], rejections, decision: null, tokens: 0, ms: 0 };
  const system = systemPrompt();
  // Reads already started this turn, by tool + arguments. The account health read is started right away, in parallel
  // with the first model call: it is the most requested fact, and it is ready by the time the model asks for it.
  const inflight = new Map<string, Promise<ReadOutput>>();
  const startRead = (tool: string, a: Record<string, unknown>): Promise<ReadOutput> => {
    const key = `${tool}:${JSON.stringify(a)}`;
    let p = inflight.get(key);
    if (!p) {
      p = withTimeout(investigationDeps.executeRead(tool, a, args.ctx), SLOW_READS[tool] ?? limits.maxReadDurationMs);
      inflight.set(key, p);
      // A failed read is forgotten, so asking again really reads again (instead of returning the same failure). The
      // handler also keeps a prefetch nobody asks for from surfacing as an unhandled rejection.
      p.then((o) => { if (!o.ok) inflight.delete(key); }, () => inflight.delete(key));
    }
    return p;
  };
  if (investigationDeps.prefetch) {
    const t0 = investigationDeps.now();
    const health = startRead("get_account_health", {});
    const early = await Promise.race([
      health.then((o) => o, () => null),
      new Promise<null>((r) => setTimeout(() => r(null), investigationDeps.prefetchWaitMs)),
    ]);
    if (early?.ok) {
      const ms = investigationDeps.now() - t0;
      evidence.push({ tool: "get_account_health", args: {}, ok: true, result: compact(early.result, limits.maxObservationChars), ms });
      trace.reads.push({ tool: "get_account_health", args: {}, ok: true, ms });
    }
  }
  let rejectedLastTurn = false;
  const done = (outcome: InvestigationResult["outcome"]): InvestigationResult => {
    trace.ms = investigationDeps.now() - started;
    if (verbose()) console.info(`[copilot:investigate] ${outcome.kind}${trace.decision ? ` via ${trace.decision}` : ""} after ${trace.turns} turn(s), ${trace.reads.length} read(s), ${trace.tokens} tokens, ${trace.ms}ms`);
    return { outcome, trace };
  };

  for (let turn = 1; turn <= limits.maxTurns; turn++) {
    const elapsed = investigationDeps.now() - started;
    if (elapsed > limits.maxDurationMs) return done({ kind: "none", reason: "time budget spent" });
    const readsLeft = limits.maxReads - evidence.length;
    const mustDecide = turn === limits.maxTurns || readsLeft <= 0 || elapsed > limits.maxDurationMs * 0.75;
    trace.turns = turn;

    let res;
    try {
      res = await getLlm().generate({
        system,
        user: turnPrompt({ message: args.message, history: args.history, evidence, rejections, turn, maxTurns: limits.maxTurns, readsLeft, mustDecide }),
        tools: mustDecide ? DECISION_TOOLS : [...READ_TOOLS, CALCULATE_TOOL, ...DECISION_TOOLS],
        forceTool: true,
        // Full reasoning to understand the request and to correct a rejected decision; a turn that only turns gathered
        // evidence into a decision needs less, and answers faster.
        thinkingLevel: turn === 1 || rejectedLastTurn ? copilotConfig.investigationThinking : copilotConfig.followupThinking,
        maxOutputTokens: 4096,
        signal: args.signal,
      });
    } catch (err) {
      if (verbose()) console.warn("[copilot:investigate] model call failed:", err instanceof Error ? err.message : err);
      return done({ kind: "none", reason: err instanceof LlmUnavailable ? "model unavailable" : "model call failed" });
    }
    trace.tokens += res.tokens;
    rejectedLastTurn = false;

    const calls = res.calls ?? [];
    if (verbose()) console.info(`[copilot:investigate] turn ${turn}: ${calls.map((c) => `${c.name}(${compact(c.args, 160)})`).join(", ") || "(no tool call)"}`);
    if (!calls.length) {
      rejections.push({ tool: "(none)", reason: "you must call a tool: a read tool or one decision tool" });
      rejectedLastTurn = true;
      continue;
    }

    const decision = calls.find((c) => DECISION_NAMES.has(c.name));
    if (decision) {
      const parsed = parseDecision(decision.name, decision.args ?? {}, { message: args.message, history: args.history, evidence });
      if (parsed.ok) {
        trace.decision = decision.name;
        return done(parsed.outcome);
      }
      rejections.push({ tool: decision.name, reason: parsed.reason });
      rejectedLastTurn = true;
      if (verbose()) console.info(`[copilot:investigate] rejected ${decision.name}: ${parsed.reason}`);
      continue;
    }

    // Arithmetic on figures already gathered: exact, done here, and added to the evidence like a read.
    const calcs = calls.filter((c) => c.name === CALCULATE_TOOL.name).slice(0, 6);
    for (const c of calcs) {
      const a = (c.args ?? {}) as Record<string, unknown>;
      const sources = [args.message, ...args.history.filter((h) => h.role === "user").map((h) => h.text), ...evidence.filter((o) => o.ok).map((o) => o.result)];
      const out = calculate(a, sources);
      debugMcp("investigate:calculate", a, out.ok, out.result);
      evidence.push({ tool: CALCULATE_TOOL.name, args: a, ok: out.ok, result: compact(out.result, 1_000), ms: 0 });
      trace.reads.push({ tool: CALCULATE_TOOL.name, args: a, ok: out.ok, ms: 0 });
    }

    // A read that failed (timed out, MCP hiccup) may be asked for again, once; one that succeeded may not.
    const keyOf = (o: { tool: string; args: unknown }) => `${o.tool}:${JSON.stringify(o.args)}`;
    const failures = new Map<string, number>();
    for (const o of evidence) if (!o.ok) failures.set(keyOf(o), (failures.get(keyOf(o)) ?? 0) + 1);
    const seen = new Set(evidence.filter((o) => o.ok).map(keyOf));
    for (const [k, n] of failures) if (n >= MAX_READ_ATTEMPTS) seen.add(k);
    const reads = calls
      .filter((c) => READ_TOOL_NAMES.has(c.name))
      .filter((c) => {
        const key = `${c.name}:${JSON.stringify(c.args ?? {})}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, Math.max(0, readsLeft));
    if (!reads.length) {
      if (!calcs.length) rejections.push({ tool: calls[0].name, reason: "that read is already in the evidence, has already failed twice, or is not a known tool; decide with what you have (say what couldn't be read), or read something new" });
      continue;
    }
    const observed = await Promise.all(
      reads.map(async (c): Promise<Observation> => {
        const t0 = investigationDeps.now();
        const a = (c.args ?? {}) as Record<string, unknown>;
        try {
          const out = await startRead(c.name, a);
          // Dev-only trace (no-op otherwise): the figures the model saw, including those computed by code.
          debugMcp(`investigate:${c.name}`, a, out.ok, out.result);
          return { tool: c.name, args: a, ok: out.ok, result: compact(out.result, limits.maxObservationChars), ms: investigationDeps.now() - t0 };
        } catch (err) {
          return { tool: c.name, args: a, ok: false, result: compact({ error: err instanceof Error ? err.message : "read failed" }, 300), ms: investigationDeps.now() - t0 };
        }
      }),
    );
    for (const o of observed) {
      evidence.push(o);
      trace.reads.push({ tool: o.tool, args: o.args, ok: o.ok, ms: o.ms });
    }
  }
  return done({ kind: "none", reason: rejections.length ? `no valid decision (${rejections.at(-1)?.reason})` : "turn budget spent" });
}
