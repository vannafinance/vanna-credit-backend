/**
 * The decisions that end an investigation, and the strict boundary that turns them into something the rest of the turn
 * can run (stage 2 -> stage 3).
 *
 * The model chooses WHAT to do; it never chooses a number. An action's amount is either a number the user typed, or a
 * sizing word (fraction, all, max_safe, previous_leg, leverage, receive) that stage 3 sizes from live data with the
 * protocol's own maths. Everything a decision names is re-checked by the same guards the deterministic lanes use
 * (`intent.ts`), and an answer is refused if it contains a figure that is not in the evidence.
 */

import type { AnswerFact, AnswerVenue, StructuredAnswer } from "../answer-schema";
import { copilotConfig } from "../config";
import {
  PRODUCT_ASSETS,
  normalizeAsset,
  parseDecimalString,
  unofferedMessage,
  validateLever,
  validateWrite,
  type AmountSpec,
  type AskOption,
  type Intent,
  type WriteIntent,
  type WriteOp,
} from "../intent";
import { MAX_PLAN_STEPS } from "../plan";
import { amountsAreTyped } from "../router";
import type { LlmFunctionDecl } from "../vertex";
import { numbersGrounded } from "../vertex";
import type { InvestigationOutcome, Observation } from "./types";

const ASSETS = [...PRODUCT_ASSETS] as string[];
const WRITE_OPS: WriteOp[] = ["create_account", "close_account", "earn_supply", "earn_redeem", "deposit", "withdraw", "borrow", "repay", "swap", "farm_deposit", "farm_redeem"];
export const SIZING_KINDS = ["literal", "fraction", "all", "max_safe", "previous_leg", "leverage", "receive"] as const;
type SizingKind = (typeof SIZING_KINDS)[number];
const VENUES: AnswerVenue[] = ["earn", "kamino", "jupiter", "margin", "wallet", "oracle", "none"];

const leg = {
  type: "OBJECT",
  properties: {
    op: { type: "STRING", enum: WRITE_OPS, description: "earn_supply/earn_redeem = Vanna Earn pool. deposit/withdraw = margin collateral. borrow/repay = margin debt. swap = Jupiter. farm_deposit/farm_redeem = Kamino lend from the margin balance. create_account/close_account = the margin account itself." },
    asset: { type: "STRING", enum: ASSETS, description: "Asset acted on. swap: the asset sold. farm ops: the underlying (SOL, not kSOL)." },
    to_asset: { type: "STRING", enum: ASSETS, description: "swap only: the asset bought." },
    source: { type: "STRING", enum: ["wallet", "margin"], description: "repay: which balance pays (default wallet). swap: margin = swap collateral inside the margin account." },
    sizing: {
      type: "OBJECT",
      description: "How much. Never compute a number yourself.",
      properties: {
        kind: { type: "STRING", enum: [...SIZING_KINDS], description: "literal = a number the user typed. fraction = a percentage of the relevant balance. all = the whole balance / whole debt. max_safe = the largest amount that keeps the health floor (borrow, withdraw). previous_leg = the amount the previous action produced. leverage = a borrow sized to N x leverage on a base: borrow value = base value x (N - 1), nothing swapped (borrow only). receive = swap sized to receive a typed amount of to_asset." },
        amount: { type: "STRING", description: "literal / receive: the user's exact decimal, copied." },
        percent: { type: "NUMBER", description: "fraction: 0-100." },
        multiple: { type: "NUMBER", description: "leverage: the multiple, e.g. 3." },
        base_asset: { type: "STRING", enum: ASSETS, description: "leverage: the asset the user named as the base (\"using 0.5 SOL\" -> SOL). Omit when the base is a deposit in this request or the whole account." },
        base_amount: { type: "STRING", description: "leverage: the base amount the user typed (\"using 0.5 SOL\" -> \"0.5\")." },
      },
      required: ["kind"],
    },
    source_quote: { type: "STRING", description: "The user's own words, copied from their message (or an earlier message of theirs), that ask for THIS action. An action you cannot quote was not asked for: leave it out." },
  },
  required: ["op", "sizing", "source_quote"],
};

/** The same leg inside a question's options: the options are alternatives the user picks, so they quote nothing. */
const optionLeg = { ...leg, properties: Object.fromEntries(Object.entries(leg.properties).filter(([k]) => k !== "source_quote")), required: ["op", "sizing"] };

