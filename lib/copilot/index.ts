/**
 * Copilot brain: one chat turn.
 *
 * Stages (each can end the turn, and none can be skipped):
 *   1 firewall    session -> rate limit -> hard refusals (domain-firewall.ts)
 *   2 investigate Gemini reads the account with tools and decides (investigation/); the keyword router
 *                 (router.ts) is only the fallback when the model is off or unreachable
 *   3 size        sizing words become exact amounts from live data and the protocol maths (handleWrite,
 *                 workflow/strategy.ts, workflow/unwind.ts, workflow/leverage-borrow.ts, risk.ts)
 *   4 review      the plan is frozen, fingerprinted and shown for approval (workflow.ts)
 *   5 execute     /api/copilot/workflow/[id]/* builds each step fresh, the wallet signs, the app relays
 *   6 complete    confirmation per step and the plan's final state
 *
 * Order inside a turn:
 *   session -> rate limit -> firewall -> (clarify pick | investigate | route) -> lane
 *     read  : MCP facts -> structured answer (Gemini may re-word it, never change a figure)
 *     write : one-step workflow. Fresh checks + limits + MCP build/simulate -> `preview`
 *     plan  : frozen, digest-bound workflow -> `plan_preview`
 * Nothing is signed or sent here; the wallet signs, /api/copilot/workflow/* sends and confirms.
 */

import { answerToText } from "./answer-schema";
import { copilotConfig } from "./config";
import { debugNote } from "./debug";
import { CAPABILITY_LINE, evaluateFirewall, historyIsOnDomain } from "./domain-firewall";
import { fmtAmount } from "./explain";
import type { AmountSpec, Asset, Intent, WriteIntent } from "./intent";
import { checkAndConsume, LimitContentionError, recordTokens } from "./limits";
import { loadHealth, runRead, sizeSafeBorrow, type ReadCtx } from "./mcp-facts";
import { MAX_PLAN_STEPS, OUT_PREFIX, labelFor, planWarnings, stepFromWrite, reportStep, MARGIN_OPS, type StepSpec } from "./plan";
import { routeMessage } from "./router";
import { investigate } from "./investigation";
import { llmConfigured } from "./vertex";
import type { ChatRequest, ChatResponse, Preview, PlanView } from "./types";
import { wordAnswer } from "./vertex";
import { createWorkflow, toPlanView, WorkflowError } from "./workflow";
import { isConversationId, savePending, takePending } from "./workflow/pending";
import { planLever, type PlannedWorkflow } from "./workflow/strategy";
import { planUnwind } from "./workflow/unwind";
import { checkFunding } from "./workflow/funding";
import { sizeLevBorrow } from "./workflow/leverage-borrow";
import { buildStepTx, preflightStep, resolvePercent, walletSpendable } from "./workflow/steps";
import { randomUUID } from "node:crypto";
import type { CopilotUser } from "./types";

export { WorkflowError };

const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARS = 1000;
/** The whole turn's model budget: the investigation plus the answer wording. */
const LLM_TIMEOUT_MS = 75_000;

function cleanHistory(h: ChatRequest["history"]): Array<{ role: "user" | "assistant"; text: string }> {
  if (!Array.isArray(h)) return [];
  return h
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({ role: t.role, text: t.text.trim().slice(0, MAX_HISTORY_CHARS) }));
}

export interface ChatInput {
  req: ChatRequest;
  user: CopilotUser | null;
  requestId?: string;
}

