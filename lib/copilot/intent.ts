/**
 * Intents: what a user sentence means, as typed data.
 *
 * Both routers (keyword and Gemini function-calling) produce these, and BOTH pass through the same
 * `validate*` guards, so the model never gets to introduce an asset, an op or a number the product
 * does not support. Amounts stay decimal strings end to end; nothing here touches a float that
 * reaches the chain.
 */

// ── Product assets ───────────────────────────────────────────────────────────

/** Lend + borrow + collateral. */
export const LEND_BORROW_ASSETS = ["SOL", "USDC", "USDT"] as const;
/** Collateral, swap and Kamino farm only (no Vanna lending pool). */
export const COLLATERAL_ONLY_ASSETS = ["JitoSOL", "JupSOL"] as const;
export const PRODUCT_ASSETS = [...LEND_BORROW_ASSETS, ...COLLATERAL_ONLY_ASSETS] as const;
export type Asset = (typeof PRODUCT_ASSETS)[number];

/** Kamino receipt -> underlying. Receipts are produced by farming; users redeem them, never buy them. */
export const RECEIPT_TO_UNDERLYING: Record<string, Asset> = {
  ksol: "SOL",
  kusdc: "USDC",
  kusdt: "USDT",
  kjitosol: "JitoSOL",
  kjupsol: "JupSOL",
};

const ASSET_ALIASES: Record<string, Asset> = {
  sol: "SOL",
  wsol: "SOL",
  usdc: "USDC",
  usdt: "USDT",
  jitosol: "JitoSOL",
  jupsol: "JupSOL",
};

/** Assets the program may register but the product deliberately does not offer. Named so the refusal can say so. */
const KNOWN_UNOFFERED = new Set([
  "jupusd", "nvdax", "tslax", "googlx", "aaplx", "spyx", "anthropic", "openai", "xstocks", "prestocks",
  "bonk", "wif", "eth", "btc", "weth", "wbtc", "usde", "dai", "pyusd", "msol", "bsol",
]);

/** Words that can follow an amount without being an asset ("100 worth of", "5 to"). */
const AMOUNT_FILLER = new Set([
  "of", "worth", "to", "from", "in", "into", "as", "at", "on", "then", "and", "usd", "dollars", "dollar", "bucks", "for",
  "with", "x", "times", "my", "the", "a", "more", "less", "out", "back", "each", "per", "units", "tokens", "token",
]);

export function normalizeAsset(word: string): Asset | null {
  return ASSET_ALIASES[word.trim().toLowerCase()] ?? null;
}

export function isLendBorrow(a: string): boolean {
  return (LEND_BORROW_ASSETS as readonly string[]).includes(a);
}

export function receiptUnderlying(word: string): Asset | null {
  return RECEIPT_TO_UNDERLYING[word.trim().toLowerCase()] ?? null;
}

// ── Amounts ──────────────────────────────────────────────────────────────────

export type AmountSpec =
  | { kind: "exact"; value: string }
  | { kind: "all" }
  | { kind: "pct"; pct: number }
  /** swap only: receive at least this much of `to_asset`; the input is sized from live quotes. */
  | { kind: "out"; value: string };

const MAX_AMOUNT = 1e12;
/** More fractional digits than any token the product handles (SOL and the SOL LSTs have 9; the stables 6). */
const MAX_FRACTION_DIGITS = 12;

/** Why a typed amount could not be used. `invalid`: refuse; `ambiguous`: ask, because more than one reading is plausible. */
export interface AmountIssue {
  kind: "invalid" | "ambiguous";
  message: string;
}

/** Decimals of the on-chain token (program registry: SOL/JitoSOL/JupSOL 9, USDC/USDT 6). */
export function assetDecimals(symbol: string): number {
  return symbol === "USDC" || symbol === "USDT" ? 6 : 9;
}

/** Exact decimal string for (intPart.fracPart) x 10^exp, no float involved. */
function shiftDecimal(intPart: string, fracPart: string, exp: number): string {
  const all = intPart + fracPart;
  const digits = all.replace(/^0+/, "");
  if (digits === "") return "0";
  const lead = all.length - digits.length;
  const point = intPart.length + exp - lead;
  let out: string;
  if (point <= 0) out = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = digits.slice(0, point) + "." + digits.slice(point);
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return out;
}

