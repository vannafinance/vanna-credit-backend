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
import { fmtAmount, fmtUsd, humanizeMcpError } from "./explain";
import type { AmountSpec, AskOption, Asset, ChainStep, Intent, SwapProvider, WriteIntent } from "./intent";
import { isDepositable, PERP_OPS, VAULT_OPS, withNamedProvider } from "./intent";
import { checkAndConsume, LimitContentionError, recordTokens, spentTodayUsd } from "./limits";
import { mcp } from "./mcp-client";
import { loadFreshPrice, loadHealth, runRead, sizeSafeBorrow, type ReadCtx } from "./mcp-facts";
import { floorDecimals, tokenDecimals, usdToUnits } from "./risk";
import { HF_PREFIX, MAX_PLAN_STEPS, OUT_PREFIX, balancesTouched, labelFor, percentBalance, planWarnings, providerName, readLegStep, stepFromWrite, reportStep, MARGIN_OPS, type StepSpec } from "./plan";
import { conditionalRefusal, routeMessage } from "./router";
import { productRefusal } from "./domain-firewall";
import { composeDecline } from "./decline";
import { investigate } from "./investigation";
import { llmConfigured } from "./vertex";
import type { ChatRequest, ChatResponse, Preview, PlanView } from "./types";
import { wordAnswer } from "./vertex";
import { createWorkflow, toPlanView, WorkflowError } from "./workflow";
import { isConversationId, savePending, takePending } from "./workflow/pending";
import { planLever, type PlannedWorkflow } from "./workflow/strategy";
import { planUnwind } from "./workflow/unwind";
import { checkFunding } from "./workflow/funding";
import { sizeBorrowAgainst, sizeLevBorrow } from "./workflow/leverage-borrow";
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
      if (!fw.allow) {
        if (fw.kind === "empty") return { kind: "clarification", message: fw.message, ...base };
        // The rule decided the refusal; Gemini words it for this message (the rule's own wording if it can't).
        const declined = await composeDecline({ message, reason: fw.reason, fallback: fw.message, history, signal });
        tokens += declined.tokens;
        return { kind: "blocked", message: declined.text, ...base };
      }
      let decided: Intent | null = null;
      if (modelDecides) {
        // Stage 2: Gemini reads the whole message, including which parts wait for a condition, a time or a repeat, or
        // ask for something the product does not offer, and decides. Its decision is guarded (decision.ts): a part it
        // holds back can never become an action, and a message that reads as a conditional order must say how it read it.
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
        // Without the model, conditional and scheduled orders and unoffered products are refused whole, in the
        // product's words, before the keyword router (which cannot tell a condition from an instruction).
        const refused = conditionalRefusal(message) ?? productRefusal(message);
        if (refused) return { kind: "blocked", message: refused, ...base };
        // The model is off, unreachable, or ran out of budget: the deterministic router answers instead.
        const routed = await routeMessage(message, history, signal);
        intent = routed.intent;
        source = routed.source;
        tokens += routed.tokens;
      }
      // "via Titan" / "using Jupiter" in the user's own words picks a swap's route, whichever router read the message.
      intent = withNamedProvider(intent, message);
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
    case "refuse": {
      // Gemini's own decline is already its wording; a guard's or the router's refusal is worded for this message.
      if (intent.reason === "model_decline") return { kind: "blocked", message: intent.message, ...base };
      const declined = await composeDecline({ message: t.message, reason: intent.reason, fallback: intent.message, history: t.history, signal: t.signal });
      return { response: { kind: "blocked", message: declined.text, ...base }, tokens: declined.tokens };
    }
    case "unknown": {
      if (t.source === "unavailable") {
        return { kind: "unavailable", message: `I couldn't work out what you meant, and the language model that handles free-form requests is not reachable right now. ${CAPABILITY_LINE}`, ...base };
      }
      const asked = await composeDecline({ message: t.message, reason: "unknown", fallback: `I'm not sure what you'd like to do. ${CAPABILITY_LINE}`, history: t.history, signal: t.signal });
      return { response: { kind: "clarification", message: asked.text, ...base }, tokens: asked.tokens };
    }
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
      return handleWrite([intent.write], t, intent.notes);
    }
    case "chain": {
      if (t.surface === "assistant") return { kind: "blocked", message: "The page guide only explains and reads. Open the Copilot workspace to prepare transactions.", ...base };
      return handleWrite(intent.steps, t, intent.notes);
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

/**
 * Before each perps open: a USDC deposit from the wallet when the margin account holds less than the order's collateral
 * (never a borrow), and the Phoenix registration step the first time (the app's separate first transaction).
 */
async function preparePerps(steps: StepSpec[], t: Turn, extras: string[]): Promise<Reply | null> {
  if (!steps.some((s) => s.op === "perp_open")) return null;
  let pos: Record<string, unknown>;
  try {
    pos = await mcp.perpsPositions(t.user.wallet, t.ctx);
  } catch (err) {
    return { kind: "unavailable", message: `I couldn't read your Phoenix account just now (${humanizeMcpError(err).message}), so I won't plan a perps order.`, ...t.base };
  }
  let marginUsdc = Number(pos.margin_usdc ?? 0) || 0;
  let registered = pos.has_phoenix_account === true;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.op === "deposit" && s.asset === "USDC" && s.amount && s.amount !== "all") marginUsdc += Number(s.amount);
    if (s.op === "perp_register") registered = true;
    if (s.op !== "perp_open") continue;
    const need = Number(s.amount ?? 0);
    if (need > marginUsdc + 1e-9) {
      const short = (Math.ceil((need - marginUsdc) * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, "");
      steps.splice(i, 0, stepFromWrite({ op: "deposit", asset: "USDC", amount: { kind: "exact", value: short } }, short));
      extras.push(`Your margin account holds ${marginUsdc} USDC, so the plan first deposits ${short} USDC from your wallet to back the order.`);
      marginUsdc += Number(short);
      i++;
    }
    if (!registered) {
      steps.splice(i, 0, { kind: "write", op: "perp_register", asset: null, amount: null, slots: {} });
      extras.push("This is your first Phoenix trade: one extra signature creates your Phoenix trading account.");
      registered = true;
      i++;
    }
    marginUsdc -= need;
  }
  return null;
}