export async function handleChat(input: ChatInput): Promise<ChatResponse> {
  const requestId = input.requestId ?? randomUUID();
  const { user } = input;
  const conversationId = isConversationId(input.req?.conversation_id) ? (input.req.conversation_id as string) : randomUUID();
  const base = { request_id: requestId, conversation_id: conversationId };

  if (!user) {
    return { kind: "needs_login", message: "Sign in with your Solana wallet to use the Copilot. It only ever asks your wallet to sign, never for a key.", ...base };
  }

  const rate = await checkAndConsume(user, "chat");
  if (!rate.ok) return { kind: "error", message: rate.message, limit: { kind: rate.kind, retry_after_s: rate.retry_after_s, message: rate.message }, ...base };

  const history = cleanHistory(input.req.history);
  const surface = input.req.surface === "assistant" ? "assistant" : "copilot";
  const ctx: ReadCtx = { user, requestId };
  const signal = AbortSignal.timeout(LLM_TIMEOUT_MS);
  let tokens = 0;

  try {
    let intent: Intent;
    let source: "keyword" | "model" | "unavailable" | "clarify" = "keyword";
    const message = typeof input.req.message === "string" ? input.req.message.trim() : "";

    if (input.req.clarify) {
      const picked = await takePending(conversationId, user, String(input.req.clarify.pending_id ?? ""), String(input.req.clarify.option_id ?? ""));
      if (!picked) return { kind: "error", message: "That choice has expired or was already used. Tell me again what you'd like to do.", ...base };
      intent = picked;
      source = "clarify";
    } else {
      const modelDecides = copilotConfig.investigationEnabled && llmConfigured();
      const fw = evaluateFirewall(message, { hasDomainHistory: historyIsOnDomain(history), modelDecides });
      if (!fw.allow) return { kind: fw.kind === "empty" ? "clarification" : "blocked", message: fw.message, ...base };
      let decided: Intent | null = null;
      if (modelDecides) {
        // Stage 2: Gemini investigates with read tools and decides. Its decision is already guarded (decision.ts).
        const inv = await investigate({ message, history, ctx, signal });
        tokens += inv.trace.tokens;
        debugNote("investigation", inv.trace);
        if (inv.outcome.kind === "answer") {
          return { kind: "answer", message: answerToText(inv.outcome.answer), answer: inv.outcome.answer, ...base };
        }
        if (inv.outcome.kind === "intent") {
          decided = inv.outcome.intent;
          source = "model";
        }
      }
      if (decided) {
        intent = decided;
      } else {
        // The model is off, unreachable, or ran out of budget: the deterministic router answers instead.
        const routed = await routeMessage(message, history, signal);
        intent = routed.intent;
        source = routed.source;
        tokens += routed.tokens;
      }
      debugNote("route", { source, lane: intent.lane, intent });
    }

    const res = await dispatch(intent, { ctx, user, message, history, surface, conversationId, source, signal, base });
    if ("tokens" in res) {
      tokens += res.tokens;
      return res.response;
    }
    return res;
  } catch (err) {
    if (err instanceof WorkflowError) return { kind: "error", message: err.message, ...base };
    if (err instanceof LimitContentionError) {
      const message = `The service is busy. Try again in ${err.retry_after_s}s.`;
      return { kind: "error", message, limit: { kind: "rate", retry_after_s: err.retry_after_s, message }, ...base };
    }
    console.error("[copilot] turn failed", { requestId, error: err instanceof Error ? err.message : String(err) });
    return { kind: "error", message: "Something went wrong on my side. Nothing was built or sent. Try again in a moment.", ...base };
  } finally {
    debugNote("tokens", tokens);
    if (tokens > 0) await recordTokens(user, tokens).catch(() => undefined);
  }
}

interface Turn {
  ctx: ReadCtx;
  user: CopilotUser;
  message: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  surface: "assistant" | "copilot";
  conversationId: string;
  source: "keyword" | "model" | "unavailable" | "clarify";
  signal: AbortSignal;
  base: { request_id: string; conversation_id: string };
}

type Reply = ChatResponse | { response: ChatResponse; tokens: number };

