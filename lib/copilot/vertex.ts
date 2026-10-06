/**
 * Gemini on Vertex AI: language only.
 *
 * The model does exactly two jobs here, and code owns everything else:
 *   1. ROUTE: turn a sentence into an intent through native function calling (`routeWithModel`).
 *      The result goes through the same guards as the keyword router; it cannot add an asset, an op
 *      or an amount the product does not support.
 *   2. WORD: re-phrase the headline/note of an answer whose figures were already fixed by code
 *      (`wordAnswer`). Its text is discarded if it contains any number that is not in the data.
 *
 * Real path: `@google/genai` with `vertexai: true`, project from env, location `global`,
 * credentials from Application Default Credentials (attached service account / workload identity in
 * production, `gcloud auth application-default login` locally). Tests inject a fake `LlmClient`.
 */

import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { copilotConfig } from "./config";
import type { StructuredAnswer } from "./answer-schema";
import { DOMAIN_FIREWALL_SYSTEM } from "./domain-firewall";
import {
  PRODUCT_ASSETS,
  normalizeAsset,
  parseDecimalString,
  unofferedMessage,
  validateLever,
  validateRead,
  validateWrite,
  type AmountSpec,
  type Intent,
  type ReadIntent,
  type WriteIntent,
  type WriteOp,
} from "./intent";

// ── Client seam ─────────────────────────────────────────────────────────────

export interface LlmFunctionDecl {
  name: string;
  description: string;
  /** Omitted for a tool without arguments: Vertex rejects an OBJECT schema with no properties. */
  parameters?: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  user: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  tools?: LlmFunctionDecl[];
  /** Require a function call (routing) instead of free text. */
  forceTool?: boolean;
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  /** How much the model may reason before answering. Routing and wording need little; investigation needs more. */
  thinkingLevel?: "LOW" | "MEDIUM" | "HIGH";
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string | null;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Total tokens the call used, for the per-user daily cap. */
  tokens: number;
}

export interface LlmClient {
  generate(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailable";
  }
}

let injected: LlmClient | null = null;
let real: LlmClient | null = null;

/** Tests inject a fake; pass null to restore the real client. */
export function setLlmClient(client: LlmClient | null): void {
  injected = client;
}

class VertexClient implements LlmClient {
  private ai: GoogleGenAI;
  constructor(project: string, location: string) {
    this.ai = new GoogleGenAI({ vertexai: true, project, location });
  }

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const contents = [
      ...(req.history ?? []).map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text }] })),
      { role: "user", parts: [{ text: req.user }] },
    ];
    const res = await this.ai.models.generateContent({
      model: copilotConfig.vertexModel,
      contents,
      config: {
        systemInstruction: req.system,
        temperature: 0,
        maxOutputTokens: req.maxOutputTokens ?? 512,
        // Gemini 3.x bills thinking tokens against maxOutputTokens; unbounded thinking can leave no room for the
        // answer (empty text). Routing and wording need little reasoning.
        thinkingConfig: { thinkingLevel: ThinkingLevel[req.thinkingLevel ?? "LOW"] },
        ...(req.tools?.length
          ? {
              tools: [{ functionDeclarations: req.tools as never }],
              toolConfig: { functionCallingConfig: { mode: req.forceTool ? "ANY" : "AUTO" } } as never,
            }
          : {}),
        ...(req.responseSchema ? { responseMimeType: "application/json", responseSchema: req.responseSchema as never } : {}),
        ...(req.signal ? { abortSignal: req.signal } : {}),
      },
    });
    const calls = (res.functionCalls ?? []).flatMap((c) => (c.name ? [{ name: c.name, args: (c.args ?? {}) as Record<string, unknown> }] : []));
    let text: string | null = null;
    try {
      text = res.text ?? null;
    } catch {
      text = null; // a pure function-call response has no text part
    }
    const used = res.usageMetadata?.totalTokenCount;
    const estimated = Math.ceil((req.system.length + req.user.length + (text?.length ?? 0) + JSON.stringify(calls).length) / 4);
    return { text, calls, tokens: typeof used === "number" && used > 0 ? used : estimated };
  }
}

export function getLlm(): LlmClient {
  if (injected) return injected;
  const project = copilotConfig.googleCloudProject;
  if (!project) throw new LlmUnavailable("GOOGLE_CLOUD_PROJECT is not set, so the language model is unavailable.");
  return (real ??= new VertexClient(project, copilotConfig.googleCloudLocation));
}

