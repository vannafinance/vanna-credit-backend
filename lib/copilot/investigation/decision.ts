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
import { detectConditional } from "../conditional";
import {
  LEND_BORROW_ASSETS,
  PRODUCT_ASSETS,
  isLendBorrow,
  normalizeAsset,
  parseDecimalString,
  unofferedMessage,
  validateLever,
  validateWrite,
  PERP_OPS,
  perpMarketOf,
  type AmountSpec,
  type AskOption,
  type ChainStep,
  type Intent,
  type ReadCall,
  type WriteIntent,
  type WriteOp,
} from "../intent";
import { MAX_LEG_READS, MAX_PLAN_READS, MAX_PLAN_STEPS } from "../plan";
import { amountsAreTyped } from "../router";
import type { LlmFunctionDecl } from "../vertex";
import { numbersGrounded } from "../vertex";
import { READ_TOOLS, readArgsProblem } from "./catalog";
import type { InvestigationOutcome, Observation } from "./types";

const ASSETS = [...PRODUCT_ASSETS] as string[];
const WRITE_OPS: WriteOp[] = ["create_account", "close_account", "earn_supply", "earn_redeem", "deposit", "withdraw", "borrow", "repay", "swap", "farm_deposit", "farm_redeem", "perp_open", "perp_close", "perp_withdraw"];
export const SIZING_KINDS = ["literal", "usd", "fraction", "all", "max_safe", "health_target", "previous_leg", "leverage", "receive"] as const;
type SizingKind = (typeof SIZING_KINDS)[number];
const VENUES: AnswerVenue[] = ["earn", "kamino", "jupiter", "margin", "wallet", "oracle", "phoenix", "none"];

/** A leg that is not a transaction: something the user asked to see at that point of the plan. */
const REPORT_OP = "report";

const leg = {
  type: "OBJECT",
  properties: {
    op: { type: "STRING", enum: [...WRITE_OPS, REPORT_OP], description: "earn_supply/earn_redeem = Vanna Earn pool. deposit/withdraw = margin collateral. borrow/repay = margin debt. swap = Jupiter or Titan (the route is chosen separately). farm_deposit/farm_redeem = Kamino lend from the margin balance. create_account/close_account = the margin account itself. perp_open/perp_close/perp_withdraw = Phoenix perps (market, side, leverage; collateral is USDC from the margin account; NOT a Vanna loan; the server adds any USDC deposit and the first-trade registration itself). report = not a transaction: show the user what they asked to see at this point of the plan (fill reads and label; no asset or sizing)." },
    asset: { type: "STRING", enum: ASSETS, description: "Asset acted on. swap: the asset sold. farm ops: the underlying (SOL, not kSOL)." },
    to_asset: { type: "STRING", enum: ASSETS, description: "swap only: the asset bought." },
    source: { type: "STRING", enum: ["wallet", "margin"], description: "repay: which balance pays (default wallet). swap: margin = swap collateral inside the margin account." },
    market: { type: "STRING", enum: ["SOL", "ETH", "BTC", "TSLA", "META"], description: "perp_open / perp_close: the Phoenix perps market." },
    side: { type: "STRING", enum: ["long", "short"], description: "perp_open only." },
    leverage: { type: "NUMBER", description: "perp_open only: Phoenix leverage the user gave (1 up to the market's cap). Never invent it; ask_user if missing." },
    sizing: {
      type: "OBJECT",
      description: "How much. Never compute a number yourself.",
      properties: {
        kind: { type: "STRING", enum: [...SIZING_KINDS], description: "literal = a number of tokens the user typed (digits, or number words written as digits). usd = a dollar value the user typed (\"$100 worth of SOL\", \"100 dollars of USDC\"): converted to tokens at the oracle price. fraction = a percentage of the relevant balance (\"half my USDC\" = 50). all = the whole balance / whole debt. max_safe = the largest amount that keeps the health floor (borrow, withdraw). health_target = sized so the account's health factor ends at a number the user gave (borrow, withdraw: down to it; repay, deposit: up to it). previous_leg = the amount the previous action produced, or a percentage of it (\"swap half of it\": percent 50). leverage = a borrow sized to N x leverage on a base: borrow value = base value x (N - 1), nothing swapped (borrow only). receive = swap sized to receive a typed amount of to_asset." },
        amount: { type: "STRING", description: "literal / receive: the user's exact token amount, as a decimal. usd: the user's dollar amount, as a decimal (no $ sign)." },
        percent: { type: "NUMBER", description: "fraction, previous_leg: 0-100." },
        target_hf: { type: "NUMBER", description: "health_target: the health factor the user asked to end at, e.g. 1.5." },
        as_written: { type: "STRING", description: "literal / usd / receive / health_target, only when the user wrote that number in words, in any language (\"two and a half\", \"a hundred\", \"cien\"): those words exactly as they appear in the message. Give amount (or target_hf) as digits too. Omit when they typed digits." },
        multiple: { type: "NUMBER", description: "leverage: the multiple, e.g. 3." },
        base_asset: { type: "STRING", enum: ASSETS, description: "leverage: the asset the user named as the base (\"using 0.5 SOL\" -> SOL). Omit when the base is a deposit in this request or the whole account." },
        base_amount: { type: "STRING", description: "leverage: the base amount the user typed (\"using 0.5 SOL\" -> \"0.5\")." },
      },
      required: ["kind"],
    },
    reads: {
      type: "ARRAY",
      description: `report only: the read tools that answer what the user asked to see (1 to ${MAX_LEG_READS}). They run when the plan reaches this leg, on live data, so they show the account after every earlier action.`,
      items: {
        type: "OBJECT",
        properties: {
          tool: { type: "STRING", enum: READ_TOOLS.map((t) => t.name), description: "A read tool (the same ones you can call now)." },
          args_json: { type: "STRING", description: 'The tool\'s arguments as a JSON object, exactly as you would call it now, e.g. {"assets":["USDC","SOL"]}. "{}" when it takes none.' },
        },
        required: ["tool"],
      },
    },
    label: { type: "STRING", description: 'report only: a short title for this step on the plan card, e.g. "Show your Earn balances and pool APY". No figures.' },
    source_quote: { type: "STRING", description: "The user's own words, copied from their message (or an earlier message of theirs), that ask for THIS action or report. One you cannot quote was not asked for: leave it out." },
  },
  required: ["op", "source_quote"],
};