async function dispatch(intent: Intent, t: Turn): Promise<Reply> {
  const { base } = t;
  switch (intent.lane) {
    case "refuse":
      return { kind: "blocked", message: intent.message, ...base };
    case "unknown":
      return t.source === "unavailable"
        ? { kind: "unavailable", message: `I couldn't work out what you meant, and the language model that handles free-form requests is not reachable right now. ${CAPABILITY_LINE}`, ...base }
        : { kind: "clarification", message: `I'm not sure what you'd like to do. ${CAPABILITY_LINE}`, ...base };
    case "ask": {
      if (intent.options?.length) {
        const saved = await savePending(t.conversationId, t.user, intent.options);
        return { kind: "clarification", message: intent.question, clarify_options: saved.clarify_options, pending_id: saved.pending_id, ...base };
      }
      return { kind: "clarification", message: intent.question, ...base };
    }
    case "read": {
      const out = await runRead(intent.read, t.ctx);
      let answer = out.answer;
      let tokens = 0;
      if (!out.fixedWording && out.ok) {
        const worded = await wordAnswer({ question: t.message || "", answer, data: out.data, signal: t.signal });
        answer = worded.answer;
        tokens = worded.tokens;
        debugNote("worded", { used: worded.used, tokens: worded.tokens });
      }
      return { response: { kind: out.ok ? "answer" : "unavailable", message: answerToText(answer), answer, ...base }, tokens };
    }
    case "write": {
      if (t.surface === "assistant") {
        return { kind: "blocked", message: "The page guide only explains and reads. Open the Copilot workspace to prepare a transaction.", ...base };
      }
      return handleWrite([intent.write], t);
    }
    case "chain": {
      if (t.surface === "assistant") return { kind: "blocked", message: "The page guide only explains and reads. Open the Copilot workspace to prepare transactions.", ...base };
      return handleWrite(intent.steps, t);
    }
    case "lever":
    case "unwind": {
      if (t.surface === "assistant") return { kind: "blocked", message: "The page guide only explains and reads. Open the Copilot workspace to prepare transactions.", ...base };
      const r = intent.lane === "lever" ? await planLever(intent.lever, t.ctx) : await planUnwind(intent.unwind, t.ctx);
      if (!r.ok) {
        if (r.options?.length) {
          const saved = await savePending(t.conversationId, t.user, r.options);
          return { kind: "clarification", message: r.message, clarify_options: saved.clarify_options, pending_id: saved.pending_id, ...base };
        }
        return { kind: "clarification", message: r.message, ...base };
      }
      return planPreview(r.plan, t);
    }
  }
}

// ── Write / plan lane ───────────────────────────────────────────────────────

async function resolveAmount(w: WriteIntent, index: number, t: Turn): Promise<{ ok: true; amount: string | null } | { ok: false; message: string }> {
  const a: AmountSpec | null = w.amount;
  if (!a) return { ok: true, amount: null };
  if (a.kind === "exact") return { ok: true, amount: a.value };
  if (a.kind === "all") return { ok: true, amount: "all" };
  if (a.kind === "out") return { ok: true, amount: `${OUT_PREFIX}${a.value}` };
  if (a.kind === "prev") return { ok: false, message: "That amount depends on an earlier step. Say it in the same request." };
  if (a.kind === "lev") return { ok: false, message: "A leverage target is sized together with the deposit it applies to. Say it in one request, for example: deposit 100 USDC in margin and borrow SOL at 3x." };
  if (index > 0) return { ok: false, message: "A percentage can only be used on the first step, because later amounts depend on earlier steps. Give an exact amount or say \"all\"." };
  if (!w.asset) return { ok: false, message: "Which asset is that percentage of?" };
  const r = await resolvePercent(w.op, w.asset, a.pct, { margin: w.source === "margin" }, t.ctx);
  return r.ok ? { ok: true, amount: r.amount } : { ok: false, message: r.message };
}