/**
 * One typed number -> an exact positive decimal string, or the reason it cannot be used. Never
 * guesses: a lone comma ("1,5"), European grouping ("1.000,5"), a sign, zero, NaN/Infinity, a size
 * beyond the product's ceiling or more precision than any token has are all reported, not reinterpreted.
 * Scientific notation ("1e-3") is read exactly, in text only (`allowExponent`).
 */
export function parseAmountToken(raw: string, opts: { allowExponent?: boolean } = {}): { ok: true; value: string } | { ok: false; issue: AmountIssue } {
  const bad = (message: string, kind: AmountIssue["kind"] = "invalid"): { ok: false; issue: AmountIssue } => ({ ok: false, issue: { kind, message } });
  const shown = raw.trim();
  let t = shown.toLowerCase();
  if (/^[-−–]/.test(t)) return bad(`Amounts have to be positive. I won't read "${shown}" as a positive number; tell me the amount without the minus sign if that is what you mean.`);
  t = t.replace(/^\+/, "");
  if (/^(?:nan|\w*infinity|inf)$/.test(t)) return bad(`"${shown}" is not a number, so I can't use it as an amount.`);
  let exp = 0;
  if (t.endsWith("k")) {
    exp += 3;
    t = t.slice(0, -1);
  }
  const sci = t.match(/^([\d.,]+)e([-+]?\d+)$/);
  if (sci) {
    if (!opts.allowExponent) return bad(`"${shown}" uses scientific notation. Write the amount as a plain decimal.`);
    const e = Number(sci[2]);
    if (!Number.isFinite(e) || Math.abs(e) > 40) return bad(`"${shown}" is far outside any amount this product handles, so I won't use it.`);
    exp += e;
    t = sci[1];
  }
  let mantissa: string;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) mantissa = t.replace(/,/g, "");
  else if (/^(\d+(\.\d+)?|\.\d+)$/.test(t)) mantissa = t;
  else if (/[.,]/.test(t) && /^[\d.,]+$/.test(t)) {
    return bad(`I can't tell how to read "${shown}": the comma and dot could mean thousands or decimals depending on region. Write it plainly, like 1000.5.`, "ambiguous");
  } else return bad(`"${shown}" is not a valid amount.`);
  const [i, f = ""] = mantissa.split(".");
  const value = shiftDecimal(i, f, exp);
  if (value === "0") return bad(`The amount has to be above zero ("${shown}" is zero).`);
  if (!(Number(value) <= MAX_AMOUNT)) return bad(`"${shown}" is larger than any amount I will prepare. Use a realistic amount.`);
  const frac = value.split(".")[1] ?? "";
  if (frac.length > MAX_FRACTION_DIGITS) return bad(`"${shown}" has more decimal places than any token supports.`);
  return { ok: true, value };
}

/** "1,000.50" / "2k" / ".5" -> "1000.5" / "2000" / "0.5"; null when not a usable positive amount. */
export function parseDecimalString(raw: string): string | null {
  const r = parseAmountToken(raw);
  return r.ok ? r.value : null;
}

// ── Intent types ─────────────────────────────────────────────────────────────

export type WriteOp =
  | "create_account"
  | "close_account"
  | "earn_supply"
  | "earn_redeem"
  | "deposit"
  | "withdraw"
  | "borrow"
  | "repay"
  | "swap"
  | "farm_deposit"
  | "farm_redeem";

export interface WriteIntent {
  op: WriteOp;
  asset: Asset | null;
  /** swap: the asset bought. */
  to_asset?: Asset | null;
  amount: AmountSpec | null;
  /** repay: which balance pays. swap: wallet swap vs swap of margin collateral. */
  source?: "wallet" | "margin" | null;
}