/**
 * Before each vault deposit: a USDC deposit from the wallet when the margin account holds less than the deposit (never
 * a borrow) - except SOL Basis, which the vault program takes from the WALLET, followed by the step that moves the new
 * shares into the margin account (the app's second transaction).
 */
async function prepareVaults(steps: StepSpec[], t: Turn, extras: string[]): Promise<Reply | null> {
  if (!steps.some((s) => s.op === "vault_deposit")) return null;
  let marginUsdc = 0;
  try {
    const h = await loadHealth(t.ctx);
    if (h.kind === "ok") marginUsdc = h.health.collateral.find((r) => r.symbol === "USDC")?.units ?? 0;
  } catch {
    return { kind: "unavailable", message: "I couldn't read your margin account just now, so I won't plan a vault deposit.", ...t.base };
  }
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.op === "deposit" && s.asset === "USDC" && s.amount && s.amount !== "all") marginUsdc += Number(s.amount);
    if (s.op !== "vault_deposit") continue;
    // Every vault deposit spends the margin account's USDC (SOL Basis too: one transaction routes it through the
    // wallet and returns the vbSOL to the margin account).
    const need = Number(s.amount ?? 0);
    if (need > marginUsdc + 1e-9) {
      const short = (Math.ceil((need - marginUsdc) * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, "");
      steps.splice(i, 0, stepFromWrite({ op: "deposit", asset: "USDC", amount: { kind: "exact", value: short } }, short));
      extras.push(`Your margin account holds ${marginUsdc} USDC, so the plan first deposits ${short} USDC from your wallet for the vault.`);
      marginUsdc += Number(short);
      i++;
    }
    marginUsdc -= need;
  }
  return null;
}

/**
 * The first swap of the request that names no route and has an exact amount: if both Jupiter and Titan quote it, ask
 * which to use (each option re-runs the same request with that route). One provider quoting: use it. None: leave it to
 * the build, which reports the error. Titan quotes only with a key on the server and for the user's own wallet.
 */