async function handleWrite(items: Array<{ write: WriteIntent } | { report: true } | WriteIntent>, t: Turn): Promise<Reply> {
  const { base } = t;
  const writes = items.map((i) => ("write" in i ? i.write : "report" in i ? null : i));
  const steps: StepSpec[] = [];
  const extras: string[] = [];
  let k = 0;
  for (let i = 0; i < items.length; i++) {
    const w = writes[i];
    if (!w) {
      steps.push(reportStep());
      continue;
    }
    if (w.op !== "create_account" && w.op !== "close_account" && !w.amount) {
      return { kind: "clarification", message: `How much${w.asset ? ` ${w.asset}` : ""} do you want to ${w.op.replace(/^earn_|^farm_/, "").replace("_", " ")}?`, ...base };
    }
    if (w.amount?.kind === "prev") {
      // "swap what I borrowed": the exact amount the previous write of this plan was sized to.
      const prior = [...steps].reverse().find((s) => s.kind === "write" && s.op !== "create_account" && s.op !== "close_account");
      let value = prior?.amount;
      // "borrow the max USDC and swap it": size the safe borrow now so the next step can use its exact amount. Only when
      // nothing earlier in the plan changes the account, because the size is taken from the account as it is now.
      if (prior && prior.op === "borrow" && value === "all" && prior.asset && steps.filter((s) => s.kind === "write").length === 1) {
        const sized = await sizeSafeBorrow(prior.asset as Asset, t.ctx);
        if (!sized.ok) return { kind: "clarification", message: sized.reason, ...base };
        prior.amount = sized.amount;
        value = sized.amount;
      }
      if (!prior || !value || value === "all" || value.startsWith(OUT_PREFIX)) {
        return { kind: "clarification", message: `How much${w.asset ? ` ${w.asset}` : ""} should the step after "${prior ? labelFor(prior) : "the first step"}" use? Its amount is only known once it runs.`, ...base };
      }
      steps.push(stepFromWrite(w, value));
      k++;
      continue;
    }
    if (w.amount?.kind === "lev") {
      // "borrow SOL 3x against that deposit": the amount is sized here from live prices and the health floor, never typed.
      const sized = await sizeLevBorrow(w, steps, t.ctx, copilotConfig.minHealthFactor);
      if (!sized.ok) return { kind: "clarification", message: sized.message, ...base };
      steps.push(stepFromWrite(w, sized.amount));
      extras.push(...sized.notes);
      k++;
      continue;
    }
    const r = await resolveAmount(w, k, t);
    if (!r.ok) return { kind: "clarification", message: r.message, ...base };
    steps.push(stepFromWrite(w, r.amount));
    k++;
  }

  if (!steps.some((s) => s.kind === "write")) {
    const out = await runRead({ kind: "health" }, t.ctx);
    return { kind: out.ok ? "answer" : "unavailable", message: answerToText(out.answer), answer: out.answer, ...base };
  }

  // Margin ops need a margin account: open one first when the user is depositing, say so otherwise.
  const firstMargin = steps.find((s) => s.kind === "write" && MARGIN_OPS.has(s.op));
  const hasCreate = steps.some((s) => s.op === "create_account");
  if (firstMargin && !hasCreate) {
    const h = await loadHealth(t.ctx);
    if (h.kind === "no_account") {
      if (firstMargin.op === "deposit") {
        steps.splice(steps.indexOf(firstMargin), 0, { kind: "write", op: "create_account", asset: null, amount: null, slots: {} });
        extras.push("You don't have a margin account yet, so the first step opens one.");
      } else {
        return { kind: "blocked", message: "You don't have a margin account yet. Say \"open a margin account\" and deposit collateral first.", ...base };
      }
    } else if (h.kind === "ok" && firstMargin.op === "farm_deposit" && firstMargin.asset && firstMargin.amount && firstMargin.amount !== "all") {
      // Kamino supplies from the margin balance: top it up from the wallet when it is short.
      const held = h.health.collateral.find((r) => r.symbol === firstMargin.asset)?.units ?? 0;
      const short = Number(firstMargin.amount) - held;
      if (short > 1e-9) {
        const spend = await walletSpendable(firstMargin.asset, t.ctx);
        if (spend === null || spend + 1e-9 < short) {
          return { kind: "blocked", message: `Kamino farm supplies from your margin balance, which holds ${fmtAmount(held, firstMargin.asset)}. Your wallet can't cover the ${fmtAmount(short, firstMargin.asset)} difference.`, ...base };
        }
        const dep: StepSpec = { kind: "write", op: "deposit", asset: firstMargin.asset, amount: String(Math.ceil(short * 1e9) / 1e9), slots: {} };
        steps.splice(steps.indexOf(firstMargin), 0, dep);
        extras.push(`Your margin balance holds ${fmtAmount(held, firstMargin.asset)}, so the first step deposits the ${fmtAmount(dep.amount as string, firstMargin.asset)} difference from your wallet.`);
      }
    }
  }
  if (steps.length > MAX_PLAN_STEPS) return { kind: "blocked", message: `That is more than ${MAX_PLAN_STEPS} steps. Ask for fewer at a time.`, ...base };

  const writeSteps = steps.filter((s) => s.kind === "write");
  if (steps.length === 1 && writeSteps.length === 1) return singleAction(steps[0], extras, t);

  // Plan lane: reads only here. The first step is checked now so an impossible plan is not offered;
  // later steps depend on earlier ones and are checked when their turn comes.
  const first = writeSteps[0];
  const probe = await preflightStep({ ...toStored(first, 1) }, t.ctx);
  if (!probe.ok) return failedCheck(probe, t);
  const unfunded = await checkFunding(steps, t.ctx);
  if (unfunded) return { kind: "blocked", message: unfunded, ...base };
  const summary = steps.map((s) => labelFor(s)).join(", then ").replace(/^./, (c) => c.toUpperCase()) + ".";
  return planPreview({ summary, steps, warnings: planWarnings(steps, extras), simulation: "prepared" in probe ? probe.prepared.simulation : null, hfFloor: copilotConfig.minHealthFactor }, t);
}