export type ReadIntent =
  | { kind: "health" }
  | { kind: "positions" }
  | { kind: "debt" }
  | { kind: "collateral" }
  | { kind: "wallet" }
  | { kind: "price"; assets: Asset[] }
  | { kind: "pool"; assets: Asset[] }
  | { kind: "earn_position"; assets: Asset[] }
  | { kind: "farm_markets" }
  | { kind: "farm_positions" }
  | { kind: "capacity"; what: "borrow" | "withdraw"; asset: Asset | null }
  /** "can I borrow 500 USDC?", "what will my HF be if I withdraw 1 SOL?", "how much to repay to reach HF 2?" - answered from MCP data, never a write. */
  | { kind: "whatif"; op: "borrow" | "withdraw" | "repay"; asset: Asset | null; amount: string | null; target_hf: number | null }
  | { kind: "liquidation_risk" }
  | { kind: "history" }
  | { kind: "protocol" }
  | { kind: "quote"; from: Asset; to: Asset; amount: string }
  | { kind: "concept"; topic: ConceptTopic }
  | { kind: "help" };

export type ConceptTopic = "health_factor" | "liquidation" | "leverage" | "collateral" | "earn" | "farm" | "margin" | "general";

export interface LeverIntent {
  asset: Asset;
  leverage: number;
  /** Stable asset borrowed to fund the extra exposure; null = ask. */
  borrow_asset: "USDC" | "USDT" | null;
  /** Units of `asset` the user wants to lever; null = their existing margin balance of it. */
  amount: string | null;
  min_hf?: number | null;
}

/** "Close everything": exit positions in a safe order. `scope` narrows it to one venue. */
export interface UnwindIntent {
  scope: "all" | "margin" | "earn" | "farm";
  /** Also close the (then empty) margin account. Only when the user names the account. */
  close_account: boolean;
}

/** A pick the user can make; `apply` is the fully specified intent the server runs when they do. */
export interface AskOption {
  label: string;
  description?: string;
  apply: Intent;
}

export type Intent =
  | { lane: "read"; read: ReadIntent }
  | { lane: "write"; write: WriteIntent }
  | { lane: "chain"; steps: Array<{ write: WriteIntent } | { report: true }> }
  | { lane: "lever"; lever: LeverIntent }
  | { lane: "unwind"; unwind: UnwindIntent }
  | { lane: "ask"; question: string; options?: AskOption[] }
  | { lane: "refuse"; reason: string; message: string }
  | { lane: "unknown" };

// ── Guards (apply to EVERY intent, whichever router produced it) ────────────

export type GuardResult<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

const OP_ASSETS: Record<WriteOp, "none" | "lend" | "any"> = {
  create_account: "none",
  close_account: "none",
  earn_supply: "lend",
  earn_redeem: "lend",
  deposit: "any",
  withdraw: "any",
  borrow: "lend",
  repay: "lend",
  swap: "any",
  farm_deposit: "any",
  farm_redeem: "any",
};

export function unofferedMessage(asset: string): string {
  return `${asset} is not part of the Vanna Copilot product. I work with SOL, USDC and USDT (lend and borrow), plus JitoSOL and JupSOL (collateral, swap and Kamino farm).`;
}

/** Null when `amount` fits the token's decimals; otherwise the refusal. Rounding a user's amount would silently change it. */
export function decimalsProblem(amount: string, asset: string | null): string | null {
  if (!asset) return null;
  const dp = assetDecimals(asset);
  const frac = amount.split(".")[1] ?? "";
  if (frac.length > dp) return `${asset} has ${dp} decimal places, and ${amount} has ${frac.length}. I won't round your amount; give it with at most ${dp} decimals.`;
  return null;
}

export function validateWrite(w: WriteIntent): GuardResult<WriteIntent> {
  const rule = OP_ASSETS[w.op];
  if (rule === undefined) return fail("That action is not supported.");
  if (rule !== "none") {
    if (!w.asset) return fail("Which asset?");
    if (!(PRODUCT_ASSETS as readonly string[]).includes(w.asset)) return fail(unofferedMessage(String(w.asset)));
    if (rule === "lend" && !isLendBorrow(w.asset)) {
      return fail(
        `${w.asset} can be used as collateral, swapped, or farmed on Kamino, but it has no Vanna lending pool, so it cannot be lent or borrowed.`,
      );
    }
  }
  if (w.op === "swap") {
    if (!w.to_asset) return fail("Which asset do you want to swap into?");
    if (!(PRODUCT_ASSETS as readonly string[]).includes(w.to_asset)) return fail(unofferedMessage(String(w.to_asset)));
    if (w.to_asset === w.asset) return fail("Pick two different assets to swap.");
  }
  if (w.amount) {
    if (w.amount.kind === "exact") {
      if (parseDecimalString(w.amount.value) === null) return fail("That amount is not valid.");
      const tooFine = decimalsProblem(w.amount.value, w.asset);
      if (tooFine) return fail(tooFine);
    }
    if (w.amount.kind === "pct" && !(w.amount.pct > 0 && w.amount.pct <= 100)) return fail("Percentages must be between 0 and 100.");
    if (w.amount.kind === "out") {
      if (w.op !== "swap") return fail("Only a swap can be sized by the amount you want to receive.");
      if (parseDecimalString(w.amount.value) === null) return fail("That amount is not valid.");
      const tooFine = decimalsProblem(w.amount.value, w.to_asset ?? null);
      if (tooFine) return fail(tooFine);
    }
  }
  return { ok: true, value: w };
}