export const DECISION_TOOLS: LlmFunctionDecl[] = [
  {
    name: "answer",
    description: "Finish: answer a question from the evidence. Every figure must come from a tool result in the evidence, written as it appears there.",
    parameters: {
      type: "OBJECT",
      properties: {
        headline: { type: "STRING", description: "One or two plain sentences that answer the question directly." },
        facts: { type: "ARRAY", items: { type: "OBJECT", properties: { label: { type: "STRING" }, value: { type: "STRING" } }, required: ["label", "value"] }, description: "Supporting figures, at most 12." },
        note: { type: "STRING", description: "Optional context or trade-off, at most two sentences. No price predictions." },
        venue: { type: "STRING", enum: VENUES },
      },
      required: ["headline"],
    },
  },
  {
    name: "propose_actions",
    description: `Finish: the transactions the user asked for, in their order, for their wallet to approve and sign (at most ${MAX_PLAN_STEPS}). Use for any direct instruction, one or many, including a loan or borrow at N x leverage (borrow with leverage sizing, nothing swapped). Every action quotes the user's words that ask for it; never add one they did not ask for (the server adds account creation itself).`,
    parameters: {
      type: "OBJECT",
      properties: {
        actions: { type: "ARRAY", items: leg },
        report_health: { type: "BOOLEAN", description: "true when the user also asked to see the health factor afterwards." },
      },
      required: ["actions"],
    },
  },
  {
    name: "propose_leverage",
    description: "Finish: a leveraged LONG, only when the user wants MORE EXPOSURE to an asset (to hold more of it with borrowed funds): the server deposits the asset if needed, borrows a stable, SWAPS it into the asset inside the margin account, and sizes it so the health floor holds at the swap's worst price. Not for a loan or borrow at N x leverage: that is propose_actions with leverage sizing, with no swap.",
    parameters: {
      type: "OBJECT",
      properties: {
        asset: { type: "STRING", enum: ASSETS },
        multiple: { type: "NUMBER", description: "Exposure as a multiple of equity, above 1 and at most 10." },
        borrow_asset: { type: "STRING", enum: ["USDC", "USDT"], description: "Only if the user named it; otherwise omit and the user is asked." },
        amount: { type: "STRING", description: "Units of the asset to lever, only a number the user typed. Omit to lever what is already in the margin account." },
        min_hf: { type: "NUMBER", description: "Only a health-factor floor the user stated; it can only raise the default." },
        source_quote: { type: "STRING", description: "The user's own words that ask for more exposure to the asset." },
      },
      required: ["asset", "multiple", "source_quote"],
    },
  },
  {
    name: "propose_unwind",
    description: "Finish: exit positions in an order where health only improves (redeem Kamino, repay debt, withdraw collateral, redeem Earn).",
    parameters: {
      type: "OBJECT",
      properties: {
        scope: { type: "STRING", enum: ["all", "margin", "earn", "farm"] },
        close_account: { type: "BOOLEAN", description: "Also close the emptied margin account, only if the user asked to close the account." },
      },
      required: ["scope"],
    },
  },
  {
    name: "ask_user",
    description: "Finish: one short question, when an essential detail is genuinely missing or two readings would lead to different transactions. Do not ask what the evidence or the conversation already answers. When the answer is a choice between concrete alternatives (for example the Earn pool or margin collateral), give each alternative as an option the user can pick.",
    parameters: {
      type: "OBJECT",
      properties: {
        question: { type: "STRING" },
        options: {
          type: "ARRAY",
          description: "2 to 4 concrete alternatives, each a complete set of actions (same shape as propose_actions).",
          items: {
            type: "OBJECT",
            properties: { label: { type: "STRING", description: "Short button text." }, description: { type: "STRING" }, actions: { type: "ARRAY", items: optionLeg } },
            required: ["label", "actions"],
          },
        },
      },
      required: ["question"],
    },
  },
  {
    name: "decline",
    description: "Finish: the request is outside what this product may do (off-topic, other tokens, other wallets, liquidating someone, admin actions, perpetuals/options/shorts, conditional or scheduled orders, sending funds elsewhere).",
    parameters: { type: "OBJECT", properties: { reason: { type: "STRING", description: "One or two sentences for the user, naming what you can do instead." } }, required: ["reason"] },
  },
];

export const DECISION_NAMES = new Set(DECISION_TOOLS.map((t) => t.name));

export type ParsedDecision = { ok: true; outcome: InvestigationOutcome; name: string } | { ok: false; reason: string };

