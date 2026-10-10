import { isFarmListed, KAMINO_RECEIPTS } from "../solana/kamino";
import { findToken, TOKENS } from "../solana/tokens";
import { copilotConfig } from "./config";
import { LIQUIDATION_HF, LIQUIDATION_HF_TEXT } from "./protocol-constants";

/**
 * Intents: what a user sentence means, as typed data.
 *
 * Both routers (keyword and Gemini function-calling) produce these, and BOTH pass through the same
 * `validate*` guards, so the model never gets to introduce an asset, an op or a number the product
 * does not support. Amounts stay decimal strings end to end; nothing here touches a float that
 * reaches the chain.
 */

// ── Product assets ───────────────────────────────────────────────────────────
// All derived from the app's token registry (`lib/solana/tokens.ts`), the Kamino receipts (`lib/solana/kamino.ts`)
// and the farm listing (`isFarmListed`, also in kamino.ts), so the Copilot offers exactly what the website offers.

/** A product asset's UI symbol (a registry symbol). */
export type Asset = string;

/** Every token the app lists, in registry order. */
export const PRODUCT_ASSETS: readonly Asset[] = TOKENS.map((t) => t.symbol);
/** Lend + borrow + collateral (`lendable` in the registry: has an Earn pool and can be borrowed). */
export const LEND_BORROW_ASSETS: readonly Asset[] = TOKENS.filter((t) => t.lendable).map((t) => t.symbol);
/** Collateral and swap only (no Vanna lending pool). */
export const COLLATERAL_ONLY_ASSETS: readonly Asset[] = TOKENS.filter((t) => !t.lendable).map((t) => t.symbol);
/** Offered as a margin collateral deposit (`depositable`); the rest can still be held, swapped and withdrawn. */
export const DEPOSIT_ASSETS: readonly Asset[] = TOKENS.filter((t) => t.depositable).map((t) => t.symbol);
/** Underlyings with a Kamino farm open to new supply. */
export const FARM_ASSETS: readonly Asset[] = KAMINO_RECEIPTS.map((r) => r.underlying).filter((s) => isFarmListed(s));

/** Kamino receipt -> underlying. Receipts are produced by farming; users redeem them, never buy them. */
export const RECEIPT_TO_UNDERLYING: Record<string, Asset> = Object.fromEntries(
  KAMINO_RECEIPTS.map((r) => [r.symbol.toLowerCase(), r.underlying]),
);

const ASSET_ALIASES: Record<string, Asset> = {
  ...Object.fromEntries(TOKENS.map((t) => [t.symbol.toLowerCase(), t.symbol])),
  wsol: "SOL",
};

/** Well-known tokens outside the product. Named so the refusal can say so. */
const KNOWN_UNOFFERED = new Set(
  ["spyx", "anthropic", "openai", "prestocks", "bonk", "wif", "eth", "btc", "weth", "wbtc", "usde", "dai", "pyusd", "msol", "bsol"].filter(
    (w) => !ASSET_ALIASES[w],
  ),
);

export function isDepositable(a: string): boolean {
  return DEPOSIT_ASSETS.includes(a);
}

/** One line naming the product's assets by role, for refusals and the model's instructions. */
export function assetRoles(): string {
  return `${LEND_BORROW_ASSETS.join(", ")} (lend and borrow), plus ${COLLATERAL_ONLY_ASSETS.join(", ")} (margin collateral and swap)`;
}

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
  | { kind: "out"; value: string }
  /**
   * borrow only: "borrow SOL to reach 3x". The amount is NOT typed by the user or the model; the server sizes it from
   * live prices so that the account's collateral is `multiple` times its equity (see index.ts `levBorrowAmount`).
   */
  | {
      kind: "lev";
      multiple: number;
      /**
       * What the multiple is taken on, when the user named it ("using 0.5 SOL", "against my 10 JitoSOL"): an asset and an
       * amount the user typed. Without it the base is the deposits in the same request, else the account's equity.
       */
      base?: { asset: Asset; value: string };
    }
  /**
   * "swap the borrowed USDC": the exact amount the previous step of the same plan was sized to; with `pct`, that share
   * of it ("swap half of it").
   */
  | { kind: "prev"; pct?: number }
  /** "$100 worth of SOL": a USD value the user typed, converted to units at the oracle price when the plan is drawn. */
  | { kind: "usd"; value: string }
  /**
   * "borrow until my health factor is 1.5", "repay enough to get back to 2": sized when the step is built, from the account
   * as it is then, so the step leaves the health factor at `target` (borrow, withdraw: down to it; repay, deposit: up to it).
   */
  | { kind: "hf"; target: number }
  /**
   * borrow only: "borrow what I can against 5 JupSOL". The largest borrow that the named holding alone supports at the
   * health floor (the borrowed asset stays in the account as collateral), never more than the whole account allows. Sized
   * by the server from live prices (workflow/leverage-borrow.ts `sizeBorrowAgainst`).
   */
  | { kind: "against"; base: { asset: Asset; value: string } };