export function validateLever(l: LeverIntent): GuardResult<LeverIntent> {
  if (!(PRODUCT_ASSETS as readonly string[]).includes(l.asset)) return fail(unofferedMessage(l.asset));
  if (!Number.isFinite(l.leverage) || l.leverage <= 1) return fail("Leverage has to be above 1x.");
  if (l.leverage > 10) return fail("I won't size above 10x; at this protocol's health rules it could never hold the 1.15 floor.");
  if (l.borrow_asset && l.borrow_asset !== "USDC" && l.borrow_asset !== "USDT") return fail("I fund leverage by borrowing USDC or USDT.");
  if (l.borrow_asset && l.borrow_asset === (l.asset as string)) return fail("Borrowing the same asset you are levering adds no exposure.");
  if (l.amount !== null) {
    if (parseDecimalString(l.amount) === null) return fail("That amount is not valid.");
    const tooFine = decimalsProblem(l.amount, l.asset);
    if (tooFine) return fail(tooFine);
  }
  return { ok: true, value: l };
}

export function validateRead(r: ReadIntent): GuardResult<ReadIntent> {
  const list = "assets" in r ? r.assets : [];
  for (const a of list) if (!(PRODUCT_ASSETS as readonly string[]).includes(a)) return fail(unofferedMessage(a));
  if (r.kind === "quote") {
    if (r.from === r.to) return fail("Pick two different assets to quote.");
    if (parseDecimalString(r.amount) === null) return fail("That amount is not valid.");
    const tooFine = decimalsProblem(r.amount, r.from);
    if (tooFine) return fail(tooFine);
  }
  if (r.kind === "whatif") {
    if (!r.asset) return fail("Which asset do you mean?");
    if (r.op === "borrow" && !isLendBorrow(r.asset)) return fail(unofferedMessage(r.asset));
    if (r.amount !== null) {
      if (parseDecimalString(r.amount) === null) return fail("That amount is not valid.");
      const tooFine = decimalsProblem(r.amount, r.asset);
      if (tooFine) return fail(tooFine);
    }
    if (r.target_hf !== null && !(r.target_hf > 1.1 && r.target_hf <= 100)) return fail("A health factor target has to be above the 1.10 liquidation line.");
    if (r.amount === null && r.target_hf === null) return fail("Give me an amount or a health factor target.");
  }
  if (r.kind === "capacity" && r.asset) {
    if (r.what === "borrow" && !isLendBorrow(r.asset)) return fail(unofferedMessage(r.asset));
  }
  return { ok: true, value: r };
}

// ── Text parsing helpers (used by the keyword router) ───────────────────────

export interface ParsedClause {
  assets: Asset[];
  /** Words that looked like a token but are not in the product (for a precise refusal). */
  unknownTokens: string[];
  receipts: Asset[];
  amount: AmountSpec | null;
  /** The first number that is NOT a leverage multiple. */
  leverage: number | null;
  /** Set when a typed number could not be used as written (negative, zero, NaN, huge, locale, conflicting). */
  amountIssue: AmountIssue | null;
}