export function llmConfigured(): boolean {
  return injected !== null || !!copilotConfig.googleCloudProject;
}

/** Health probe: one tiny real call. */
export async function vertexPing(): Promise<{ ok: boolean; model: string; error?: string }> {
  const model = copilotConfig.vertexModel;
  try {
    const r = await getLlm().generate({ system: "Reply with the single word ok.", user: "ping", maxOutputTokens: 64 });
    return { ok: !!r.text, model };
  } catch (e) {
    return { ok: false, model, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Routing by function calling ─────────────────────────────────────────────

const ASSET_ENUM = [...PRODUCT_ASSETS];
const WRITE_OPS: WriteOp[] = ["create_account", "close_account", "earn_supply", "earn_redeem", "deposit", "withdraw", "borrow", "repay", "swap", "farm_deposit", "farm_redeem"];
const READ_KINDS = ["health", "positions", "debt", "collateral", "wallet", "price", "pool", "earn_position", "farm_markets", "farm_positions", "capacity", "liquidation_risk", "history", "protocol", "quote", "concept", "help"];

const stepProps = {
  op: { type: "STRING", enum: WRITE_OPS, description: "earn_supply/earn_redeem = Vanna Earn pool. deposit/withdraw = margin collateral. borrow/repay = margin debt. swap = Jupiter. farm_deposit/farm_redeem = Kamino." },
  asset: { type: "STRING", enum: ASSET_ENUM, description: "The asset acted on (for swap: the asset sold; for farm_redeem: the underlying, not the receipt)." },
  to_asset: { type: "STRING", enum: ASSET_ENUM, description: "swap only: the asset bought." },
  amount: { type: "STRING", description: 'A positive decimal number as text ("1.5"), or "all", or a percentage like "50%". Omit if the user gave none.' },
  source: { type: "STRING", enum: ["wallet", "margin"], description: "repay: which balance pays. swap: margin = swap collateral inside the margin account; default wallet." },
  leverage: { type: "NUMBER", description: 'borrow only. Set this INSTEAD of amount when the user asks to borrow "to reach Nx leverage" / "Nx against that deposit" without giving a borrow amount. N is the multiple of equity (3 = collateral three times equity). The server sizes the amount; never compute it.' },
};

export const ROUTER_TOOLS: LlmFunctionDecl[] = [
  {
    name: "read_question",
    description: "The user asks for information: positions, health factor, prices, pool rates, balances, history, quotes, how much they can borrow/withdraw, or an explanation.",
    parameters: {
      type: "OBJECT",
      properties: {
        kind: { type: "STRING", enum: READ_KINDS },
        assets: { type: "ARRAY", items: { type: "STRING", enum: ASSET_ENUM }, description: "Assets the question names (price, pool, earn_position)." },
        what: { type: "STRING", enum: ["borrow", "withdraw"], description: "capacity only." },
        asset: { type: "STRING", enum: ASSET_ENUM, description: "capacity only, optional." },
        from: { type: "STRING", enum: ASSET_ENUM, description: "quote only." },
        to: { type: "STRING", enum: ASSET_ENUM, description: "quote only." },
        amount: { type: "STRING", description: "quote only: positive decimal." },
        topic: { type: "STRING", enum: ["health_factor", "liquidation", "leverage", "collateral", "earn", "farm", "margin", "general"], description: "concept only." },
      },
      required: ["kind"],
    },
  },
  {
    name: "write_action",
    description: "The user wants ONE on-chain action prepared for their wallet to sign.",
    parameters: { type: "OBJECT", properties: stepProps, required: ["op"] },
  },
  {
    name: "action_chain",
    description: "The user wants several actions in order (\"deposit 2 SOL then borrow 100 USDC\"). Include a final {report:true} step if they also ask for their health factor afterwards.",
    parameters: {
      type: "OBJECT",
      properties: {
        steps: {
          type: "ARRAY",
          items: { type: "OBJECT", properties: { ...stepProps, report: { type: "BOOLEAN", description: "true = report the health factor (no op needed)." } } },
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "lever_position",
    description: 'Leverage a long position: "lever my SOL 2x". Borrows a stable, swaps it into the asset inside the margin account.',
    parameters: {
      type: "OBJECT",
      properties: {
        asset: { type: "STRING", enum: ASSET_ENUM },
        leverage: { type: "NUMBER", description: "Multiple of equity, e.g. 2." },
        borrow_asset: { type: "STRING", enum: ["USDC", "USDT"], description: "Only if the user named it." },
        amount: { type: "STRING", description: "Units of the asset to lever, only if the user gave a number." },
        min_hf: { type: "NUMBER", description: "Only if the user gave a health-factor floor." },
      },
      required: ["asset", "leverage"],
    },
  },
  {
    name: "ask_user",
    description: "The request is an on-topic action or question but a required detail is missing or ambiguous. Ask ONE short question.",
    parameters: { type: "OBJECT", properties: { question: { type: "STRING" } }, required: ["question"] },
  },
  {
    name: "decline",
    description: "The request is outside the product (other tokens, unsupported strategies, anything else).",
    parameters: { type: "OBJECT", properties: { reason: { type: "STRING" } }, required: ["reason"] },
  },
];

export const ROUTER_SYSTEM = `You route messages for the Vanna Finance Copilot on Solana by calling exactly one function. You never answer in text.
${DOMAIN_FIREWALL_SYSTEM}

Product: Vanna Earn pools (SOL, USDC, USDT), a margin account (collateral, borrow, repay), Jupiter swaps, Kamino farm, health factor.
- "supply", "lend", "put into earn" = earn_supply. "redeem", "withdraw from earn" = earn_redeem.
- "deposit ... as collateral", "add collateral" = deposit. "withdraw collateral" = withdraw.
- A bare "deposit" or "withdraw" with no venue is ambiguous: call ask_user.
- Amounts: copy the number the user typed. Never compute, convert or guess an amount. "all"/"max" = "all".
- If the user did not give an amount, omit it (the server will ask).
- Understand the intent, not the wording. Several assets or actions in one sentence ("deposit 100 USDC, 100 USDT and 1 SOL in the lending pool", "supply 5 SOL and 10 USDC") are SEPARATE steps of one action_chain, each repeating the shared venue (lending pool / earn = earn_supply; margin / collateral = deposit) with its own typed amount.
- "Deposit X in margin and borrow Y Nx against it" (a leverage target on a borrow, no borrow amount given) = an action_chain: a deposit step, then a borrow step of Y with leverage N and no amount. If the user instead levers one asset by borrowing a stable ("lever my SOL 3x", "deposit 1 SOL and borrow USDC with 3x") use lever_position.
- A leverage multiple ("3x") is never an amount; do not copy it into amount.
- Use the conversation history to resolve "it", "that", "the same", but still take amounts only from numbers the user typed.
- Only the assets in the enums exist. For any other token call decline.`;

function amountSpecOf(v: unknown): AmountSpec | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const s = parseDecimalString(String(v));
    return s ? { kind: "exact", value: s } : null;
  }
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (!t) return null;
  if (t === "all" || t === "max" || t === "maximum") return { kind: "all" };
  const pct = t.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) {
    const p = Number(pct[1]);
    return p >= 100 ? { kind: "all" } : { kind: "pct", pct: p };
  }
  const s = parseDecimalString(t);
  return s ? { kind: "exact", value: s } : null;
}

const assetOf = (v: unknown) => (typeof v === "string" ? normalizeAsset(v) : null);

/** A step the model named with an asset that is not in the product is refused, never mapped to another asset. */
function namedUnknownAsset(a: Record<string, unknown>): string | null {
  for (const k of ["asset", "to_asset"]) {
    const v = a[k];
    if (typeof v === "string" && v.trim() && !normalizeAsset(v)) return v.trim();
  }
  return null;
}

/** "Which asset?" / "How much?" from a guard is a question for the user, not a refusal. */
function guardOutcome(message: string): Intent {
  return /^(?:Which|How much)\b/.test(message) ? { lane: "ask", question: message } : { lane: "refuse", reason: "guard", message };
}

function writeFromArgs(a: Record<string, unknown>): WriteIntent | null {
  const op = a.op;
  if (typeof op !== "string" || !(WRITE_OPS as string[]).includes(op)) return null;
  const lev = typeof a.leverage === "number" ? a.leverage : typeof a.leverage === "string" ? Number(a.leverage) : null;
  const sizedToLeverage = op === "borrow" && lev !== null && Number.isFinite(lev) && !amountSpecOf(a.amount);
  return {
    op: op as WriteOp,
    asset: assetOf(a.asset),
    to_asset: assetOf(a.to_asset),
    amount: sizedToLeverage ? { kind: "lev", multiple: lev as number } : amountSpecOf(a.amount),
    source: a.source === "margin" ? "margin" : a.source === "wallet" ? "wallet" : null,
  };
}

/** Function call -> guarded Intent. Anything malformed is `unknown`, never a guess. */
export function intentFromCall(name: string, a: Record<string, unknown>): Intent {
  try {
    if (name === "read_question") {
      const kind = a.kind;
      if (typeof kind !== "string" || !READ_KINDS.includes(kind)) return { lane: "unknown" };
      const assets = Array.isArray(a.assets) ? a.assets.map(assetOf).filter((x): x is NonNullable<typeof x> => !!x) : [];
      let read: ReadIntent;
      switch (kind) {
        case "price":
        case "pool":
        case "earn_position":
          read = { kind, assets };
          break;
        case "capacity":
          read = { kind: "capacity", what: a.what === "withdraw" ? "withdraw" : "borrow", asset: assetOf(a.asset) };
          break;
        case "quote": {
          const from = assetOf(a.from);
          const to = assetOf(a.to);
          const amount = typeof a.amount === "string" ? parseDecimalString(a.amount) : typeof a.amount === "number" ? parseDecimalString(String(a.amount)) : null;
          if (!from || !to || !amount) return { lane: "ask", question: "Which assets and how much would you like a swap quote for?" };
          read = { kind: "quote", from, to, amount };
          break;
        }
        case "concept":
          read = { kind: "concept", topic: (["health_factor", "liquidation", "leverage", "collateral", "earn", "farm", "margin", "general"].includes(String(a.topic)) ? a.topic : "general") as never };
          break;
        default:
          read = { kind } as ReadIntent;
      }
      const v = validateRead(read);
      return v.ok ? { lane: "read", read: v.value } : { lane: "refuse", reason: "guard", message: v.message };
    }
    if (name === "write_action") {
      const bad = namedUnknownAsset(a);
      if (bad) return { lane: "refuse", reason: "guard", message: unofferedMessage(bad) };
      const w = writeFromArgs(a);
      if (!w) return { lane: "unknown" };
      const v = validateWrite(w);
      return v.ok ? { lane: "write", write: v.value } : guardOutcome(v.message);
    }
    if (name === "action_chain") {
      const raw = Array.isArray(a.steps) ? a.steps : [];
      const steps: Array<{ write: WriteIntent } | { report: true }> = [];
      for (const r of raw.slice(0, 8)) {
        if (!r || typeof r !== "object") return { lane: "unknown" };
        const o = r as Record<string, unknown>;
        if (o.report === true && !o.op) {
          steps.push({ report: true });
          continue;
        }
        const badStep = namedUnknownAsset(o);
        if (badStep) return { lane: "refuse", reason: "guard", message: unofferedMessage(badStep) };
        const w = writeFromArgs(o);
        if (!w) return { lane: "unknown" };
        const v = validateWrite(w);
        if (!v.ok) return guardOutcome(v.message);
        steps.push({ write: v.value });
      }
      return steps.length ? { lane: "chain", steps } : { lane: "unknown" };
    }
    if (name === "lever_position") {
      const asset = assetOf(a.asset);
      const leverage = typeof a.leverage === "number" ? a.leverage : Number(a.leverage);
      if (!asset || !Number.isFinite(leverage)) return { lane: "unknown" };
      const amount = typeof a.amount === "string" ? parseDecimalString(a.amount) : typeof a.amount === "number" ? parseDecimalString(String(a.amount)) : null;
      const minHf = typeof a.min_hf === "number" && a.min_hf > 1 ? a.min_hf : null;
      const borrow = a.borrow_asset === "USDC" || a.borrow_asset === "USDT" ? a.borrow_asset : null;
      const v = validateLever({ asset, leverage, borrow_asset: borrow, amount, min_hf: minHf });
      return v.ok ? { lane: "lever", lever: v.value } : { lane: "refuse", reason: "guard", message: v.message };
    }
    if (name === "ask_user") {
      const q = typeof a.question === "string" ? a.question.trim().slice(0, 240) : "";
      return q ? { lane: "ask", question: q } : { lane: "unknown" };
    }
    if (name === "decline") {
      return { lane: "refuse", reason: "model_decline", message: "I can only help with SOL, USDC, USDT, JitoSOL and JupSOL on Vanna: Earn, margin, swaps and Kamino farm." };
    }
  } catch {
    /* fall through */
  }
  return { lane: "unknown" };
}

export async function routeWithModel(
  message: string,
  history: Array<{ role: "user" | "assistant"; text: string }>,
  signal?: AbortSignal,
): Promise<{ intent: Intent; tokens: number }> {
  const res = await getLlm().generate({ system: ROUTER_SYSTEM, user: message, history, tools: ROUTER_TOOLS, forceTool: true, maxOutputTokens: 400, signal });
  const call = res.calls[0];
  return { intent: call ? intentFromCall(call.name, call.args) : { lane: "unknown" }, tokens: res.tokens };
}

// ── Wording an answer from facts ────────────────────────────────────────────

const WORDING_SCHEMA = {
  type: "OBJECT",
  properties: {
    headline: { type: "STRING", description: "One plain sentence answering the question, leading with the figure asked for." },
    note: { type: "STRING", description: "At most two sentences of context. Omit if the headline is enough." },
  },
  required: ["headline"],
  propertyOrdering: ["headline", "note"],
} as const;

const WORDING_SYSTEM = `You phrase answers for a Vanna Finance (Solana) user from DATA and FIGURES only.
${DOMAIN_FIREWALL_SYSTEM}
Rules:
- Use ONLY numbers that appear in DATA or FIGURES, written the way FIGURES writes them. Never compute, round differently, estimate or add a number.
- Never promise anything, never say a transaction happened, never give advice about price direction.
- Plain text only: no markdown, bullets or asterisks.
- If FIGURES says something is unavailable, say so and give no figure.`;

const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;

function numbersOf(text: string): Array<{ v: number; dp: number }> {
  const out: Array<{ v: number; dp: number }> = [];
  for (const m of text.matchAll(NUM_RE)) {
    const raw = m[0].replace(/,/g, "");
    const v = Number(raw);
    if (Number.isFinite(v)) out.push({ v, dp: raw.includes(".") ? raw.split(".")[1].length : 0 });
  }
  return out;
}

/** True when every number in `text` can be traced to `sources` (at the precision it is written). */
export function numbersGrounded(text: string, sources: string[]): boolean {
  const allowed: number[] = [1.1, copilotConfig.minHealthFactor];
  for (const s of sources) for (const n of numbersOf(s)) allowed.push(n.v, n.v * 100, n.v / 100);
  for (const n of numbersOf(text)) {
    if (Number.isInteger(n.v) && n.v >= 0 && n.v <= 24) continue; // counts such as "3 assets"
    const tol = 0.5 * 10 ** -n.dp + 1e-9;
    if (!allowed.some((a) => Math.abs(a - n.v) <= tol || Math.abs(a - n.v) <= Math.abs(n.v) * 1e-6)) return false;
  }
  return true;
}

function figuresText(a: StructuredAnswer): string {
  const lines = [a.headline, ...a.facts.map((f) => `${f.label}: ${f.value}`)];
  for (const t of [...(a.tables ?? []), ...(a.table ? [a.table] : [])]) for (const r of t.rows) lines.push(r.join(" | "));
  if (a.note) lines.push(a.note);
  return lines.join("\n");
}

/**
 * Re-word headline/note. Returns the ORIGINAL answer, unchanged, if the model is unavailable, errors,
 * or writes any number that is not in the data. `tokens` is what was spent (0 when skipped).
 */
export async function wordAnswer(args: {
  question: string;
  answer: StructuredAnswer;
  data: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{ answer: StructuredAnswer; tokens: number; used: boolean }> {
  const { answer } = args;
  if (!llmConfigured()) return { answer, tokens: 0, used: false };
  const figures = figuresText(answer);
  const dataText = JSON.stringify(args.data).slice(0, 12_000);
  try {
    const res = await getLlm().generate({
      system: WORDING_SYSTEM,
      user: `QUESTION: ${args.question.slice(0, 400)}\n\nDATA (json):\n${dataText}\n\nFIGURES:\n${figures}`,
      responseSchema: WORDING_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 300,
      signal: args.signal,
    });
    const parsed = res.text ? (JSON.parse(res.text) as { headline?: unknown; note?: unknown }) : null;
    const headline = typeof parsed?.headline === "string" ? parsed.headline.trim() : "";
    const note = typeof parsed?.note === "string" ? parsed.note.trim() : "";
    if (!headline || /[*_`#]|^\s*[-•]/m.test(headline + note)) return { answer, tokens: res.tokens, used: false };
    if (!numbersGrounded(`${headline} ${note}`, [dataText, figures])) return { answer, tokens: res.tokens, used: false };
    return { answer: { ...answer, headline, ...(answer.note ? { note: answer.note } : note ? { note } : {}) }, tokens: res.tokens, used: true };
  } catch {
    return { answer, tokens: 0, used: false };
  }
}