async function askSwapRoute(
  items: Array<ChainStep | WriteIntent>,
  writes: Array<WriteIntent | null>,
  steps: StepSpec[],
  t: Turn,
  notes: string[],
  extras: string[],
): Promise<Reply | null> {
  for (let i = 0; i < writes.length; i++) {
    const w = writes[i];
    const step = steps[i];
    if (!w || w.op !== "swap" || w.provider || !step || step.op !== "swap" || step.slots.provider) continue;
    if (!w.asset || !w.to_asset || !step.amount || !(Number(step.amount) > 0)) continue;
    let quote: Record<string, unknown>;
    try {
      quote = await mcp.swapQuote(
        {
          from_asset: w.asset,
          to_asset: w.to_asset,
          amount: step.amount,
          slippage_bps: Number(step.slots.slippage_bps) || 100,
          authority: t.user.wallet,
          mode: step.slots.mode === "margin" ? "margin" : "wallet",
        },
        t.ctx,
      );
    } catch {
      continue; // the build reports the route problem
    }
    const quotes = (Array.isArray(quote.providers) ? quote.providers : []) as Array<Record<string, unknown>>;
    const usable = quotes.filter((p) => p.provider === "jupiter" || p.provider === "titan");
    if (usable.length === 1) {
      step.slots.provider = String(usable[0]!.provider);
      if (quote.titan_status === "no-route") extras.push(`Titan has no route for this swap, so it goes through Jupiter.`);
      continue;
    }
    if (usable.length < 2) continue;
    const patched = (provider: SwapProvider): Intent => {
      const next = items.map((it, j) => (j !== i ? it : "write" in it ? { write: { ...it.write, provider } } : { ...(it as WriteIntent), provider }));
      return items.some((it) => "write" in it || "read" in it || "report" in it)
        ? { lane: "chain", steps: next as ChainStep[], notes }
        : { lane: "write", write: next[0] as WriteIntent, notes };
    };
    const options: AskOption[] = usable.map((p) => ({
      label: `${providerName(String(p.provider))}: ${p.out_amount} ${w.to_asset} (min ${p.min_out_amount})${p.best ? " · better" : ""}`,
      apply: patched(p.provider as SwapProvider),
    }));
    const saved = await savePending(t.conversationId, t.user, options);
    return {
      kind: "clarification",
      message: `Which route for swapping ${step.amount} ${w.asset} to ${w.to_asset}? Both quote it right now; the better output is marked.`,
      clarify_options: saved.clarify_options,
      pending_id: saved.pending_id,
      ...t.base,
    };
  }
  return null;
}

async function resolveAmount(w: WriteIntent, earlier: StepSpec[], t: Turn): Promise<{ ok: true; amount: string | null } | { ok: false; message: string }> {
  const a: AmountSpec | null = w.amount;
  if (!a) return { ok: true, amount: null };
  if (a.kind === "exact") return { ok: true, amount: a.value };
  if (a.kind === "all") return { ok: true, amount: "all" };
  if (a.kind === "out") return { ok: true, amount: `${OUT_PREFIX}${a.value}` };
  if (a.kind === "prev") return { ok: false, message: "That amount depends on an earlier step. Say it in the same request." };
  if (a.kind === "lev") return { ok: false, message: "A leverage target is sized together with the deposit it applies to. Say it in one request, for example: deposit 100 USDC in margin and borrow SOL at 3x." };
  if (a.kind === "hf") return { ok: true, amount: `${HF_PREFIX}${a.target}` };
  if (a.kind === "against") return { ok: false, message: "A borrow against a holding is sized with the plan. Say it in one request." };
  if (a.kind === "usd") return { ok: false, message: "That dollar amount couldn't be converted." };
  if (!w.asset) return { ok: false, message: "Which asset is that percentage of?" };
  // A percentage is sized now, from the balance as it is. That is exact unless an earlier step of this plan changes
  // that same balance ("withdraw 50% of my SOL" after "deposit 2 SOL"); then the share is only known once that runs.
  const balance = percentBalance(w);
  const writes = earlier.filter((s) => s.kind === "write");
  const blocking = writes.find((s) => balance === null || balancesTouched(s).some((k) => k === "*" || k === balance));
  if (blocking) {
    return { ok: false, message: `${a.pct}% of your ${w.asset} depends on "${labelFor(blocking)}" running first, so I can't size it yet. Give an exact ${w.asset} amount for it, or say "all".` };
  }
  const r = await resolvePercent(w.op, w.asset, a.pct, { margin: w.source === "margin" }, t.ctx);
  return r.ok ? { ok: true, amount: r.amount } : { ok: false, message: r.message };
}