/** Every asset word in order of appearance, plus any token-like word that is not one. */
export function extractAssets(text: string): { assets: Asset[]; unknown: string[]; receipts: Asset[] } {
  const assets: Asset[] = [];
  const receipts: Asset[] = [];
  const unknown: string[] = [];
  const re = /\b([a-z][a-z0-9]{1,11})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const w = m[1].toLowerCase();
    const a = ASSET_ALIASES[w];
    if (a) {
      if (!assets.includes(a)) assets.push(a);
      continue;
    }
    const r = RECEIPT_TO_UNDERLYING[w];
    if (r) {
      if (!receipts.includes(r)) receipts.push(r);
      continue;
    }
    if (KNOWN_UNOFFERED.has(w)) unknown.push(m[1]);
  }
  return { assets, receipts, unknown };
}

/**
 * A ticker typed in capitals right after a number that the product does not know: "5 BONK".
 * Lower-case words are not flagged (they are far more often English: "borrow 50 against my sol").
 */
export function tokenAfterAmount(text: string): string | null {
  const re = /(?:\d[\d,]*(?:\.\d+)?k?|\.\d+)\s*([A-Z][A-Za-z0-9]{1,9})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const w = m[1].toLowerCase();
    if (ASSET_ALIASES[w] || RECEIPT_TO_UNDERLYING[w] || AMOUNT_FILLER.has(w)) continue;
    if (m[1] === m[1].toUpperCase()) return m[1];
  }
  return null;
}

export function parseAmount(text: string): AmountSpec | null {
  return scanAmount(text).spec;
}

/** A number as typed: optional sign, NaN/Infinity, digits with separators, optional exponent and k. */
const NUMBER_TOKEN_RE = /(?<![\w.,])([-+−–])?(nan|infinity|\d[\d.,]*(?:e[-+]?\d+)?k?|\.\d+(?:e[-+]?\d+)?k?)(?!\w)/gi;

/** Numbers that are not amounts: leverage multiples, health-factor targets, step numbers. */
function withoutNonAmountNumbers(t: string): string {
  return t
    .replace(/\b\d+(?:\.\d+)?\s*(?:x|×)(?!\w)/g, " ")
    .replace(/\b(?:x|×)\s*\d+(?:\.\d+)?\b/g, " ")
    .replace(/\b(?:hf|health(?:\s*factor)?)\b(?:\s*(?:of|at|above|over|below|under|to|stays?|stay|least|min(?:imum)?|>=|<=|>|<|≥|≤|=))*\s*\d+(?:\.\d+)?/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:hf|health\s*factor)\b/g, " ")
    .replace(/(?:^|[\s,;])\d{1,2}[.)](?=\s)/g, " ")
    .replace(/\bstep\s*\d+\b/g, " ");
}

export interface AmountScan {
  spec: AmountSpec | null;
  issue: AmountIssue | null;
}

/**
 * What amount did the user type? Exact, "all", a percentage, or the reason it cannot be used.
 * A signed, zero, NaN/Infinity, oversized, locale-ambiguous or conflicting number is reported as an
 * issue; it is never turned into a different number.
 */
