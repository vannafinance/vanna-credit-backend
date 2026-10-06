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
import { getLlm, LlmUnavailable } from "../vertex";
import type { ReadCtx } from "../mcp-facts";
import { executeRead, READ_TOOL_NAMES, READ_TOOLS } from "./catalog";
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
export const investigationDeps = { now: () => Date.now(), executeRead };

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
        tools: mustDecide ? DECISION_TOOLS : [...READ_TOOLS, ...DECISION_TOOLS],
        forceTool: true,
        thinkingLevel: copilotConfig.investigationThinking,
        maxOutputTokens: 4096,
        signal: args.signal,
      });
    } catch (err) {
      if (verbose()) console.warn("[copilot:investigate] model call failed:", err instanceof Error ? err.message : err);
      return done({ kind: "none", reason: err instanceof LlmUnavailable ? "model unavailable" : "model call failed" });
    }
    trace.tokens += res.tokens;

    const calls = res.calls ?? [];
    if (verbose()) console.info(`[copilot:investigate] turn ${turn}: ${calls.map((c) => `${c.name}(${compact(c.args, 160)})`).join(", ") || "(no tool call)"}`);
    if (!calls.length) {
      rejections.push({ tool: "(none)", reason: "you must call a tool: a read tool or one decision tool" });
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
      if (verbose()) console.info(`[copilot:investigate] rejected ${decision.name}: ${parsed.reason}`);
      continue;
    }

    const seen = new Set(evidence.map((o) => `${o.tool}:${JSON.stringify(o.args)}`));
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
      rejections.push({ tool: calls[0].name, reason: "that read is already in the evidence or is not a known tool; decide, or read something new" });
      continue;
    }
    const observed = await Promise.all(
      reads.map(async (c): Promise<Observation> => {
        const t0 = investigationDeps.now();
        const a = (c.args ?? {}) as Record<string, unknown>;
        try {
          const out = await withTimeout(investigationDeps.executeRead(c.name, a, args.ctx), limits.maxReadDurationMs);
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