/** The same leg inside a question's options: the options are alternatives the user picks, so they quote nothing. */
const optionLeg = { ...leg, properties: Object.fromEntries(Object.entries(leg.properties).filter(([k]) => k !== "source_quote")), required: ["op"] };

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
    description: `Finish: the transactions the user asked for, in their order, for their wallet to approve and sign (at most ${MAX_PLAN_STEPS}), plus a report leg for each thing they asked to SEE before, between or after them (at most ${MAX_PLAN_READS}), placed exactly where they asked for it. Use for any direct instruction, one or many, including a loan or borrow at N x leverage (borrow with leverage sizing, nothing swapped). Every action and report quotes the user's words that ask for it; never add one they did not ask for (the server adds account creation itself).`,
    parameters: {
      type: "OBJECT",
      properties: {
        actions: { type: "ARRAY", items: leg },
        not_done: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              part: { type: "STRING", description: "The user's own words for that part, copied from their message." },
              reason: { type: "STRING", description: "Why it is not done, in one plain sentence (no figures that are not in the evidence)." },
              kind: { type: "STRING", enum: ["waits_for_condition_or_time", "not_offered", "other"], description: "waits_for_condition_or_time: it should happen only when something becomes true, at a later time, or repeatedly (a conditional, scheduled, recurring or standing order). The product only acts now." },
            },
            required: ["part", "reason", "kind"],
          },
          description: "Parts of the request that will not be done, each with the reason. They are shown with the plan; the actions above still go ahead. Never also propose an action for a part listed here. Empty when everything is covered.",
        },
        requested_count: { type: "NUMBER", description: "How many transactions the user asked for in total, counting every one they listed (repeats count separately), including ones in not_done. Reports are not transactions." },
        no_condition: { type: "BOOLEAN", description: "true only when the message contains no condition, time or repetition at all for any transaction, even though some words may look like one. Leave unset otherwise." },
      },
      required: ["actions", "requested_count"],
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
        borrow_asset: { type: "STRING", enum: [...LEND_BORROW_ASSETS], description: "The asset borrowed to fund the exposure (not the asset being levered). Only if the user named it; otherwise omit and the user is asked." },
        amount: { type: "STRING", description: "Units of the asset to lever, only a number the user typed. Omit to lever what is already in the margin account." },
        min_hf: { type: "NUMBER", description: "Only a health-factor floor the user stated; it can only raise the default." },
        source_quote: { type: "STRING", description: "The user's own words that ask for more exposure to the asset." },
        no_condition: { type: "BOOLEAN", description: "true only when the message contains no condition, time or repetition at all, even though some words may look like one." },
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
        no_condition: { type: "BOOLEAN", description: "true only when the message contains no condition, time or repetition at all, even though some words may look like one." },
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
    description: "Finish: the request is outside what this product may do (off-topic, other tokens, other wallets, liquidating someone, admin actions, options/futures/spot shorts, conditional or scheduled orders, sending funds elsewhere).",
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