function toStored(s: StepSpec, n: number) {
  return { ...s, n, label: labelFor(s), venue: "other" as const, status: "pending" as const, claim: null, claimed_at: null, tx: null, signature: null, submitted_at: null, usd: null, note: null, resolved: null, builds: 0 };
}

function failedCheck(r: Extract<Awaited<ReturnType<typeof preflightStep>>, { ok: false }>, t: Turn): ChatResponse {
  const { base } = t;
  if (r.code === "limit") return { kind: "error", message: r.message, ...(r.limit ? { limit: { kind: r.limit.kind, retry_after_s: r.limit.retry_after_s, message: r.limit.message } } : {}), ...base };
  if (r.code === "risk" || r.code === "no_account" || r.code === "invalid") return { kind: "blocked", message: r.message, ...base };
  return { kind: "unavailable", message: r.message, ...base };
}

async function singleAction(step: StepSpec, extras: string[], t: Turn): Promise<Reply> {
  const { base } = t;
  const pre = await preflightStep(toStored(step, 1), t.ctx);
  if (!pre.ok) return failedCheck(pre, t);
  if ("skip" in pre) return { kind: "answer", message: pre.skip, ...base };
  const unfunded = await checkFunding([step], t.ctx);
  if (unfunded) return { kind: "blocked", message: unfunded, ...base };

  // Dry build: the MCP simulates the exact transaction now, so a failing action is explained before
  // the user is asked to approve anything. The real transaction is rebuilt (fresh blockhash) on advance.
  const dry = await buildStepTx(pre.prepared, t.ctx);
  if (!dry.ok) {
    if (dry.code === "limit") return { kind: "error", message: dry.message, ...(dry.limit ? { limit: { kind: dry.limit.kind, retry_after_s: dry.limit.retry_after_s, message: dry.limit.message } } : {}), ...base };
    return { kind: dry.code === "unavailable" ? "unavailable" : "error", message: dry.message, ...base };
  }

  const resolved = pre.prepared.resolvedAmount;
  const shown: StepSpec = { ...step, amount: resolved ?? step.amount };
  const planSummary = `${labelFor(shown)}.`;
  const rec = await createWorkflow({
    user: t.user,
    summary: planSummary,
    steps: [step],
    warnings: planWarnings([step], [...extras, ...pre.prepared.risk.reasons]),
    simulation: pre.prepared.simulation,
    requestId: base.request_id,
    conversationId: base.conversation_id,
  });
  const view: PlanView = toPlanView(rec);
  const preview: Preview = {
    template_id: step.op,
    human_summary: planSummary,
    slots: { op: step.op, asset: step.asset, amount: resolved ?? step.amount, ...(step.slots.to_asset ? { to_asset: String(step.slots.to_asset) } : {}) },
    risk: pre.prepared.risk,
    simulation: pre.prepared.simulation,
    requires_signature: true,
  };
  const lines = [
    `${planSummary}`,
    ...pre.prepared.notes,
    ...pre.prepared.risk.reasons,
    "The MCP simulated this transaction and it passed. Approve to continue; your wallet will then ask you to sign it. Nothing is sent until you do.",
  ];
  return { kind: "preview", message: lines.join("\n"), preview, plan: view, workflow_id: rec.id, ...base };
}

async function planPreview(plan: PlannedWorkflow, t: Turn): Promise<Reply> {
  const { base } = t;
  const rec = await createWorkflow({
    user: t.user,
    summary: plan.summary,
    steps: plan.steps,
    warnings: plan.warnings,
    simulation: plan.simulation,
    hfFloor: plan.hfFloor,
    requestId: base.request_id,
    conversationId: base.conversation_id,
  });
  const view = toPlanView(rec);
  const list = view.steps.map((s) => `${s.n}. ${s.label}`).join("\n");
  return {
    kind: "plan_preview",
    message: `${plan.summary}\n\n${list}\n\nThis plan is held on the server and is valid for 5 minutes. Approve it to start; each step is re-checked against live data before your wallet is asked to sign.`,
    plan: view,
    workflow_id: rec.id,
    ...base,
  };
}