export interface DecisionContext {
  message: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  evidence: Observation[];
}

const no = (reason: string): ParsedDecision => ({ ok: false, reason });
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
/** Gemini sometimes wraps emphasis in markdown; the UI never renders markup. */
const plain = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/^\s*[-•*]\s+/gm, "").trim();

function groundingSources(ctx: DecisionContext): string[] {
  return [
    ctx.message,
    ...ctx.history.filter((h) => h.role === "user").map((h) => h.text),
    ...ctx.evidence.filter((o) => o.ok).map((o) => o.result),
    `${copilotConfig.minHealthFactor} ${copilotConfig.maxActionUsd} ${copilotConfig.maxDailyUsd} ${MAX_PLAN_STEPS}`,
  ];
}

function sizingToAmount(s: unknown, op: WriteOp, index: number): { ok: true; amount: AmountSpec | null } | { ok: false; reason: string } {
  if (op === "create_account" || op === "close_account") return { ok: true, amount: null };
  if (!s || typeof s !== "object") return { ok: false, reason: `action ${index + 1} (${op}) has no sizing` };
  const o = s as Record<string, unknown>;
  const kind = o.kind as SizingKind;
  switch (kind) {
    case "literal": {
      const v = typeof o.amount === "number" ? parseDecimalString(String(o.amount)) : typeof o.amount === "string" ? parseDecimalString(o.amount.trim()) : null;
      return v ? { ok: true, amount: { kind: "exact", value: v } } : { ok: false, reason: `action ${index + 1}: literal sizing needs the user's exact decimal in amount` };
    }
    case "receive": {
      const v = typeof o.amount === "string" ? parseDecimalString(o.amount.trim()) : typeof o.amount === "number" ? parseDecimalString(String(o.amount)) : null;
      if (op !== "swap") return { ok: false, reason: `action ${index + 1}: receive sizing is only for swaps` };
      return v ? { ok: true, amount: { kind: "out", value: v } } : { ok: false, reason: `action ${index + 1}: receive sizing needs the amount to receive` };
    }
    case "fraction": {
      const p = typeof o.percent === "number" ? o.percent : Number(o.percent);
      if (!Number.isFinite(p) || p <= 0 || p > 100) return { ok: false, reason: `action ${index + 1}: fraction needs a percent between 0 and 100` };
      return { ok: true, amount: p >= 100 ? { kind: "all" } : { kind: "pct", pct: p } };
    }
    case "all":
      return { ok: true, amount: { kind: "all" } };
    case "max_safe":
      if (op !== "borrow" && op !== "withdraw") return { ok: false, reason: `action ${index + 1}: max_safe only applies to borrow or withdraw; use all for ${op}` };
      return { ok: true, amount: { kind: "all" } };
    case "previous_leg":
      if (index === 0) return { ok: false, reason: "previous_leg cannot be used on the first action" };
      return { ok: true, amount: { kind: "prev" } };
    case "leverage": {
      const m = typeof o.multiple === "number" ? o.multiple : Number(o.multiple);
      if (op !== "borrow") return { ok: false, reason: `action ${index + 1}: leverage sizing is only for a borrow; use propose_leverage for a leveraged long` };
      if (!Number.isFinite(m)) return { ok: false, reason: `action ${index + 1}: leverage sizing needs a multiple` };
      const baseAsset = typeof o.base_asset === "string" ? normalizeAsset(o.base_asset) : null;
      const baseValue = typeof o.base_amount === "string" ? parseDecimalString(o.base_amount.trim()) : typeof o.base_amount === "number" ? parseDecimalString(String(o.base_amount)) : null;
      if ((baseAsset === null) !== (baseValue === null)) return { ok: false, reason: `action ${index + 1}: a leverage base needs both base_asset and base_amount, or neither` };
      return { ok: true, amount: { kind: "lev", multiple: m, ...(baseAsset && baseValue ? { base: { asset: baseAsset, value: baseValue } } : {}) } };
    }
    default:
      return { ok: false, reason: `action ${index + 1}: unknown sizing kind ${String(o.kind)}` };
  }
}

const STANDARD_DECLINE = "I can't help with that here. I only help with Vanna on Solana: Earn, margin, swaps, Kamino farm and your positions.";

type ActionsResult = { ok: true; intent: Intent } | { ok: false; reason: string };

const words = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}.]+/gu, " ").split(" ").map((w) => w.replace(/^\.+|\.+$/g, "")).filter(Boolean);