/** Share of the quote's words found in `text`. */
function coverage(quote: string, text: string): number {
  const q = words(quote);
  if (!q.length) return 0;
  const t = new Set(words(text));
  return q.filter((w) => t.has(w)).length / q.length;
}

/**
 * The not-done part an action's quote comes from, if any: its words are in that part and not elsewhere in the
 * message. "sell 1 SOL" quoted from a part held back as "sell 1 SOL when it hits 200" is that conditional order, never
 * a new request to act now.
 */
function heldPartOf(quote: unknown, parts: string[], message: string): string | null {
  if (typeof quote !== "string" || !parts.length) return null;
  const held = parts.find((p) => coverage(quote, p) >= 0.8);
  if (!held) return null;
  let rest = message;
  for (const p of parts) rest = rest.split(p).join(" ");
  return coverage(quote, rest) >= 0.8 ? null : held;
}

/** The user's words, normalised, for checking that a phrase the model copied is really in them. */
const userText = (ctx: DecisionContext) =>
  [ctx.message, ...ctx.history.filter((h) => h.role === "user").map((h) => h.text)].join(" \n ").toLowerCase().replace(/\s+/g, " ");

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
  if (op === "create_account" || op === "close_account" || op === "perp_register") return { ok: true, amount: null };
  if ((op === "perp_close" || op === "perp_withdraw") && (!s || typeof s !== "object")) return { ok: true, amount: { kind: "all" } };
  if (op === "perp_open" || op === "perp_close" || op === "perp_withdraw") {
    const kind = (s as Record<string, unknown>).kind;
    const allowed = op === "perp_open" ? ["literal", "usd"] : op === "perp_close" ? ["all", "fraction"] : ["literal", "usd", "all"];
    if (!allowed.includes(String(kind))) return { ok: false, reason: `action ${index + 1} (${op}): sizing must be one of ${allowed.join(", ")} (perps collateral and withdrawals are USDC amounts; a close is all or a fraction)` };
  }
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
    case "previous_leg": {
      if (index === 0) return { ok: false, reason: "previous_leg cannot be used on the first action" };
      if (o.percent === undefined || o.percent === null) return { ok: true, amount: { kind: "prev" } };
      const p = typeof o.percent === "number" ? o.percent : Number(o.percent);
      if (!Number.isFinite(p) || p <= 0 || p > 100) return { ok: false, reason: `action ${index + 1}: previous_leg percent must be between 0 and 100` };
      return { ok: true, amount: p >= 100 ? { kind: "prev" } : { kind: "prev", pct: p } };
    }
    case "usd": {
      const v = typeof o.amount === "number" ? parseDecimalString(String(o.amount)) : typeof o.amount === "string" ? parseDecimalString(o.amount.trim().replace(/^\$/, "")) : null;
      return v ? { ok: true, amount: { kind: "usd", value: v } } : { ok: false, reason: `action ${index + 1}: usd sizing needs the user's dollar amount in amount` };
    }
    case "health_target": {
      const t = typeof o.target_hf === "number" ? o.target_hf : Number(o.target_hf);
      if (!Number.isFinite(t)) return { ok: false, reason: `action ${index + 1}: health_target needs target_hf, the health factor the user gave` };
      return { ok: true, amount: { kind: "hf", target: t } };
    }
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
/** A report leg -> the read calls it makes, checked now (it runs later, when nobody can correct it). */
function readLegCalls(r: Record<string, unknown>, index: number): { ok: true; reads: ReadCall[] } | { ok: false; reason: string } {
  const raw = Array.isArray(r.reads) ? r.reads : [];
  if (!raw.length) return { ok: false, reason: `report ${index + 1} names no read tool: give the read tools that answer what the user asked to see` };
  if (raw.length > MAX_LEG_READS) return { ok: false, reason: `report ${index + 1} has more than ${MAX_LEG_READS} reads` };
  const reads: ReadCall[] = [];
  for (const x of raw) {
    const o = (x ?? {}) as Record<string, unknown>;
    const tool = typeof o.tool === "string" ? o.tool : "";
    let args: Record<string, unknown> = {};
    if (typeof o.args_json === "string" && o.args_json.trim()) {
      try {
        const parsed = JSON.parse(o.args_json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: `report ${index + 1}: args_json of ${tool} must be a JSON object` };
        args = parsed as Record<string, unknown>;
      } catch {
        return { ok: false, reason: `report ${index + 1}: args_json of ${tool} is not valid JSON` };
      }
    }
    const problem = readArgsProblem(tool, args);
    if (problem) return { ok: false, reason: `report ${index + 1}: ${problem}` };
    reads.push({ tool, args });
  }
  return { ok: true, reads };
}