const MAX_AMOUNT = 1e12;
/** More fractional digits than any token the product handles (SOL and the SOL LSTs have 9; the stables 6). */
const MAX_FRACTION_DIGITS = 12;

/** Why a typed amount could not be used. `invalid`: refuse; `ambiguous`: ask, because more than one reading is plausible. */
export interface AmountIssue {
  kind: "invalid" | "ambiguous";
  message: string;
}

/** Decimals of the token, from the registry (Kamino receipts 6, like the app); 9 when unknown. */
export function assetDecimals(symbol: string): number {
  const token = findToken(symbol);
  if (token) return token.decimals;
  if (RECEIPT_TO_UNDERLYING[symbol.trim().toLowerCase()]) return 6;
  return 9;
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
  | "farm_redeem"
  /** Phoenix perps (the app's Perps page). Leverage is Phoenix's own: none of these borrows from Vanna. */
  | "perp_open"
  | "perp_close"
  | "perp_withdraw"
  /** The first Phoenix trade's extra step (creates the Phoenix trading account); added by the server, never asked for. */
  | "perp_register"
  /**
   * Basis (delta-neutral) and Perena vaults (the app's Farm page): USDC in, vault shares held in the margin account as
   * collateral; a withdrawal pays USDC. SOL Basis takes its deposit from the wallet, then `vault_move_shares` puts the
   * shares into the margin account (added by the server, never asked for).
   */
  | "vault_deposit"
  | "vault_withdraw"
  | "vault_move_shares";

/** The ops a model may name in a plan (the server adds perp_register and vault_move_shares itself). */
export const WRITE_OPS: WriteOp[] = ["create_account", "close_account", "earn_supply", "earn_redeem", "deposit", "withdraw", "borrow", "repay", "swap", "farm_deposit", "farm_redeem", "perp_open", "perp_close", "perp_withdraw", "vault_deposit", "vault_withdraw"];

export const PERP_OPS: ReadonlySet<WriteOp> = new Set<WriteOp>(["perp_open", "perp_close", "perp_withdraw", "perp_register"]);
export const VAULT_OPS: ReadonlySet<WriteOp> = new Set<WriteOp>(["vault_deposit", "vault_withdraw", "vault_move_shares"]);

/** The vaults Vanna lists (the app's VAULTS, `lib/solana/vault-catalogue.ts`). */
export const VAULT_IDS = ["basis-sol", "basis-eth", "basis-btc", "basis-tsla", "basis-meta", "perena-usdstar", "perena-junior"] as const;
export type VaultId = (typeof VAULT_IDS)[number];
export const VAULT_NAMES: Record<VaultId, { name: string; symbol: string }> = {
  "basis-sol": { name: "SOL Basis", symbol: "vbSOL" },
  "basis-eth": { name: "ETH Basis", symbol: "vbETH" },
  "basis-btc": { name: "BTC Basis", symbol: "vbBTC" },
  "basis-tsla": { name: "TSLA Basis", symbol: "vbTSLA" },
  "basis-meta": { name: "META Basis", symbol: "vbMETA" },
  "perena-usdstar": { name: "USD*", symbol: "USD*" },
  "perena-junior": { name: "USD* Junior", symbol: "USD* Junior" },
};

/**
 * Which product a request means. Shared, word for word, by the investigation prompt and the router prompt so Gemini
 * reads "vault", "farm", "earn" and "yield" the same way everywhere. `compare` names the tool that shows all of them.
 */
export function productWordsGuide(compare: string): string {
  return `WHICH PRODUCT: FOUR WAYS TO EARN, AND WHAT THE WORDS MEAN
- Vanna Earn (earn_supply / earn_redeem): lends SOL, USDC or USDT from the WALLET into Vanna's own lending pools and earns the pool's supply APR. It is not margin collateral. Words: "earn", "lend", "supply", "lending pool", "Earn pool", "lend to Vanna".
- Kamino farm (farm_deposit / farm_redeem): lends one token on Kamino Lend from the MARGIN balance and earns Kamino's live supply APY; the receipt (kSOL, kUSDC, ...) stays margin collateral. Words: "farm", "Kamino", "Kamino vault", "Kamino lend", "kSOL". "Kamino vault" means the Kamino farm, never a Basis or Perena vault.
- Perena vaults (vault_deposit / vault_withdraw; perena-usdstar, perena-junior): USDC into Perena's stablecoin yield pool. USD* is the senior share; USD* Junior is the higher-yield tranche that takes losses first and charges a 1% instant-exit fee. Words: "Perena", "USD*", "USD star", "junior", "stable vault", "stablecoin vault".
- Basis vaults (vault_deposit / vault_withdraw; basis-sol, basis-eth, basis-btc, basis-tsla, basis-meta): delta-neutral - the vault holds the asset and shorts the same amount on Phoenix, so the asset's price moves cancel out, and it earns the funding rate. Deposits are USDC (SOL Basis from the wallet). Words: "basis", "delta neutral", "hedged", "funding rate", "vbETH", "ETH basis", "the META vault".
- Phoenix perps are trading, not a yield product.
- "Vault" on its own names no product: ask which, listing the vaults. "Vault" together with Kamino is the Kamino farm.
- A request for yield that names no product ("where should I put my USDC", "best yield", "earn on my SOL", "passive income", "put it to work", "stake my USDC"): do not pick a product for the user and build nothing. Show the comparison (${compare}, with the asset if one is named), then ask which product, one option per product that fits that asset. Earn shows an APR, Kamino a live APY, Perena its own published 7-day APY, and a Basis vault Phoenix's funding rate for its market (what the short is paid, annualised; not the vault's net yield, and it can turn negative); the app's own vault APY replaces these when it has one: from the vault's share-price history, or an approximate estimate from past deposits (always call that one an estimate). They are different measures: say which is which, never rank by a figure you computed or assumed, and never invent an APY.
- "Stake SOL": there is no staking product here. JitoSOL and JupSOL are liquid-staking tokens the user can swap into; Earn and the Kamino farm also take SOL.
- Withdrawals follow the product: "redeem" or "withdraw from Earn" = earn_redeem; "withdraw from Kamino / the farm" = farm_redeem; "withdraw from the vault / basis / USD*" = vault_withdraw; "withdraw collateral" = withdraw. When the product is unclear, ask.`;
}

/** "basis-eth", "vbETH", "ETH basis", "USD*", "junior" -> the vault id, else null. */
export function vaultOf(x: unknown): VaultId | null {
  if (typeof x !== "string") return null;
  const key = x.toLowerCase().replace(/[^a-z0-9*]/g, "");
  if (!key) return null;
  for (const id of VAULT_IDS) {
    const { name, symbol } = VAULT_NAMES[id];
    const names = [id, name, symbol, id.split("-")[1]!];
    if (id.startsWith("basis-")) {
      const asset = id.slice(6);
      names.push(`${asset}basis`, `basis${asset}`);
    }
    if (id === "perena-usdstar") names.push("usdstar", "usd*", "perena");
    if (id === "perena-junior") names.push("junior", "usd*junior", "usdstarjunior", "perenajunior");
    if (names.some((n) => n.toLowerCase().replace(/[^a-z0-9*]/g, "") === key)) return id;
  }
  return null;
}

/** A swap's route: Jupiter or Titan, like the app's Spot page. */
export type SwapProvider = "jupiter" | "titan";
export const SWAP_PROVIDERS: readonly SwapProvider[] = ["jupiter", "titan"];

export interface WriteIntent {
  op: WriteOp;
  asset: Asset | null;
  /** swap: the asset bought. */
  to_asset?: Asset | null;
  amount: AmountSpec | null;
  /** repay: which balance pays. swap: wallet swap vs swap of margin collateral. */
  source?: "wallet" | "margin" | null;
  /** swap: the route the user chose or named; unset = ask them, showing both quotes. */
  provider?: SwapProvider | null;
  /** perps: the Phoenix market (perp_open, perp_close). */
  market?: PerpMarket | null;
  /** perp_open: long or short. */
  side?: "long" | "short" | null;
  /** perp_open: Phoenix leverage (1 up to the market's max). Collateral is `amount` in USDC. */
  leverage?: number | null;
  /** vault_deposit / vault_withdraw / vault_move_shares: which vault. A deposit's amount is USDC, a withdrawal's shares. */
  vault?: VaultId | null;
}

/** "via Titan", "using Jupiter", "on titan": the swap route named in the user's own words, if exactly one is. */
export function providerFromText(message: string): SwapProvider | null {
  const t = message.toLowerCase();
  const titan = /\btitan\b/.test(t);
  const jupiter = /\b(?:jupiter|jup)\b(?!\s*(?:sol|usd))/.test(t);
  return titan === jupiter ? null : titan ? "titan" : "jupiter";
}

/** Sets a named route on every swap of a write or chain intent that has none (keyword and model routers alike). */
export function withNamedProvider(intent: Intent, message: string): Intent {
  const named = providerFromText(message);
  if (!named) return intent;
  const patch = (w: WriteIntent): WriteIntent => (w.op === "swap" && !w.provider ? { ...w, provider: named } : w);
  if (intent.lane === "write") return { ...intent, write: patch(intent.write) };
  if (intent.lane === "chain") return { ...intent, steps: intent.steps.map((s) => ("write" in s ? { write: patch(s.write) } : s)) };
  return intent;
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
  /** Phoenix perps (the app's Perps page): markets, the user's positions, and an order preview (nothing is built). */
  | { kind: "perps_markets" }
  | { kind: "perps_positions" }
  | { kind: "perps_preview"; market: PerpMarket; side: "long" | "short"; collateral: string; leverage: number }
  /** Basis and Perena vaults: the list (NAV, share price, APY when the app has history), the user's shares, a preview. */
  | { kind: "vaults_list" }
  | { kind: "vaults_positions" }
  | { kind: "vault_preview"; vault: VaultId; call: "deposit" | "withdraw"; amount: string }
  /** Every way to earn on an asset side by side (Earn, Kamino farm, Perena and Basis vaults), for a request naming none. */
  | { kind: "yield_options"; asset: Asset | null }
  | { kind: "concept"; topic: ConceptTopic }
  | { kind: "help" };

/** The Phoenix perps markets Vanna lists (the app's PERP_MARKETS). */
export const PERP_MARKETS = ["SOL", "ETH", "BTC", "TSLA", "META"] as const;
export type PerpMarket = (typeof PERP_MARKETS)[number];

/** "sol", "SOL-PERP", "TSLAx" -> the listed market, else null. */
export function perpMarketOf(x: unknown): PerpMarket | null {
  if (typeof x !== "string") return null;
  const key = x.trim().toUpperCase().replace(/-PERP$/, "").replace(/X$/, "");
  return (PERP_MARKETS as readonly string[]).includes(key) ? (key as PerpMarket) : null;
}

export type ConceptTopic = "health_factor" | "liquidation" | "leverage" | "collateral" | "earn" | "farm" | "margin" | "general";

export interface LeverIntent {
  asset: Asset;
  leverage: number;
  /** Lendable asset borrowed to fund the extra exposure (a stable, usually); null = ask. */
  borrow_asset: Asset | null;
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

/** One read tool call inside a plan's read leg: a catalogue tool name and its arguments. */
export interface ReadCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Something the user asked to SEE at a point of their plan ("then show my balance and APY"): the read tools that answer
 * it run when the plan reaches this leg, on live data, so it reflects every transaction before it.
 */
export interface ReadLeg {
  /** The user's own words asking for it. */
  question: string;
  /** Short title shown on the plan card. */
  label: string;
  reads: ReadCall[];
}

/**
 * A step of a chain: a transaction, a read leg, or `report` (the account's health report, used by the keyword router and
 * the leverage strategy).
 */
export type ChainStep = { write: WriteIntent } | { read: ReadLeg } | { report: true };

export type Intent =
  | { lane: "read"; read: ReadIntent }
  /** `notes`: parts of the request that can't be done, with why; shown with the plan, which goes ahead with the rest. */
  | { lane: "write"; write: WriteIntent; notes?: string[] }
  | { lane: "chain"; steps: ChainStep[]; notes?: string[] }
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
  perp_open: "none",
  perp_close: "none",
  perp_withdraw: "none",
  perp_register: "none",
  vault_deposit: "none",
  vault_withdraw: "none",
  vault_move_shares: "none",
};

export function unofferedMessage(asset: string): string {
  return `${asset} is not part of the Vanna Copilot product. I work with ${assetRoles()}.`;
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
      return fail(`${w.asset} can be used as margin collateral and swapped, but it has no Vanna lending pool, so it cannot be lent or borrowed.`);
    }
  }
  if (w.op === "deposit" && w.asset && !isDepositable(w.asset)) {
    return fail(
      `${w.asset} is not offered as a margin collateral deposit. It can still be lent, borrowed, repaid and withdrawn, and held in the margin account by borrowing or swapping into it. Collateral deposits: ${DEPOSIT_ASSETS.join(", ")}.`,
    );
  }
  if (w.op === "farm_deposit" && w.asset && !FARM_ASSETS.includes(w.asset)) {
    const hasVault = KAMINO_RECEIPTS.some((r) => r.underlying === w.asset);
    return fail(
      hasVault
        ? `The Kamino farm for ${w.asset} is closed to new supply. An existing ${w.asset} farm position can still be redeemed. Open farms: ${FARM_ASSETS.join(", ")}.`
        : `${w.asset} has no Kamino farm. Open farms: ${FARM_ASSETS.join(", ")}.`,
    );
  }
  if (w.op === "perp_open") {
    if (!w.market || !(PERP_MARKETS as readonly string[]).includes(w.market)) return fail(`Which perps market? ${PERP_MARKETS.join(", ")}.`);
    if (w.side !== "long" && w.side !== "short") return fail("Long or short?");
    if (!(typeof w.leverage === "number" && w.leverage >= 1)) return fail("At what leverage? Phoenix markets go from 1x up to their own cap.");
    if (!w.amount || !["exact", "usd", "all", "pct"].includes(w.amount.kind)) return fail("How much USDC should back the position (an amount, a percentage of your USDC, or all)?");
  }
  if (w.op === "perp_close") {
    if (!w.market || !(PERP_MARKETS as readonly string[]).includes(w.market)) return fail(`Which perps position? ${PERP_MARKETS.join(", ")}.`);
    if (w.amount && w.amount.kind !== "all" && w.amount.kind !== "pct") return fail("Close all of it, or a percentage (\"half\", \"25%\")?");
  }
  if (w.op === "perp_withdraw" && w.amount && w.amount.kind !== "all" && w.amount.kind !== "exact" && w.amount.kind !== "usd") {
    return fail("How much USDC should come back from Phoenix (an amount, or all)?");
  }
  if (w.op === "vault_deposit" || w.op === "vault_withdraw" || w.op === "vault_move_shares") {
    if (!w.vault || !(VAULT_IDS as readonly string[]).includes(w.vault)) {
      return fail(`Which vault? ${VAULT_IDS.map((v) => VAULT_NAMES[v].name).join(", ")}.`);
    }
    if (w.op === "vault_deposit" && (!w.amount || !["exact", "usd", "all", "pct"].includes(w.amount.kind))) return fail("How much USDC should go into the vault (an amount, a percentage of your USDC, or all)?");
    if (w.op === "vault_withdraw" && w.amount && w.amount.kind !== "all" && w.amount.kind !== "exact" && w.amount.kind !== "pct") {
      return fail("How many shares should come out (an amount, a percentage, or all)?");
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
    if (w.amount.kind === "lev") {
      if (w.op !== "borrow") return fail("Only a borrow can be sized to a leverage target.");
      if (!Number.isFinite(w.amount.multiple) || w.amount.multiple <= 1) return fail("Leverage has to be above 1x.");
      if (w.amount.multiple > 10) return fail("I won't size above 10x; at this protocol's health rules it could never hold the 1.15 floor.");
      if (w.amount.base) {
        if (!(PRODUCT_ASSETS as readonly string[]).includes(w.amount.base.asset)) return fail(unofferedMessage(String(w.amount.base.asset)));
        if (parseDecimalString(w.amount.base.value) === null) return fail("The amount the leverage is taken on is not valid.");
      }
    }
    if (w.amount.kind === "against") {
      if (w.op !== "borrow") return fail("Only a borrow can be sized against a holding.");
      if (!(PRODUCT_ASSETS as readonly string[]).includes(w.amount.base.asset)) return fail(unofferedMessage(String(w.amount.base.asset)));
      if (parseDecimalString(w.amount.base.value) === null) return fail("The amount the borrow is taken against is not valid.");
    }
    if (w.amount.kind === "usd") {
      if (!w.asset) return fail("Which asset should that dollar amount buy or move?");
      if (parseDecimalString(w.amount.value) === null) return fail("That dollar amount is not valid.");
    }
    if (w.amount.kind === "prev" && w.amount.pct !== undefined && !(w.amount.pct > 0 && w.amount.pct <= 100)) return fail("Percentages must be between 0 and 100.");
    if (w.amount.kind === "hf") {
      const t = w.amount.target;
      if (!["borrow", "withdraw", "repay", "deposit"].includes(w.op)) return fail("A health-factor target can size a borrow, a withdrawal, a repayment or a collateral deposit.");
      if (!Number.isFinite(t) || t <= LIQUIDATION_HF || t > 100) return fail(`A health factor target has to be above the ${LIQUIDATION_HF_TEXT} liquidation line.`);
      if ((w.op === "borrow" || w.op === "withdraw") && t < copilotConfig.minHealthFactor) {
        return fail(`I keep every borrow and withdrawal at a health factor of ${copilotConfig.minHealthFactor.toFixed(2)} or above, so I can't size one down to ${t}.`);
      }
    }
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
  if (l.borrow_asset && !isLendBorrow(l.borrow_asset)) return fail(`I fund leverage by borrowing one of ${LEND_BORROW_ASSETS.join(", ")}.`);
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
    if (r.target_hf !== null && !(r.target_hf > LIQUIDATION_HF && r.target_hf <= 100)) return fail(`A health factor target has to be above the ${LIQUIDATION_HF_TEXT} liquidation line.`);
    if (r.amount === null && r.target_hf === null) return fail("Give me an amount or a health factor target.");
  }
  if (r.kind === "yield_options" && r.asset && !(PRODUCT_ASSETS as readonly string[]).includes(r.asset)) return fail(unofferedMessage(r.asset));
  if (r.kind === "vault_preview") {
    if (!(VAULT_IDS as readonly string[]).includes(r.vault)) return fail(`Vaults: ${VAULT_IDS.map((v) => VAULT_NAMES[v].name).join(", ")}.`);
    if (r.call !== "deposit" && r.call !== "withdraw") return fail("A deposit or a withdrawal?");
    if (parseDecimalString(r.amount) === null) return fail(r.call === "deposit" ? "How much USDC?" : "How many shares?");
  }
  if (r.kind === "perps_preview") {
    if (!(PERP_MARKETS as readonly string[]).includes(r.market)) return fail(`Perps markets: ${PERP_MARKETS.join(", ")}.`);
    if (r.side !== "long" && r.side !== "short") return fail("Long or short?");
    if (parseDecimalString(r.collateral) === null && r.collateral !== "0") return fail("How much USDC should back the position?");
    if (!(r.leverage >= 1 && r.leverage <= 100)) return fail("Leverage starts at 1x.");
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

/** Every number the user typed (commas as thousands, "k" suffix), for checking that a model never invents an amount. */
export function typedNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.toLowerCase().matchAll(NUMBER_TOKEN_RE)) {
    const body = m[2].replace(/[.,]+$/, "");
    if (!body) continue;
    const k = body.endsWith("k");
    const n = Number(body.replace(/k$/, "").replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(k ? n * 1000 : n);
  }
  return out;
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