/**
 * A vault deposit or perps collateral given as "all" or a percentage of the user's USDC: sized now from the margin
 * account's USDC plus the wallet's (the plan tops the margin up from the wallet). Like any percentage, only when no
 * earlier step of this plan changes that USDC.
 */
async function usdcShare(w: WriteIntent, earlier: StepSpec[], t: Turn): Promise<{ ok: true; amount: string; note: string } | { ok: false; message: string }> {
  const pct = w.amount?.kind === "pct" ? w.amount.pct : 100;
  const blocking = earlier.find((s) => s.kind === "write" && balancesTouched(s).some((k) => k === "*" || k === "wallet:USDC" || k === "margin:USDC"));
  if (blocking) return { ok: false, message: `${pct === 100 ? "All" : `${pct}% of`} your USDC depends on "${labelFor(blocking)}" running first, so I can't size it yet. Give an exact USDC amount for it.` };
  const inWallet = (await walletSpendable("USDC", t.ctx)) ?? 0;
  let inMargin = 0;
  const h = await loadHealth(t.ctx);
  if (h.kind === "ok") inMargin = h.health.collateral.find((r) => r.symbol === "USDC")?.units ?? 0;
  const total = inWallet + inMargin;
  if (!(total > 0)) return { ok: false, message: "You have no USDC in your wallet or margin account for that." };
  const amount = floorDecimals((total * pct) / 100, tokenDecimals("USDC"));
  if (!(Number(amount) > 0)) return { ok: false, message: `${pct}% of your USDC is too small to use. Give an amount instead.` };
  const where = `your ${floorDecimals(inMargin, 6)} USDC in margin plus ${floorDecimals(inWallet, 6)} in your wallet`;
  return { ok: true, amount, note: `${pct === 100 ? "All" : `${pct}% of`} ${where} is ${amount} USDC.` };
}