function actionsToIntent(raw: unknown, ctx: DecisionContext, requireQuotes = true): ActionsResult {
  const rows = Array.isArray(raw) ? raw : [];
  if (!rows.length) return { ok: false, reason: "at least one action is needed" };
  const isReport = (r: unknown) => !!r && typeof r === "object" && (r as Record<string, unknown>).op === REPORT_OP;
  const writeCount = rows.filter((r) => !isReport(r)).length;
  if (writeCount > MAX_PLAN_STEPS) return { ok: true, intent: { lane: "refuse", reason: "guard", message: `That is more than ${MAX_PLAN_STEPS} steps. Ask for fewer at a time.` } };
  if (rows.length - writeCount > MAX_PLAN_READS) return { ok: false, reason: `at most ${MAX_PLAN_READS} report legs; combine the reads the user asked for at the same point into one report` };
  if (!writeCount) return { ok: false, reason: "propose_actions needs at least one transaction. When the user only asks to see something, read it now and use answer" };
  const steps: ChainStep[] = [];
  // Amounts the user wrote in words: the model read them; they count as typed when its copy of the words is in the message.
  const wordAmounts: number[] = [];
  const said = userText(ctx);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown>;
    if (isReport(r)) {
      if (requireQuotes && !quotesUser(r.source_quote, ctx)) {
        return { ok: false, reason: `report ${i + 1} does not quote the user's own words asking to see it. Quote them exactly, or leave it out if the user did not ask for it` };
      }
      const calls = readLegCalls(r, i);
      if (!calls.ok) return { ok: false, reason: calls.reason };
      const label = str(r.label, 80);
      const quote = str(r.source_quote, 300);
      if (label && !numbersGrounded(label, groundingSources(ctx))) return { ok: false, reason: `report ${i + 1}: the label must not state figures` };
      steps.push({ read: { question: quote ?? label ?? "", label: label ? plain(label) : "Show what you asked for", reads: calls.reads } });
      continue;
    }
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
    const sz = (r.sizing ?? {}) as Record<string, unknown>;
    const written = typeof sz.as_written === "string" ? sz.as_written.trim().toLowerCase().replace(/\s+/g, " ") : "";
    if (written) {
      if (!/\p{L}/u.test(written) || !said.includes(written)) {
        return { ok: false, reason: `action ${i + 1} (${op}): as_written "${sz.as_written}" is not in the user's message; copy their words exactly, or omit it when they typed digits` };
      }
      const a = sized.amount;
      if (a && (a.kind === "exact" || a.kind === "usd" || a.kind === "out")) wordAmounts.push(Number(a.value));
      if (a && a.kind === "hf") wordAmounts.push(a.target);
    }
    const w: WriteIntent = {
      op,
      asset: typeof r.asset === "string" ? normalizeAsset(r.asset) : null,
      to_asset: typeof r.to_asset === "string" ? normalizeAsset(r.to_asset) : null,
      amount: sized.amount,
      source: r.source === "margin" ? "margin" : r.source === "wallet" ? "wallet" : null,
      ...(PERP_OPS.has(op)
        ? {
            market: perpMarketOf(r.market),
            side: r.side === "long" || r.side === "short" ? r.side : null,
            leverage: typeof r.leverage === "number" ? r.leverage : r.leverage !== undefined ? Number(r.leverage) : null,
          }
        : {}),
    };
    const v = validateWrite(w);
    // A guard message ("Pick two different assets") goes back to the model, which can ask the user or decline.
    if (!v.ok) return { ok: false, reason: `action ${i + 1} (${op}): ${v.message}. If that is what the user asked, tell them with ask_user or decline` };
    steps.push({ write: v.value });
  }
  const intent: Intent = steps.length === 1 && "write" in steps[0] ? { lane: "write", write: steps[0].write } : { lane: "chain", steps };
  if (!amountsAreTyped(intent, ctx.message, ctx.history, wordAmounts)) {
    return { ok: false, reason: "a literal, usd or receive amount, or a health_target, is not a number the user gave. Use them only for numbers in the user's messages (digits, or words copied into as_written); otherwise use a sizing word, or ask_user for the amount" };
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
        const r = actionsToIntent(opt.actions, ctx, false);
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
      const cond = detectConditional(ctx.message);
      if (cond && args.no_condition !== true) return no(`this message reads as a condition, a time or a repeat ("${cond.phrase}"). The product only acts now: decline that, or ask_user; if nothing in it is a condition, set no_condition`);
      const scope = ["all", "margin", "earn", "farm"].includes(String(args.scope)) ? (args.scope as "all" | "margin" | "earn" | "farm") : null;
      if (!scope) return no("propose_unwind needs a scope");
      return { ok: true, name, outcome: { kind: "intent", intent: { lane: "unwind", unwind: { scope, close_account: args.close_account === true } } } };
    }
    case "propose_leverage": {
      const cond = detectConditional(ctx.message);
      if (cond && args.no_condition !== true) return no(`this message reads as a condition, a time or a repeat ("${cond.phrase}"). The product only acts now: decline that, or ask_user; if nothing in it is a condition, set no_condition`);
      if (!quotesUser(args.source_quote, ctx)) {
        return no("propose_leverage needs the user's own words asking for more exposure to the asset (source_quote). If they asked for a loan or borrow at a leverage multiple instead, use propose_actions with leverage sizing and no swap");
      }
      const asset = typeof args.asset === "string" ? normalizeAsset(args.asset) : null;
      if (!asset) return no(typeof args.asset === "string" ? unofferedMessage(args.asset) : "propose_leverage needs an asset");
      const multiple = typeof args.multiple === "number" ? args.multiple : Number(args.multiple);
      const amount = typeof args.amount === "string" ? parseDecimalString(args.amount.trim()) : typeof args.amount === "number" ? parseDecimalString(String(args.amount)) : null;
      const named = typeof args.borrow_asset === "string" ? normalizeAsset(args.borrow_asset) : null;
      const borrow = named && isLendBorrow(named) ? named : null;
      const minHf = typeof args.min_hf === "number" && args.min_hf > copilotConfig.minHealthFactor ? args.min_hf : null;
      const intent: Intent = { lane: "lever", lever: { asset, leverage: multiple, borrow_asset: borrow, amount, min_hf: minHf } };
      if (!amountsAreTyped(intent, ctx.message, ctx.history)) return no(`the lever amount ${amount} is not a number the user typed; omit amount to lever the existing balance, or ask`);
      const v = validateLever({ asset, leverage: multiple, borrow_asset: borrow, amount, min_hf: minHf });
      if (!v.ok) return { ok: true, name, outcome: { kind: "intent", intent: { lane: "refuse", reason: "guard", message: v.message } } };
      return { ok: true, name, outcome: { kind: "intent", intent: { lane: "lever", lever: v.value } } };
    }
    case "propose_actions": {
      const r = actionsToIntent(args.actions, ctx);
      if (!r.ok) return no(r.reason);
      // What will not be done is said, in plain words, next to what will be done.
      const notDone: Array<{ part: string; reason: string; kind: string }> = [];
      for (const raw of (Array.isArray(args.not_done) ? args.not_done : []).slice(0, 5)) {
        const o = (raw ?? {}) as Record<string, unknown>;
        const part = str(o.part, 240);
        const reason = str(o.reason, 240);
        if (!part || !reason) return no("each not_done entry needs the user's words for the part (part) and the reason");
        if (!quotesUser(part, ctx)) return no(`not_done part "${part}" is not the user's own words; copy them from the message`);
        if (!numbersGrounded(reason, sources)) return no("a not_done reason contains a figure that is not in any tool result");
        if (/\b(?:tools?|function\s+calls?|system\s+prompt|instructions?|gemini|model)\b/i.test(reason)) return no("not_done reasons must not mention how you work inside (tools, instructions, the model); say what the user can't do and why");
        notDone.push({ part, reason, kind: typeof o.kind === "string" ? o.kind : "other" });
      }
      // A part the model holds back can never also be an action.
      const parts = notDone.map((n) => n.part);
      for (const [i, a] of (Array.isArray(args.actions) ? args.actions : []).entries()) {
        const held = heldPartOf((a as Record<string, unknown>)?.source_quote, parts, ctx.message);
        if (held) return no(`action ${i + 1} comes from "${held}", which you listed in not_done. A part is either done now or not done; never both`);
      }
      // The server's own check for conditional, scheduled or recurring wording is a cross-check on the model's reading:
      // a message that reads as one must say how it was read (a part held back, a health-factor target, a what-if), or
      // state that it holds no condition at all.
      const cond = detectConditional(ctx.message);
      if (cond && args.no_condition !== true) {
        const raw = Array.isArray(args.actions) ? (args.actions as Array<Record<string, unknown>>) : [];
        const explained =
          notDone.some((n) => n.kind === "waits_for_condition_or_time") ||
          raw.some((a) => (a?.sizing as Record<string, unknown> | undefined)?.kind === "health_target") ||
          raw.some((a) => a?.op === "report" && Array.isArray(a.reads) && (a.reads as Array<Record<string, unknown>>).some((x) => x?.tool === "simulate"));
        if (!explained) {
          return no(
            `this message reads as a condition, a time or a repeat ("${cond.phrase}"). The product only acts now. If part of it should wait for a condition or a time, or repeat, put that part in not_done (kind waits_for_condition_or_time) and keep the rest; if it is a health-factor target for an action now, size that action with health_target; if it is a what-if, show it with a simulate report; if nothing in it is a condition, set no_condition`,
          );
        }
      }
      // The step cap is code's rule: when a full plan leaves out transactions the user asked for, code says how many.
      const writes = r.intent.lane === "chain" ? r.intent.steps.filter((s) => "write" in s).length : r.intent.lane === "write" ? 1 : 0;
      const asked = typeof args.requested_count === "number" && Number.isFinite(args.requested_count) ? Math.round(args.requested_count) : writes;
      const notes = notDone.map((n) => `Not done: "${plain(n.part)}". ${n.reason}`);
      if (asked > writes + notDone.length) {
        if (writes < MAX_PLAN_STEPS) {
          return no(`the user asked for ${asked} transactions and you proposed ${writes}, with ${notDone.length} in not_done. Propose every one, or list the ones that will not be done in not_done`);
        }
        const left = asked - writes - notDone.length;
        notes.push(`A plan holds at most ${MAX_PLAN_STEPS} transactions, so ${left === 1 ? "the last one is" : `the last ${left} are`} not in this plan; ask for ${left === 1 ? "it" : "them"} after this plan completes.`);
      }
      const intent = notes.length && (r.intent.lane === "write" || r.intent.lane === "chain") ? { ...r.intent, notes: notes.map(plain) } : r.intent;
      return { ok: true, name, outcome: { kind: "intent", intent } };
    }
    default:
      return no(`unknown decision ${name}`);
  }
}