/**
 * True when `quote` is the user's own words: at least 80% of its words appear in their messages. An action the model
 * cannot quote is one the user did not ask for, which is how an invented step (an extra swap, a deposit nobody
 * mentioned) is caught without any rule about particular phrasings.
 */
export function quotesUser(quote: unknown, ctx: DecisionContext): boolean {
  if (typeof quote !== "string") return false;
  const q = words(quote);
  if (!q.length) return false;
  const said = new Set(words([ctx.message, ...ctx.history.filter((h) => h.role === "user").map((h) => h.text)].join(" ")));
  const found = q.filter((w) => said.has(w)).length;
  return found / q.length >= 0.8;
}

/** A list of action legs (propose_actions, or one choice of ask_user) -> a guarded write or chain intent. */
function actionsToIntent(raw: unknown, reportHealth: boolean, ctx: DecisionContext, requireQuotes = true): ActionsResult {
  const rows = Array.isArray(raw) ? raw : [];
  if (!rows.length) return { ok: false, reason: "at least one action is needed" };
  if (rows.length > MAX_PLAN_STEPS) return { ok: true, intent: { lane: "refuse", reason: "guard", message: `That is more than ${MAX_PLAN_STEPS} steps. Ask for fewer at a time.` } };
  const steps: Array<{ write: WriteIntent } | { report: true }> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown>;
    if (!r || typeof r !== "object" || !WRITE_OPS.includes(r.op as WriteOp)) return { ok: false, reason: `action ${i + 1} has an unknown op` };
    const op = r.op as WriteOp;
    if (requireQuotes && !quotesUser(r.source_quote, ctx)) {
      return { ok: false, reason: `action ${i + 1} (${op}) does not quote the user's own words asking for it. Quote them exactly, or leave the action out if the user did not ask for it` };
    }
    for (const k of ["asset", "to_asset"]) {
      const v = r[k];
      if (typeof v === "string" && v.trim() && !normalizeAsset(v)) return { ok: true, intent: { lane: "refuse", reason: "guard", message: unofferedMessage(v) } };
    }
    const sized = sizingToAmount(r.sizing, op, i);
    if (!sized.ok) return { ok: false, reason: sized.reason };
    const w: WriteIntent = {
      op,
      asset: typeof r.asset === "string" ? normalizeAsset(r.asset) : null,
      to_asset: typeof r.to_asset === "string" ? normalizeAsset(r.to_asset) : null,
      amount: sized.amount,
      source: r.source === "margin" ? "margin" : r.source === "wallet" ? "wallet" : null,
    };
    const v = validateWrite(w);
    // A guard message ("Pick two different assets") goes back to the model, which can ask the user or decline.
    if (!v.ok) return { ok: false, reason: `action ${i + 1} (${op}): ${v.message}. If that is what the user asked, tell them with ask_user or decline` };
    steps.push({ write: v.value });
  }
  if (reportHealth) steps.push({ report: true });
  const intent: Intent = steps.length === 1 && "write" in steps[0] ? { lane: "write", write: steps[0].write } : { lane: "chain", steps };
  if (!amountsAreTyped(intent, ctx.message, ctx.history)) {
    return { ok: false, reason: "a literal amount is not a number the user typed. Use literal only for numbers in the user's messages; otherwise use a sizing word, or ask_user for the amount" };
  }
  return { ok: true, intent };
}