async function handleWrite(items: Array<ChainStep | WriteIntent>, t: Turn, notes: string[] = []): Promise<Reply> {
  const { base } = t;
  const writes = items.map((i) => ("write" in i ? i.write : "report" in i || "read" in i ? null : i));
  const steps: StepSpec[] = [];
  // Parts of the request that can't be done lead the plan's notes, so the user sees them before approving.
  const extras: string[] = [...notes];
  for (let i = 0; i < items.length; i++) {
    const w = writes[i];
    if (!w) {
      const item = items[i];
      // Something the user asked to see at this point: it runs when the plan reaches it.
      steps.push("read" in item ? readLegStep(item.read) : reportStep());
      continue;
    }
    if ((w.op === "vault_deposit" || w.op === "perp_open") && (w.amount?.kind === "all" || w.amount?.kind === "pct")) {
      // "put half my USDC in USD*", "open a SOL long with all my USDC": a share of the USDC the plan can fund it from.
      const sized = await usdcShare(w, steps, t);
      if (!sized.ok) return { kind: "clarification", message: sized.message, ...base };
      steps.push(stepFromWrite(w, sized.amount));
      extras.push(sized.note);
      continue;
    }
    if (VAULT_OPS.has(w.op)) {
      // Vaults: a deposit is a USDC amount; a withdrawal is a share amount, all of them, or a fraction of them.
      const amount = w.amount?.kind === "exact" || w.amount?.kind === "usd" ? w.amount.value : w.op === "vault_deposit" ? null : "all";
      const step = stepFromWrite(w, amount);
      if (w.op === "vault_withdraw" && w.amount?.kind === "pct" && w.amount.pct < 100) step.slots.fraction = w.amount.pct / 100;
      steps.push(step);
      continue;
    }
    if (PERP_OPS.has(w.op)) {
      // Perps: collateral (perp_open) and USDC (perp_withdraw) are USDC amounts; a close is all of it or a fraction.
      const amount = w.amount?.kind === "exact" || w.amount?.kind === "usd" ? w.amount.value : w.op === "perp_open" ? null : "all";
      steps.push(stepFromWrite(w, amount));
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
      if (!prior || !value || value === "all" || value.startsWith(OUT_PREFIX) || value.startsWith(HF_PREFIX)) {
        return { kind: "clarification", message: `How much${w.asset ? ` ${w.asset}` : ""} should the step after "${prior ? labelFor(prior) : "the first step"}" use? Its amount is only known once it runs.`, ...base };
      }
      if (w.amount.pct !== undefined && w.amount.pct < 100) {
        // "swap half of it": that share of the earlier step's exact amount, rounded down to the token's decimals.
        const share = floorDecimals((Number(value) * w.amount.pct) / 100, tokenDecimals(w.asset ?? prior.asset ?? ""));
        if (!(Number(share) > 0)) return { kind: "clarification", message: `${w.amount.pct}% of ${value} is too small to use. Give an amount instead.`, ...base };
        value = share;
      }
      steps.push(stepFromWrite(w, value));
      continue;
    }
    if (w.amount?.kind === "lev") {
      // "borrow SOL 3x against that deposit": the amount is sized here from live prices and the health floor, never typed.
      const sized = await sizeLevBorrow(w, steps, t.ctx, copilotConfig.minHealthFactor);
      if (!sized.ok) return { kind: "clarification", message: sized.message, ...base };
      steps.push(stepFromWrite(w, sized.amount));
      extras.push(...sized.notes);
      continue;
    }
    if (w.amount?.kind === "against") {
      // "borrow what I can against 5 JupSOL": sized here on that holding, from live prices and the health floor.
      const sized = await sizeBorrowAgainst(w, steps, t.ctx, copilotConfig.minHealthFactor);
      if (!sized.ok) return { kind: "clarification", message: sized.message, ...base };
      steps.push(stepFromWrite(w, sized.amount));
      extras.push(...sized.notes);
      continue;
    }
    if (w.amount?.kind === "usd" && w.asset) {
      // "$100 worth of SOL": converted once, at the protocol's oracle price, so the plan carries an exact amount.
      const price = await loadFreshPrice(w.asset, t.ctx);
      if (!price) return { kind: "unavailable", message: `The ${w.asset} price is unavailable right now, so I can't turn $${w.amount.value} into ${w.asset}.`, ...base };
      const units = usdToUnits(Number(w.amount.value), price.usd, w.asset);
      if (!(Number(units) > 0)) return { kind: "clarification", message: `$${w.amount.value} is less than the smallest ${w.asset} amount. Give a larger amount.`, ...base };
      steps.push(stepFromWrite(w, units));
      extras.push(`$${w.amount.value} of ${w.asset} at the oracle price of ${fmtUsd(price.usd)} is ${units} ${w.asset}.`);
      continue;
    }
    const r = await resolveAmount(w, steps, t);
    if (!r.ok) return { kind: "clarification", message: r.message, ...base };
    steps.push(stepFromWrite(w, r.amount));
  }

  // A swap with no route named: show both providers' quotes and let the user pick (only when the amount is exact - an
  // "all" or exact-out swap is sized when it runs, and takes the better quote then).
  const route = await askSwapRoute(items, writes, steps, t, notes, extras);
  if (route) return route;

  // A perps open needs the USDC in the margin account and, the first time, a Phoenix trading account: add those steps.
  const perpPrep = await preparePerps(steps, t, extras);
  if (perpPrep) return perpPrep;

  // A vault deposit needs the USDC where the vault takes it from, and SOL Basis a second step for its shares.
  const vaultPrep = await prepareVaults(steps, t, extras);
  if (vaultPrep) return vaultPrep;

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
        if (!isDepositable(firstMargin.asset)) {
          return {
            kind: "blocked",
            message: `Kamino farm supplies from your margin balance, which holds ${fmtAmount(held, firstMargin.asset)}. ${firstMargin.asset} can't be deposited as margin collateral, so I can't top it up from your wallet; borrow or swap into ${firstMargin.asset} inside the margin account first, or farm a smaller amount.`,
            ...base,
          };
        }
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
  if (steps.filter((s) => s.kind === "write").length > MAX_PLAN_STEPS) return { kind: "blocked", message: `That is more than ${MAX_PLAN_STEPS} steps. Ask for fewer at a time.`, ...base };

  const writeSteps = steps.filter((s) => s.kind === "write");
  if (steps.length === 1 && writeSteps.length === 1) return singleAction(steps[0], extras, t);

  // Plan lane: reads only here. The first step is checked now so an impossible plan is not offered;
  // later steps depend on earlier ones and are checked when their turn comes.
  const first = writeSteps[0];
  const [probe, unfunded] = await Promise.all([preflightStep({ ...toStored(first, 1) }, t.ctx), checkFunding(steps, t.ctx)]);
  if (!probe.ok) return failedCheck(probe, t);
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
  // The step's own checks and the wallet-funding check read independent data: run together, results used in order.
  const [pre, unfunded] = await Promise.all([preflightStep(toStored(step, 1), t.ctx), checkFunding([step], t.ctx)]);
  if (!pre.ok) return failedCheck(pre, t);
  if ("skip" in pre) return { kind: "answer", message: pre.skip, ...base };
  if (unfunded) return { kind: "blocked", message: unfunded, ...base };

  // Dry build: the MCP simulates the exact transaction now, so a failing action is explained before
  // the user is asked to approve anything. The real transaction is rebuilt (fresh blockhash) on advance.
  const dry = await buildStepTx(pre.prepared, t.ctx);
  if (!dry.ok) {
    if (dry.code === "limit") return { kind: "error", message: dry.message, ...(dry.limit ? { limit: { kind: dry.limit.kind, retry_after_s: dry.limit.retry_after_s, message: dry.limit.message } } : {}), ...base };
    return { kind: dry.code === "unavailable" ? "unavailable" : "error", message: dry.message, ...base };
  }

  // Since the 2026-10-09 program upgrade a wallet's first margin transactions may need a one-time lookup-table setup.
  if (dry.tx.prerequisite_kind === "phoenix_fund") extras = [...extras, "Your account holds enough assets that this order doesn't fit in one Solana transaction: your wallet first signs a transaction that moves the USDC into Phoenix, then the order itself."];
  else if (dry.tx.prerequisite) extras = [...extras, "Your wallet first signs a one-time setup (a lookup table so margin transactions fit in one Solana transaction); then the action itself."];
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
    ...extras,
    ...pre.prepared.notes,
    ...pre.prepared.risk.reasons,
    "The MCP simulated this transaction and it passed. Approve to continue; your wallet will then ask you to sign it. Nothing is sent until you do.",
  ];
  return { kind: "preview", message: lines.join("\n"), preview, plan: view, workflow_id: rec.id, ...base };
}