export function scanAmount(text: string): AmountScan {
  const t = text.toLowerCase();
  const pct = t.match(/([-+−–])?\s*(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    const p = Number(pct[2]);
    if (pct[1] && pct[1] !== "+") return { spec: null, issue: { kind: "invalid", message: `A percentage has to be positive. I won't read "-${pct[2]}%" as ${pct[2]}%.` } };
    if (p === 0) return { spec: null, issue: { kind: "invalid", message: "A percentage has to be above 0." } };
    if (p > 100) return { spec: null, issue: { kind: "invalid", message: `${pct[2]}% is more than all of it. Use a percentage up to 100, or say "all".` } };
    if (Number.isFinite(p)) return { spec: p >= 100 ? { kind: "all" } : { kind: "pct", pct: p }, issue: null };
  }
  if (/\bhalf\b/.test(t)) return { spec: { kind: "pct", pct: 50 }, issue: null };
  if (/\b(all|everything|entire|max|maximum|whole)\b/.test(t)) return { spec: { kind: "all" }, issue: null };
  const stripped = withoutNonAmountNumbers(t);
  const found: Array<{ raw: string; value: string }> = [];
  for (const m of stripped.matchAll(NUMBER_TOKEN_RE)) {
    const body = m[2].replace(/[.,]+$/, "");
    if (!body) continue;
    const at = m.index ?? 0;
    // A sign only counts at the start of a word ("supply -5"), not inside "usdc-5".
    const sign = m[1] && (at === 0 || /[\s(:]/.test(stripped[at - 1])) ? m[1] : "";
    const raw = sign + body;
    const r = parseAmountToken(raw, { allowExponent: true });
    if (!r.ok) return { spec: null, issue: r.issue };
    found.push({ raw, value: r.value });
  }
  if (!found.length) return { spec: null, issue: null };
  const distinct = [...new Set(found.map((f) => f.value))];
  if (distinct.length > 1) {
    return { spec: null, issue: { kind: "ambiguous", message: `I see more than one amount (${found.map((f) => f.raw).join(" and ")}). Which one do you want to use?` } };
  }
  return { spec: { kind: "exact", value: distinct[0] }, issue: null };
}

export function parseLeverage(text: string): number | null {
  const t = text.toLowerCase();
  const m = t.match(/\b(\d+(?:\.\d+)?)\s*(?:x|×|times)\b/) ?? t.match(/\b(?:x|×)\s*(\d+(?:\.\d+)?)\b/) ?? t.match(/\bleverage\s*(?:of|to|at)?\s*(\d+(?:\.\d+)?)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function parseMinHf(text: string): number | null {
  const m = text.toLowerCase().match(/\b(?:hf|health(?:\s*factor)?)\s*(?:>=|≥|above|over|at\s+least|of|stay(?:s|ing)?\s+(?:above|over)|min(?:imum)?)\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 1 && n < 100 ? n : null;
}

/** "then" / "and then" / ";" separate steps; " and <verb>" too. */
export function splitClauses(text: string): string[] {
  const verbs = "deposit|withdraw|borrow|repay|supply|lend|redeem|swap|farm|open|close|create|lever|tell|show|check|report";
  // Numbered or bulleted lists and new lines are steps ("1. deposit ... 2. borrow ..."); a list marker is only
  // a marker when a step verb follows, so "deposit 2. 5 SOL" is left alone.
  const listed = text
    .replace(/\r?\n+/g, ";")
    .replace(new RegExp(`(?:^|\\s)\\(?\\d{1,2}[.)]\\s+(?=(?:${verbs})\\b)`, "gi"), ";")
    .replace(new RegExp(`(?:^|;)\\s*[-*\u2022]\\s+(?=(?:${verbs})\\b)`, "gi"), ";")
    .replace(/^\s*(?:first(?:ly)?|to\s+start)\s*,?\s+/i, "");
  const parts = listed
    .split(/\s*(?:;|,?\s+and\s+then\s+|,?\s+then\s+|,?\s+after\s+that\s+|,?\s+afterwards\s+|,?\s+(?:next|finally|lastly)\s*,?\s+(?=(?:deposit|withdraw|borrow|repay|supply|lend|redeem|swap|farm|open|close|create|lever|tell|show|check|report)\b)|,?\s+followed\s+by\s+|,?\s+and\s+(?:next|finally|lastly)\s*,?\s+(?=(?:deposit|withdraw|borrow|repay|supply|lend|redeem|swap|farm|open|close|create|lever|tell|show|check|report)\b)|,?\s+(?:also|plus)\s*,?\s+(?=(?:deposit|withdraw|borrow|repay|supply|lend|redeem|swap|farm|open|close|create|lever)\b))\s*/i)
    .flatMap((p) => p.split(new RegExp(`\\s+and\\s+(?=(?:${verbs})\\b)`, "i")))
    .flatMap((p) => p.split(new RegExp(`,\\s*(?=(?:${verbs})\\b)`, "i")))
    .map((p) => p.trim().replace(/^[,;.\s]+|[,;\s]+$/g, ""))
    .filter(Boolean);
  return parts;
}

export function parseClauseFacts(text: string): ParsedClause {
  const { assets, unknown, receipts } = extractAssets(text);
  const extra = tokenAfterAmount(text);
  const scan = scanAmount(text);
  return {
    assets,
    unknownTokens: extra && !unknown.includes(extra) ? [...unknown, extra] : unknown,
    receipts,
    amount: scan.spec,
    amountIssue: scan.issue,
    leverage: parseLeverage(text),
  };
}