export function parseDecision(name: string, args: Record<string, unknown>, ctx: DecisionContext): ParsedDecision {
  const sources = groundingSources(ctx);
  switch (name) {
    case "answer": {
      const headline = str(args.headline, 600);
      if (!headline) return no("answer needs a headline");
      const facts: AnswerFact[] = (Array.isArray(args.facts) ? args.facts : [])
        .slice(0, 12)
        .flatMap((f) => (f && typeof f === "object" && str((f as Record<string, unknown>).label, 80) && str((f as Record<string, unknown>).value, 120) ? [{ label: plain(String((f as Record<string, unknown>).label)), value: plain(String((f as Record<string, unknown>).value)) }] : []));
      const note = str(args.note, 400);
      const text = [headline, note ?? "", ...facts.map((f) => `${f.label} ${f.value}`)].join(" ");
      if (!numbersGrounded(text, sources)) {
        return no("the answer contains a figure that is not in any tool result. Use only figures exactly as the tools returned them, or read the missing figure first");
      }
      const venue = VENUES.includes(args.venue as AnswerVenue) ? (args.venue as AnswerVenue) : "none";
      const answer: StructuredAnswer = { headline: plain(headline), facts, ...(note ? { note: plain(note) } : {}), venue };
      return { ok: true, name, outcome: { kind: "answer", answer } };
    }
    case "ask_user": {
      const q = str(args.question, 400);
      if (!q) return no("ask_user needs a question");
      if (!numbersGrounded(q, sources)) return no("the question contains a figure that is not in any tool result");
      // Each choice is a complete set of actions, checked exactly like propose_actions; an invalid one is left out.
      const options: AskOption[] = (Array.isArray(args.options) ? args.options : []).slice(0, 4).flatMap((o) => {
        if (!o || typeof o !== "object") return [];
        const opt = o as Record<string, unknown>;
        const label = str(opt.label, 80);
        if (!label || !numbersGrounded(label, sources)) return [];
        const r = actionsToIntent(opt.actions, false, ctx, false);
        if (!r.ok || (r.intent.lane !== "write" && r.intent.lane !== "chain")) return [];
        const description = str(opt.description, 160);
        return [{ label: plain(label), ...(description && numbersGrounded(description, sources) ? { description: plain(description) } : {}), apply: r.intent }];
      });
      const intent: Intent = { lane: "ask", question: plain(q), ...(options.length >= 2 ? { options } : {}) };
      return { ok: true, name, outcome: { kind: "intent", intent } };
    }
    case "decline": {
      const reason = str(args.reason, 400);
      // A refusal never discusses how the Copilot works inside (tools, instructions, debugging, the model).
      const internal = reason && /\b(?:debug\w*|traces?|system\s+prompt|prompts?|instructions?|tools?|internals?|function\s+calls?|gemini|model)\b/i.test(reason);
      const message = reason && !internal && numbersGrounded(reason, sources) ? plain(reason) : STANDARD_DECLINE;
      return { ok: true, name, outcome: { kind: "intent", intent: { lane: "refuse", reason: "model_decline", message } } };
    }
    case "propose_unwind": {
      const scope = ["all", "margin", "earn", "farm"].includes(String(args.scope)) ? (args.scope as "all" | "margin" | "earn" | "farm") : null;
      if (!scope) return no("propose_unwind needs a scope");
      return { ok: true, name, outcome: { kind: "intent", intent: { lane: "unwind", unwind: { scope, close_account: args.close_account === true } } } };
    }
    case "propose_leverage": {
      if (!quotesUser(args.source_quote, ctx)) {
        return no("propose_leverage needs the user's own words asking for more exposure to the asset (source_quote). If they asked for a loan or borrow at a leverage multiple instead, use propose_actions with leverage sizing and no swap");
      }
      const asset = typeof args.asset === "string" ? normalizeAsset(args.asset) : null;
      if (!asset) return no(typeof args.asset === "string" ? unofferedMessage(args.asset) : "propose_leverage needs an asset");
      const multiple = typeof args.multiple === "number" ? args.multiple : Number(args.multiple);
      const amount = typeof args.amount === "string" ? parseDecimalString(args.amount.trim()) : typeof args.amount === "number" ? parseDecimalString(String(args.amount)) : null;
      const borrow = args.borrow_asset === "USDC" || args.borrow_asset === "USDT" ? args.borrow_asset : null;
      const minHf = typeof args.min_hf === "number" && args.min_hf > copilotConfig.minHealthFactor ? args.min_hf : null;
      const intent: Intent = { lane: "lever", lever: { asset, leverage: multiple, borrow_asset: borrow, amount, min_hf: minHf } };
      if (!amountsAreTyped(intent, ctx.message, ctx.history)) return no(`the lever amount ${amount} is not a number the user typed; omit amount to lever the existing balance, or ask`);
      const v = validateLever({ asset, leverage: multiple, borrow_asset: borrow, amount, min_hf: minHf });
      if (!v.ok) return { ok: true, name, outcome: { kind: "intent", intent: { lane: "refuse", reason: "guard", message: v.message } } };
      return { ok: true, name, outcome: { kind: "intent", intent: { lane: "lever", lever: v.value } } };
    }
    case "propose_actions": {
      const r = actionsToIntent(args.actions, args.report_health === true, ctx);
      return r.ok ? { ok: true, name, outcome: { kind: "intent", intent: r.intent } } : no(r.reason);
    }
    default:
      return no(`unknown decision ${name}`);
  }
}
