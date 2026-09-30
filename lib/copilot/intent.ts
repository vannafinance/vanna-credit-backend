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
  | { kind: "pct"; pct: number };

const MAX_AMOUNT = 1e12;

/** "1,000.50" / "2k" / ".5" -> "1000.5" / "2000" / "0.5"; null when not a usable positive amount. */
export function parseDecimalString(raw: string): string | null {
  let s = raw.trim().toLowerCase().replace(/,/g, "");
  let mult = 1;
  if (s.endsWith("k")) {
    mult = 1000;
    s = s.slice(0, -1);
  }
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(s)) return null;
  const n = Number(s) * mult;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return null;
  if (mult === 1) {
    const [i, f = ""] = s.split(".");
    if (f.length > 12) return null;
    const out = `${i.replace(/^0+(?=\d)/, "") || "0"}${f.replace(/0+$/, "") ? "." + f.replace(/0+$/, "") : ""}`;
    return out;
  }
  return String(n);
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
    if (w.amount.kind === "exact" && parseDecimalString(w.amount.value) === null) return fail("That amount is not valid.");
    if (w.amount.kind === "pct" && !(w.amount.pct > 0 && w.amount.pct <= 100)) return fail("Percentages must be between 0 and 100.");
  }
  return { ok: true, value: w };
}

export function validateLever(l: LeverIntent): GuardResult<LeverIntent> {
  if (!(PRODUCT_ASSETS as readonly string[]).includes(l.asset)) return fail(unofferedMessage(l.asset));
  if (!Number.isFinite(l.leverage) || l.leverage <= 1) return fail("Leverage has to be above 1x.");
  if (l.leverage > 10) return fail("I won't size above 10x; at this protocol's health rules it could never hold the 1.15 floor.");
  if (l.borrow_asset && l.borrow_asset !== "USDC" && l.borrow_asset !== "USDT") return fail("I fund leverage by borrowing USDC or USDT.");
  if (l.borrow_asset && l.borrow_asset === (l.asset as string)) return fail("Borrowing the same asset you are levering adds no exposure.");
  if (l.amount !== null && parseDecimalString(l.amount) === null) return fail("That amount is not valid.");
  return { ok: true, value: l };
}

export function validateRead(r: ReadIntent): GuardResult<ReadIntent> {
  const list = "assets" in r ? r.assets : [];
  for (const a of list) if (!(PRODUCT_ASSETS as readonly string[]).includes(a)) return fail(unofferedMessage(a));
  if (r.kind === "quote") {
    if (r.from === r.to) return fail("Pick two different assets to quote.");
    if (parseDecimalString(r.amount) === null) return fail("That amount is not valid.");
  }
  if (r.kind === "capacity" && r.asset) {
    if (r.what === "borrow" && !isLendBorrow(r.asset)) return fail(unofferedMessage(r.asset));
  }
  return { ok: true, value: r };
}

// ── Text parsing helpers (used by the keyword router) ───────────────────────

const AMOUNT_RE = /(\d[\d,]*(?:\.\d+)?k?|\.\d+)/i;

export interface ParsedClause {
  assets: Asset[];
  /** Words that looked like a token but are not in the product (for a precise refusal). */
  unknownTokens: string[];
  receipts: Asset[];
  amount: AmountSpec | null;
  /** The first number that is NOT a leverage multiple. */
  leverage: number | null;
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
  const t = text.toLowerCase();
  const pct = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    const p = Number(pct[1]);
    if (Number.isFinite(p)) return p >= 100 ? { kind: "all" } : { kind: "pct", pct: p };
  }
  if (/\bhalf\b/.test(t)) return { kind: "pct", pct: 50 };
  if (/\b(all|everything|entire|max|maximum|whole)\b/.test(t)) return { kind: "all" };
  // A leverage multiple ("2x") is not an amount.
  const stripped = t.replace(/\b\d+(?:\.\d+)?\s*(?:x|×)\b/g, " ").replace(/\b(?:x|×)\s*\d+(?:\.\d+)?\b/g, " ");
  const m = stripped.match(AMOUNT_RE);
  if (!m) return null;
  const value = parseDecimalString(m[1]);
  return value ? { kind: "exact", value } : null;
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
  const parts = text
    .split(/\s*(?:;|,?\s+and\s+then\s+|,?\s+then\s+|,?\s+after\s+that\s+|,?\s+afterwards\s+)\s*/i)
    .flatMap((p) => p.split(new RegExp(`\\s+and\\s+(?=(?:${verbs})\\b)`, "i")))
    .flatMap((p) => p.split(new RegExp(`,\\s*(?=(?:${verbs})\\b)`, "i")))
    .map((p) => p.trim())
    .filter(Boolean);
  return parts;
}

export function parseClauseFacts(text: string): ParsedClause {
  const { assets, unknown, receipts } = extractAssets(text);
  const extra = tokenAfterAmount(text);
  return {
    assets,
    unknownTokens: extra && !unknown.includes(extra) ? [...unknown, extra] : unknown,
    receipts,
    amount: parseAmount(text),
    leverage: parseLeverage(text),
  };
}