/**
 * The spending limits for a whole plan, checked before it is offered. Each step is checked again when it runs (prices
 * move), but a plan whose step is already over the per-action limit, or whose total would pass today's limit, must not
 * be offered at all: the user would approve it, sign the first steps, and be stopped halfway.
 */
async function planSpendProblem(steps: StepSpec[], t: Turn): Promise<string | null> {
  const perAction = copilotConfig.maxActionUsd;
  const daily = copilotConfig.maxDailyUsd;
  if (!Number.isFinite(perAction) && !Number.isFinite(daily)) return null; // no limit configured: nothing to check
  let total = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== "write" || !s.asset || !s.amount || !/^\d+(?:\.\d+)?$/.test(s.amount)) continue; // "all" / receive-sized: checked when built
    const p = await loadFreshPrice(s.asset, t.ctx);
    if (!p) continue;
    const usd = Number(s.amount) * p.usd;
    total += usd;
    if (usd > perAction) {
      return `Step ${i + 1} (${labelFor(s)}) is worth about ${fmtUsd(usd)}, above the per-action limit of ${fmtUsd(perAction)}, so I haven't prepared this plan. Ask for a smaller amount.`;
    }
  }
  const spent = await spentTodayUsd(t.user);
  if (spent + total > daily) {
    return `This plan is worth about ${fmtUsd(total)}; with ${fmtUsd(spent)} already done today it would pass the daily limit of ${fmtUsd(daily)}, so I haven't prepared it. Ask for a smaller amount.`;
  }
  return null;
}

async function planPreview(plan: PlannedWorkflow, t: Turn): Promise<Reply> {
  const { base } = t;
  const overLimit = await planSpendProblem(plan.steps, t);
  if (overLimit) return { kind: "blocked", message: overLimit, ...base };
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

