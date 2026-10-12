/**
 * Read lane: MCP facts -> a structured answer built by code.
 *
 * Every figure in an answer is copied or computed from an MCP result in this file. Gemini may later
 * re-word the headline and note (see vertex.ts), but only after the figures are fixed here, and its
 * wording is discarded if it contains a number that is not in `data`.
 *
 * Sizing helpers for "how much can I borrow / withdraw" also live here, because the write lane
 * needs the very same number for "borrow max": the MCP's own `max_borrow` uses the protocol's 1.10
 * threshold, while the Copilot's floor is 1.15, so the safe amount is computed from the MCP's
 * health numbers and then verified through the MCP's `can_borrow` / `can_withdraw`.
 */

import { copilotConfig } from "./config";
import { CONCEPTS, fmtAmount, fmtFractionPct, fmtHf, fmtPct, fmtUsd, humanizeMcpError } from "./explain";
import { COLLATERAL_ONLY_ASSETS, LEND_BORROW_ASSETS, PRODUCT_ASSETS, type Asset, type ConceptTopic, type ReadIntent } from "./intent";
import { mcp, MCPError, type McpCtx } from "./mcp-client";
import {
  floorDecimals,
  hfAfter,
  LIQUIDATION_HF,
  maxBorrowUsd,
  maxWithdrawUsd,
  num,
  readCan,
  readHealth,
  tokenDecimals,
  usdToUnits,
  type HealthRead,
} from "./risk";
import type { AnswerFact, StructuredAnswer } from "./answer-schema";
import { LIQUIDATION_HF_TEXT } from "./protocol-constants";
import type { CopilotUser } from "./types";
import { readPredictHistory, readPredictMarket, readPredictMarkets, readPredictPositions, readPredictQuote } from "./predict-facts";

export interface ReadOutcome {
  answer: StructuredAnswer;
  /** Raw MCP figures the answer was built from; the grounding check for model wording. */
  data: Record<string, unknown>;
  /** False when a failure made the answer an explanation of what is unavailable. */
  ok: boolean;
  /** Prose that must not be re-worded by the model (errors, static explanations). */
  fixedWording?: boolean;
}

export interface ReadCtx extends McpCtx {
  user: CopilotUser;
}

const fact = (label: string, value: string, tone?: AnswerFact["tone"]): AnswerFact => ({ label, value, ...(tone ? { tone } : {}) });

const hfTone = (hf: number | null): AnswerFact["tone"] =>
  hf === null ? "good" : hf <= LIQUIDATION_HF ? "bad" : hf < copilotConfig.minHealthFactor ? "warn" : "good";

function unavailable(err: unknown, what: string): ReadOutcome {
  const h = humanizeMcpError(err);
  return {
    ok: false,
    fixedWording: true,
    data: {},
    answer: { headline: `I couldn't get ${what} right now, so I have no figure to give you.`, facts: [], note: h.message, venue: "none" },
  };
}

const noMargin = (what: string): ReadOutcome => ({
  ok: true,
  fixedWording: true,
  data: {},
  answer: {
    headline: `You don't have a margin account yet, so there is no ${what}.`,
    facts: [],
    note: 'Say "open a margin account" to create one, then deposit collateral.',
    venue: "margin",
  },
});

function isNoAccount(err: unknown): boolean {
  return err instanceof MCPError && err.code === "account_not_found";
}

// ── Health reads shared with the write lane ─────────────────────────────────

export type HealthResult = { kind: "ok"; health: HealthRead; raw: Record<string, unknown> } | { kind: "no_account" } | { kind: "unavailable"; error: unknown } | { kind: "malformed" };

export async function loadHealth(ctx: ReadCtx): Promise<HealthResult> {
  try {
    const raw = await mcp.accountHealth(ctx.user.wallet, ctx);
    const health = readHealth(raw);
    return health ? { kind: "ok", health, raw } : { kind: "malformed" };
  } catch (err) {
    return isNoAccount(err) ? { kind: "no_account" } : { kind: "unavailable", error: err };
  }
}

export interface PriceRead {
  usd: number;
  stale: boolean;
}

export async function loadPrice(asset: string, ctx: ReadCtx): Promise<PriceRead | null> {
  try {
    const raw = await mcp.price(asset, ctx);
    const usd = num(raw.price_usd);
    if (usd === null || !(usd > 0)) return null;
    return { usd, stale: raw.stale === true || raw.fresh === false };
  } catch {
    return null;
  }
}

/**
 * The fork's oracle prices go stale as its clock drifts. The app's price keeper (`refreshForkPrices`, the same
 * function behind /api/prices/refresh) fixes that on demand, so a stale read refreshes once and re-reads.
 * Throttled so a burst of steps shares one refresh. Callers still see `stale` if it persists; the MCP build
 * (which refreshes and simulates) is the authoritative check, so a lagging flag alone must not block a write.
 */
export const priceDeps = {
  refresh: async (): Promise<void> => {
    const { refreshForkPrices } = await import("../solana/server/fork-prices");
    await refreshForkPrices();
  },
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};
const PRICE_REFRESH_MIN_GAP_MS = 15_000;
let lastPriceRefresh = 0;

export function resetPriceRefresh(): void {
  lastPriceRefresh = 0;
}

export async function loadFreshPrice(asset: string, ctx: ReadCtx): Promise<PriceRead | null> {
  let price = await loadPrice(asset, ctx);
  if (price?.stale && priceDeps.now() - lastPriceRefresh >= PRICE_REFRESH_MIN_GAP_MS) {
    lastPriceRefresh = priceDeps.now();
    try {
      await priceDeps.refresh();
      await priceDeps.sleep(800);
      price = await loadPrice(asset, ctx);
    } catch {
      /* the keeper is best-effort: a still-stale price is left flagged, never guessed */
    }
  }
  return price;
}

export type Sized = { ok: true; amount: string; usd: number; hfAfter: number | null; protocolMax: string | null } | { ok: false; reason: string };

/** Share of a pool's available liquidity a sized borrow may take: interest accrues between the read and the borrow. */
export const POOL_HEADROOM = 0.99;

/** Units of `asset` the Vanna pool can lend right now, or null when the pool can't be read (the borrow check still runs). */
export async function poolAvailable(asset: string, ctx: ReadCtx): Promise<number | null> {
  try {
    const v = Number((await mcp.poolStats(asset, ctx)).available_liquidity);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Largest borrow that keeps HF >= floor and fits the pool's available liquidity, verified through the MCP. */
export async function sizeSafeBorrow(asset: Asset, ctx: ReadCtx, opts: { hint?: HealthResult; floor?: number } = {}): Promise<Sized> {
  // A user may ask for a higher floor ("borrow down to a health factor of 1.5"), never a lower one.
  const floor = Math.max(copilotConfig.minHealthFactor, opts.floor ?? 0);
  // The account, the price and the pool are independent reads: fetched together.
  const [h, price, available] = await Promise.all([opts.hint ? Promise.resolve(opts.hint) : loadHealth(ctx), loadFreshPrice(asset, ctx), poolAvailable(asset, ctx)]);
  if (h.kind === "no_account") return { ok: false, reason: "You don't have a margin account yet." };
  if (h.kind !== "ok") return { ok: false, reason: "I couldn't read your account, so I can't size a safe borrow." };
  if (!price) return { ok: false, reason: `The ${asset} price is unavailable right now.` };
  const { collateralUsd: c, debtUsd: d } = h.health;
  const maxUsd = maxBorrowUsd(c, d, floor, true);
  // The protocol maximum is informational: ask for it alongside the first check instead of after it.
  const protocolMaxP = mcp
    .maxBorrow(ctx.user.wallet, asset, ctx)
    .then((m) => (typeof m.max_amount === "string" ? m.max_amount : null))
    .catch(() => null);
  let units = Number(usdToUnits(maxUsd * 0.995, price.usd, asset));
  // The health maths can't see the pool: a borrow above what the pool can lend fails on chain.
  if (available !== null) {
    if (!(available > 0)) return { ok: false, reason: `The ${asset} pool has nothing available to borrow right now.` };
    units = Math.min(units, available * POOL_HEADROOM);
  }
  for (let i = 0; i < 8 && units > 0; i++) {
    const amount = floorDecimals(units, tokenDecimals(asset));
    if (Number(amount) <= 0) break;
    try {
      const can = readCan(await mcp.canBorrow({ authority: ctx.user.wallet, asset, amount }, ctx));
      if (can?.allowed && typeof can.projectedHf === "number" && can.projectedHf >= floor) {
        const protocolMax = await protocolMaxP;
        return { ok: true, amount, usd: Number(amount) * price.usd, hfAfter: can.projectedHf, protocolMax };
      }
      if (can && !can.allowed && can.reason && !/breach/i.test(can.reason)) return { ok: false, reason: can.reason };
    } catch (err) {
      return { ok: false, reason: humanizeMcpError(err).message };
    }
    units *= 0.97;
  }
  return { ok: false, reason: `There is no room to borrow ${asset} while keeping your health factor at ${floor.toFixed(2)} or above.` };
}

/** Largest collateral withdrawal that keeps HF >= floor, verified through the MCP. */
export async function sizeSafeWithdraw(asset: Asset, ctx: ReadCtx, opts: { hint?: HealthResult; floor?: number } = {}): Promise<Sized> {
  const floor = Math.max(copilotConfig.minHealthFactor, opts.floor ?? 0);
  const h = opts.hint ?? (await loadHealth(ctx));
  if (h.kind === "no_account") return { ok: false, reason: "You don't have a margin account yet." };
  if (h.kind !== "ok") return { ok: false, reason: "I couldn't read your account, so I can't size a safe withdrawal." };
  const row = h.health.collateral.find((r) => r.symbol === asset);
  if (!row || !(row.units > 0)) return { ok: false, reason: `You have no ${asset} collateral in your margin account.` };
  const price = row.priceUsd ?? (await loadPrice(asset, ctx))?.usd ?? null;
  if (!price) return { ok: false, reason: `The ${asset} price is unavailable right now.` };
  const { collateralUsd: c, debtUsd: d } = h.health;
  const limitUsd = maxWithdrawUsd(c, d, floor);
  let units = d <= 0 ? row.units : Math.min(row.units, (limitUsd * 0.995) / price);
  for (let i = 0; i < 8 && units > 0; i++) {
    const amount = d <= 0 || units >= row.units ? row.unitsText : floorDecimals(units, tokenDecimals(asset));
    if (Number(amount) <= 0) break;
    try {
      const can = readCan(await mcp.canWithdraw({ authority: ctx.user.wallet, asset, amount }, ctx));
      const hfOk = can?.projectedHf === null || (typeof can?.projectedHf === "number" && can.projectedHf >= floor);
      if (can?.allowed && hfOk) {
        return { ok: true, amount, usd: Number(amount) * price, hfAfter: can.projectedHf as number | null, protocolMax: null };
      }
      if (can && !can.allowed && can.reason && !/breach/i.test(can.reason)) return { ok: false, reason: can.reason };
    } catch (err) {
      return { ok: false, reason: humanizeMcpError(err).message };
    }
    units *= 0.97;
  }
  return { ok: false, reason: `You can't withdraw any ${asset} right now without taking your health factor below ${floor.toFixed(2)}.` };
}

/** Smallest decimal string >= x at `dp` places. */
function ceilDecimals(x: number, dp: number): string {
  const f = 10 ** dp;
  return (Math.ceil(x * f - 1e-9) / f).toFixed(dp).replace(/\.?0+$/, "");
}

/**
 * A step sized so the health factor ends at `target`, from the account as it is now (HF = C / D, USD at oracle prices):
 * - borrow / withdraw: the largest amount that keeps HF >= target (the safe sizers, with `target` as the floor);
 * - repay from the wallet: debt falls by x, so C / (D - x) = T  ->  x = D - C / T;
 * - repay from the margin balance: both fall by x, so (C - x) / (D - x) = T  ->  x = (T*D - C) / (T - 1);
 * - deposit: collateral rises by x, so (C + x) / D = T  ->  x = T*D - C.
 * Repay and deposit round up (so the target is reached) and a repay never exceeds the debt. Already at the target: skip.
 */
export async function sizeToHealth(
  op: string,
  asset: Asset,
  target: number,
  ctx: ReadCtx,
  opts: { hint?: HealthResult; fromMargin?: boolean } = {},
): Promise<Sized | { ok: true; skip: string }> {
  if (op === "borrow") return sizeSafeBorrow(asset, ctx, { hint: opts.hint, floor: target });
  if (op === "withdraw") return sizeSafeWithdraw(asset, ctx, { hint: opts.hint, floor: target });
  const h = opts.hint ?? (await loadHealth(ctx));
  if (h.kind === "no_account") return { ok: false, reason: "You don't have a margin account yet." };
  if (h.kind !== "ok") return { ok: false, reason: "I couldn't read your account, so I can't size this to a health factor." };
  const { collateralUsd: c, debtUsd: d } = h.health;
  if (!(d > 0)) return { ok: true, skip: "You have no debt, so there is no health factor to move." };
  if (c / d >= target - 1e-9) return { ok: true, skip: `Your health factor is already ${(c / d).toFixed(2)}, at or above ${target.toFixed(2)}.` };
  const price = await loadFreshPrice(asset, ctx);
  if (!price) return { ok: false, reason: `The ${asset} price is unavailable right now.` };
  let usd: number;
  if (op === "repay") {
    const row = h.health.debt.find((r) => r.symbol === asset);
    if (!row || !(row.units > 0)) return { ok: false, reason: `You have no ${asset} debt to repay.` };
    usd = opts.fromMargin ? (target * d - c) / (target - 1) : d - c / target;
    if (usd >= row.usd - 1e-9) return { ok: true, amount: row.unitsText, usd: row.usd, hfAfter: null, protocolMax: null };
  } else if (op === "deposit") {
    usd = target * d - c;
  } else {
    return { ok: false, reason: `A health-factor target can't size a ${op}.` };
  }
  const amount = ceilDecimals(usd / price.usd, tokenDecimals(asset));
  return { ok: true, amount, usd: Number(amount) * price.usd, hfAfter: target, protocolMax: null };
}

// ── Read intents ────────────────────────────────────────────────────────────

export async function runRead(intent: ReadIntent, ctx: ReadCtx): Promise<ReadOutcome> {
  switch (intent.kind) {
    case "health":
      return readHealthAnswer(ctx);
    case "positions":
      return readPositions(ctx);
    case "debt":
    case "collateral":
      return readSide(intent.kind, ctx);
    case "wallet":
      return readWallet(ctx);
    case "price":
      return readPrices(intent.assets, ctx);
    case "pool":
      return readPools(intent.assets, ctx);
    case "earn_position":
      return readEarn(intent.assets, ctx);
    case "farm_markets":
      return readFarmMarkets(ctx);
    case "farm_positions":
      return readFarmPositions(ctx);
    case "capacity":
      return readCapacity(intent.what, intent.asset, ctx);
    case "whatif":
      return readWhatIf(intent, ctx);
    case "liquidation_risk":
      return readLiquidation(ctx);
    case "history":
      return readHistory(ctx);
    case "protocol":
      return readProtocol(ctx);
    case "quote":
      return readQuote(intent.from, intent.to, intent.amount, ctx);
    case "perps_markets":
      return readPerpsMarkets(ctx);
    case "perps_positions":
      return readPerpsPositions(ctx);
    case "perps_preview":
      return readPerpsPreview(intent, ctx);
    case "vaults_list":
      return readVaultsList(ctx);
    case "vaults_positions":
      return readVaultsPositions(ctx);
    case "vault_preview":
      return readVaultPreview(intent, ctx);
    case "yield_options":
      return readYieldOptions(intent.asset, ctx);
    case "predict_markets":
      return readPredictMarkets(intent.category, intent.query, ctx);
    case "predict_market":
      return readPredictMarket(intent.id, ctx);
    case "predict_positions":
      return readPredictPositions(ctx);
    case "predict_history":
      return readPredictHistory(intent.market, ctx);
    case "predict_quote":
      return readPredictQuote(intent.legs, ctx);
    case "concept":
      return concept(intent.topic);
    case "help":
      return concept("general");
  }
}

function concept(topic: ConceptTopic): ReadOutcome {
  return {
    ok: true,
    fixedWording: true,
    data: {},
    answer: { headline: CONCEPTS[topic] ?? CONCEPTS.general, facts: [], venue: "none" },
  };
}

async function readHealthAnswer(ctx: ReadCtx): Promise<ReadOutcome> {
  const r = await loadHealth(ctx);
  if (r.kind === "no_account") return noMargin("health factor");
  if (r.kind === "unavailable") return unavailable(r.error, "your health factor");
  if (r.kind === "malformed") return unavailable(new Error("the account data was incomplete"), "your health factor");
  const h = r.health;
  const facts: AnswerFact[] = [
    fact("health factor", fmtHf(h.hf), hfTone(h.hf)),
    fact("collateral", fmtUsd(h.collateralUsd)),
    fact("debt", fmtUsd(h.debtUsd)),
    fact("liquidation at", LIQUIDATION_HF_TEXT),
    fact("safety floor", copilotConfig.minHealthFactor.toFixed(2)),
  ];
  const headline =
    h.hf === null
      ? `You have no debt, so there is no health factor to report. Your margin collateral is ${fmtUsd(h.collateralUsd)}.`
      : `Your health factor is ${h.hf.toFixed(2)} on your margin account.`;
  const notes: string[] = [];
  if (h.isLiquidatable) notes.push("Your account is at or below the liquidation threshold.");
  else if (h.hf !== null && h.hf < copilotConfig.minHealthFactor) notes.push(`That is below the ${copilotConfig.minHealthFactor.toFixed(2)} safety floor; repaying debt or adding collateral raises it.`);
  if (!h.pricesOk) notes.push("At least one price is stale or failed a quality check right now, so this figure may move.");
  return { ok: true, data: { health: r.raw }, answer: { headline, facts, ...(notes.length ? { note: notes.join(" ") } : {}), venue: "margin" } };
}

const rowsTable = (caption: string, rows: HealthRead["collateral"]) => ({
  caption,
  columns: ["Asset", "Amount", "Value"],
  rows: rows.map((r) => [r.symbol, fmtAmount(r.unitsText), fmtUsd(r.usd)]),
});

async function readSide(kind: "debt" | "collateral", ctx: ReadCtx): Promise<ReadOutcome> {
  const r = await loadHealth(ctx);
  if (r.kind === "no_account") return noMargin(kind === "debt" ? "debt" : "collateral");
  if (r.kind !== "ok") return unavailable(r.kind === "unavailable" ? r.error : new Error("incomplete account data"), `your ${kind}`);
  const h = r.health;
  const rows = kind === "debt" ? h.debt : h.collateral;
  const total = kind === "debt" ? h.debtUsd : h.collateralUsd;
  const headline = rows.length
    ? `Your margin ${kind} is ${fmtUsd(total)} across ${rows.length} asset${rows.length === 1 ? "" : "s"}.`
    : `You have no ${kind} on your margin account.`;
  return {
    ok: true,
    data: { health: r.raw },
    answer: { headline, facts: [fact("health factor", fmtHf(h.hf), hfTone(h.hf))], ...(rows.length ? { tables: [rowsTable(kind === "debt" ? "Debt" : "Collateral", rows)] } : {}), venue: "margin" },
  };
}

interface WalletAsset {
  symbol: string;
  wallet_balance: string;
  lender_share_balance: string | null;
  lender_redeemable_underlying: string | null;
}

function walletAssets(raw: Record<string, unknown>): WalletAsset[] | null {
  if (!Array.isArray(raw.assets)) return null;
  const out: WalletAsset[] = [];
  for (const a of raw.assets) {
    if (!a || typeof a !== "object") return null;
    const o = a as Record<string, unknown>;
    if (typeof o.symbol !== "string" || num(o.wallet_balance) === null) return null;
    out.push({
      symbol: o.symbol,
      wallet_balance: String(o.wallet_balance),
      lender_share_balance: o.lender_share_balance == null ? null : String(o.lender_share_balance),
      lender_redeemable_underlying: o.lender_redeemable_underlying == null ? null : String(o.lender_redeemable_underlying),
    });
  }
  return out;
}

async function readWallet(ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.wallet(ctx.user.wallet, ctx);
  } catch (err) {
    return unavailable(err, "your wallet balances");
  }
  const assets = walletAssets(raw);
  const sol = num(raw.sol_balance);
  if (!assets || sol === null) return unavailable(new Error("the wallet data was incomplete"), "your wallet balances");
  const held = assets.filter((a) => Number(a.wallet_balance) > 0);
  return {
    ok: true,
    data: { wallet: raw },
    answer: {
      headline: `Your wallet holds ${fmtAmount(sol, "SOL")} (native)${held.length ? ` and ${held.length} other token balance${held.length === 1 ? "" : "s"}` : ""}.`,
      facts: [fact("native SOL", fmtAmount(String(raw.sol_balance), "SOL")), fact("margin account", raw.margin_account_exists === true ? "open" : "not opened")],
      ...(held.length ? { tables: [{ caption: "Wallet tokens", columns: ["Asset", "Balance"], rows: held.map((a) => [a.symbol, fmtAmount(a.wallet_balance)]) }] } : {}),
      venue: "wallet",
    },
  };
}

// ── Phoenix perps ────────────────────────────────────────────────────────────

type PerpRow = Record<string, unknown>;

/** The Phoenix venue's collateral row of a raw health read: its value and positions (null when the margin holds none). */
function phoenixRows(raw: unknown): { valueUsd: number; positions: PerpRow[] } | null {
  const collateral = raw && typeof raw === "object" ? (raw as Record<string, unknown>).collateral : null;
  const row = Array.isArray(collateral) ? (collateral as PerpRow[]).find((r) => r.is_venue === true || r.symbol === "Phoenix") : null;
  if (!row) return null;
  const venue = (row.venue ?? {}) as Record<string, unknown>;
  return { valueUsd: num(row.usd_value) ?? 0, positions: Array.isArray(venue.positions) ? (venue.positions as PerpRow[]) : [] };
}

const px = (v: unknown) => (num(v) === null ? "—" : fmtUsd(Number(v)));
const signedUsd = (v: unknown) => {
  const n = num(v);
  return n === null ? "—" : `${n < 0 ? "-" : "+"}${fmtUsd(Math.abs(n))}`;
};

function perpsTable(caption: string, rows: PerpRow[]) {
  return {
    caption,
    columns: ["Market", "Side", "Size", "Entry", "Price", "PnL", "Liquidation"],
    rows: rows.map((p) => [
      String(p.name ?? p.market ?? ""),
      String(p.side ?? ""),
      `${String(p.size ?? "—")} (${px(p.size_usd)})`,
      px(p.entry_price),
      px(p.index_price ?? p.mark_price),
      signedUsd(p.pnl_usd),
      p.liquidation_price === undefined ? "—" : p.liquidation_price === null ? "none" : px(p.liquidation_price),
    ]),
  };
}

async function readPerpsMarkets(ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.perpsMarkets(ctx);
  } catch (err) {
    return unavailable(err, "the Phoenix perps markets");
  }
  const markets = Array.isArray(raw.markets) ? (raw.markets as PerpRow[]) : [];
  if (!markets.length) return unavailable(new Error("no markets returned"), "the Phoenix perps markets");
  return {
    ok: true,
    data: { markets: raw },
    answer: {
      headline: `Phoenix perps markets you can trade long or short: ${markets.map((m) => String(m.market)).join(", ")}.`,
      facts: [],
      tables: [
        {
          columns: ["Market", "Index price", "Mark price", "Max leverage", "Open", "Taker fee"],
          rows: markets.map((m) => [
            String(m.name ?? m.market),
            px(m.index_price),
            px(m.mark_price),
            `${String(m.max_leverage)}x`,
            m.trading_enabled === true ? "yes" : "closed",
            m.taker_fee_pct === null || m.taker_fee_pct === undefined ? "—" : `${Number(m.taker_fee_pct).toFixed(3)}%`,
          ]),
        },
      ],
      note: "Perps use your margin account's USDC as collateral and Phoenix's own leverage; no Vanna loan is created.",
      venue: "phoenix",
    },
  };
}

async function readPerpsPositions(ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.perpsPositions(ctx.user.wallet, ctx);
  } catch (err) {
    return isNoAccount(err) ? noMargin("perps position") : unavailable(err, "your perps positions");
  }
  if (raw.has_margin_account === false) return noMargin("perps position");
  const positions = Array.isArray(raw.positions) ? (raw.positions as PerpRow[]) : [];
  const facts: AnswerFact[] = [
    fact("Phoenix balance", px(raw.phoenix_value_usd)),
    fact("withdrawable to margin now", `${String(raw.withdrawable_now_usdc ?? "0")} USDC`),
    fact("perps leverage", `${String(raw.leverage ?? "0")}x`),
    fact("health factor", raw.health_factor ? String(raw.health_factor) : "no debt"),
  ];
  return {
    ok: true,
    data: { perps: raw },
    answer: {
      headline: positions.length
        ? `You have ${positions.length} open Phoenix perps position${positions.length === 1 ? "" : "s"}.`
        : "You have no open Phoenix perps positions.",
      facts,
      ...(positions.length ? { tables: [perpsTable("Positions", positions)] } : {}),
      note: `Liquidation is the price at which your whole margin account would fall to the ${LIQUIDATION_HF_TEXT} health factor with only that market moving; "none" means it can't get there.`,
      venue: "phoenix",
    },
  };
}

// ── Basis and Perena vaults ──────────────────────────────────────────────────

type VaultRow = Record<string, unknown>;
/**
 * A vault's yield as its source publishes it (the app's vault pages, backend `dd46264`, `fa6d2f6`): the app's APY with
 * its source - Vanna's share-price history, or an approximate estimate from past deposits' share price (named as an
 * estimate, with its baseline date); else Perena's own 7-day APY, or Phoenix's funding for a Basis market (what the
 * short is paid, annualised - not the vault's net yield). The Copilot computes none of these.
 */
function vaultYield(v: VaultRow): string {
  const days = num(v.apy_30d_pct) !== null ? 30 : num(v.apy_7d_pct) !== null ? 7 : null;
  if (days !== null) {
    const value = num(v[`apy_${days}d_pct`]) as number;
    if (v[`apy_${days}d_source`] === "deposit_event_estimate") {
      const since = typeof v[`apy_${days}d_baseline`] === "string" ? ` since ${v[`apy_${days}d_baseline`]}` : "";
      return `${value.toFixed(2)}% APY (approximate, estimated from past deposits${since})`;
    }
    return `${value.toFixed(2)}% APY (Vanna share-price history, ${days}-day)`;
  }
  const launch = sinceLaunch(v);
  const published = num(v.published_apy_7d_pct);
  if (published !== null) return `${published.toFixed(2)}% APY (Perena, 7-day)`;
  const funding = (v.funding ?? null) as Record<string, unknown> | null;
  const f7 = num(funding?.funding_apr_7d_pct);
  if (f7 !== null) {
    const neg = num(funding?.negative_days_30);
    return `${f7.toFixed(2)}% funding (Phoenix, 7-day, annualised)${neg ? `; ${neg} negative day${neg === 1 ? "" : "s"} of 30` : ""}${launch ? `; ${launch}` : ""}`;
  }
  return launch ?? "no data yet";
}

/**
 * Basis, before a 7-day figure exists: the raw share-price return since launch and the days behind it, as the app shows
 * it beside the funding figure (backend `aaed5cc`, "Since launch -1.57% · 5 days"). Never annualised: a few days on
 * a small NAV would turn one rebalance cost into a huge APY.
 */
function sinceLaunch(v: VaultRow): string | null {
  const ret = num(v.return_since_launch_pct);
  const days = num(v.since_launch_days);
  if (ret === null || days === null) return null;
  const d = Math.floor(days);
  const span = days < 1 ? "under 1 day" : `${d} day${d === 1 ? "" : "s"}`;
  return `since launch ${ret < 0 ? "−" : "+"}${Math.abs(ret).toFixed(2)}% over ${span} (not annualised)`;
}

const VAULT_NOTE =
  "Every deposit is USDC and every withdrawal pays USDC; the shares sit in your margin account as collateral. Perena's APY is Perena's own 7-day figure; a Basis vault shows Phoenix's funding for its market (what the short is paid, not the vault's net yield). Where the app has its own vault APY it is shown with its source; one marked approximate is estimated from past deposits, not measured; a new Basis vault also shows its raw share-price return since launch (not annualised) until a 7-day figure exists. SOL Basis also deposits margin USDC, routed through your wallet in one transaction, so your health factor is checked while that USDC is out of the margin account.";

async function readVaultsList(ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.vaultsList(ctx);
  } catch (err) {
    return unavailable(err, "the vaults");
  }
  const vaults = Array.isArray(raw.vaults) ? (raw.vaults as VaultRow[]) : [];
  if (!vaults.length) return unavailable(new Error("no vaults returned"), "the vaults");
  return {
    ok: true,
    data: { vaults: raw },
    answer: {
      headline: `Vaults you can deposit USDC into: ${vaults.map((v) => String(v.name)).join(", ")}.`,
      facts: [],
      tables: [
        {
          columns: ["Vault", "Type", "Share price", "TVL (NAV)", "Yield (source)", "Deposits"],
          rows: vaults.map((v) => [
            String(v.name),
            v.kind === "basis" ? `Delta-neutral ${String(v.asset)}` : "Perena (USDC)",
            v.share_price_usd === null || v.share_price_usd === undefined ? "—" : `$${Number(v.share_price_usd).toFixed(4)}`,
            px(v.nav_usd),
            vaultYield(v),
            v.error ? "unavailable" : v.deposits_open === true ? "open" : "closed",
          ]),
        },
      ],
      note: VAULT_NOTE + " USD* Junior's instant withdrawal has a 1% exit fee.",
      venue: "vaults",
    },
  };
}

async function readVaultsPositions(ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.vaultsPositions(ctx.user.wallet, ctx);
  } catch (err) {
    return unavailable(err, "your vault positions");
  }
  const rows = Array.isArray(raw.positions) ? (raw.positions as VaultRow[]) : [];
  const inWallet = rows.filter((r) => r.held_in === "wallet");
  return {
    ok: true,
    data: { vaults: raw },
    answer: {
      headline: rows.length ? `You hold shares in ${rows.length} vault position${rows.length === 1 ? "" : "s"}.` : "You hold no vault shares.",
      facts: [],
      ...(rows.length
        ? {
            tables: [
              {
                columns: ["Vault", "Shares", "Held in", "Collateral value"],
                rows: rows.map((r) => [String(r.name), `${String(r.shares)} ${String(r.symbol)}`, String(r.held_in), px(r.collateral_value_usd)]),
              },
            ],
          }
        : {}),
      note: inWallet.length
        ? "Shares in your wallet don't count as collateral until they are moved into the margin account."
        : VAULT_NOTE,
      venue: "vaults",
    },
  };
}

/**
 * Every way to earn on an asset, side by side, each yield in its own measure (Earn APR, Kamino live APY, vault APY from
 * share-price history): nothing is converted, combined or ranked here.
 */
async function readYieldOptions(asset: Asset | null, ctx: ReadCtx): Promise<ReadOutcome> {
  const lendable = asset ? ((LEND_BORROW_ASSETS as readonly string[]).includes(asset) ? [asset] : []) : [...LEND_BORROW_ASSETS];
  const [poolsR, farmR, vaultsR] = await Promise.allSettled([
    Promise.all(lendable.map((a) => mcp.poolStats(a, ctx).then((p) => [a, p] as const))),
    mcp.farmMarkets(ctx),
    mcp.vaultsList(ctx),
  ]);
  const rows: string[][] = [];
  const data: Record<string, unknown> = {};
  if (poolsR.status === "fulfilled") {
    for (const [a, p] of poolsR.value) {
      data[`earn_${a}`] = p;
      const apr = num(p.supply_apr_pct);
      rows.push(["Vanna Earn", a, apr === null ? "unavailable" : `${fmtPct(apr)} APR`, "Lends to Vanna's pool; not collateral", "wallet"]);
    }
  }
  if (farmR.status === "fulfilled") {
    data.kamino = farmR.value;
    const markets = Array.isArray(farmR.value.markets) ? (farmR.value.markets as Array<Record<string, unknown>>) : [];
    for (const m of markets) {
      if (asset && String(m.underlying) !== asset) continue;
      const apy = m.metrics_available === true && num(m.supply_apy_fraction) !== null ? `${fmtFractionPct(String(m.supply_apy_fraction))} live APY` : "unavailable";
      rows.push(["Kamino farm", String(m.underlying), apy, `Lends on Kamino; ${String(m.symbol)} stays collateral`, "margin"]);
    }
  }
  if (vaultsR.status === "fulfilled" && (!asset || asset === "USDC")) {
    data.vaults = vaultsR.value;
    const vaults = Array.isArray(vaultsR.value.vaults) ? (vaultsR.value.vaults as VaultRow[]) : [];
    for (const v of vaults) {
      const how = v.kind === "basis" ? `Delta-neutral ${String(v.asset)}: earns funding` : v.id === "perena-junior" ? "Perena junior tranche: first loss, 1% exit fee" : "Perena stablecoin yield";
      rows.push([String(v.name), "USDC", vaultYield(v), how, "margin"]);
    }
  }
  if (!rows.length) return unavailable(new Error("no yield products answered"), "the yield options");
  return {
    ok: true,
    data,
    answer: {
      headline: asset ? `Ways to earn on ${asset} here.` : "Ways to earn here: Vanna Earn, the Kamino farm and the vaults.",
      facts: [],
      tables: [{ columns: ["Product", "Deposit", "Yield", "How it earns", "Funded from"], rows }],
      note:
        "Each yield is in its own measure (Earn: APR; Kamino: live APY; Perena: its own 7-day APY; Basis: Phoenix funding, which is what the short is paid and not the vault's net yield), so they are not ranked here. None is guaranteed." +
        (asset && asset !== "USDC" ? " The vaults take USDC deposits." : ""),
      venue: "none",
    },
  };
}

async function readVaultPreview(r: Extract<ReadIntent, { kind: "vault_preview" }>, ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.vaultsPreview({ authority: ctx.user.wallet, vault: r.vault, call: r.call, amount: r.amount }, ctx);
  } catch (err) {
    return isNoAccount(err) ? noMargin("vault position") : unavailable(err, "a preview of that vault action");
  }
  const name = String(raw.name ?? r.vault);
  if (raw.needs_setup === true) {
    return {
      ok: true,
      fixedWording: true,
      data: { preview: raw },
      answer: {
        headline: `A preview of ${name} needs your wallet's one-time setup first.`,
        facts: [],
        note: "Ask to make the deposit or withdrawal: the plan signs the one-time setup (a lookup table) first, then the action, and shows the figures before you approve.",
        venue: "vaults",
      },
    };
  }
  const facts: AnswerFact[] = [
    fact(r.call === "deposit" ? "shares you'd receive" : "USDC you'd receive", `${String(raw.expected_out)} ${String(raw.out_token)}`),
    fact("minimum enforced", `${String(raw.minimum_out)} ${String(raw.out_token)}`),
    raw.health_factor_while_usdc_moves !== undefined
      ? fact("health factor while the USDC is out of margin", raw.health_factor_while_usdc_moves ? String(raw.health_factor_while_usdc_moves) : "no debt")
      : fact("health factor after", raw.health_factor_after ? String(raw.health_factor_after) : "no debt"),
  ];
  return {
    ok: true,
    data: { preview: raw },
    answer: {
      headline:
        r.call === "deposit"
          ? `Depositing ${r.amount} USDC into ${name} would give about ${String(raw.expected_out)} ${String(raw.out_token)}.`
          : `Withdrawing ${r.amount} ${name} shares would pay about ${String(raw.expected_out)} USDC.`,
      facts,
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
      venue: "vaults",
    },
  };
}

async function readPerpsPreview(r: Extract<ReadIntent, { kind: "perps_preview" }>, ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.perpsPreview({ authority: ctx.user.wallet, market: r.market, side: r.side, collateral_usdc: r.collateral, leverage: r.leverage }, ctx);
  } catch (err) {
    return isNoAccount(err) ? noMargin("perps position") : unavailable(err, "a preview of that order");
  }
  const name = String(raw.name ?? `${r.market}-PERP`);
  if (raw.allowed !== true) {
    return {
      ok: true,
      fixedWording: true,
      data: { preview: raw },
      answer: { headline: `That ${r.side} on ${name} wouldn't go through: ${String(raw.reason ?? "it was refused")}.`, facts: [], venue: "phoenix" },
    };
  }
  const facts: AnswerFact[] = [
    fact("size", `${String(raw.size)} ${r.market} (${px(raw.size_usd)})`),
    fact("collateral moved to Phoenix", raw.uses_existing_phoenix_balance === true ? "none (uses your Phoenix balance)" : `${String(raw.collateral_usdc)} USDC`),
    fact("limit price", px(raw.limit_price)),
    fact("open fee", px(raw.open_fee_usd)),
    fact("health factor after", raw.projected_health_factor ? String(raw.projected_health_factor) : "no debt"),
    fact("liquidation price after", raw.liquidation_price_after ? px(raw.liquidation_price_after) : "none"),
  ];
  const notes = Array.isArray(raw.notes) ? (raw.notes as unknown[]).map(String) : [];
  return {
    ok: true,
    data: { preview: raw },
    answer: {
      headline: `A ${r.leverage}x ${r.side} on ${name} with ${r.collateral} USDC would be about ${String(raw.size)} ${r.market} (${px(raw.size_usd)})${raw.reduced_to_fit_cap === true ? ", reduced to fit the market's leverage cap" : ""}.`,
      facts,
      note: [...notes, "Opening it here isn't available yet: place it on the Perps page."].join(" "),
      venue: "phoenix",
    },
  };
}

async function readPositions(ctx: ReadCtx): Promise<ReadOutcome> {
  const [healthR, walletR, farmR] = await Promise.allSettled([loadHealth(ctx), mcp.wallet(ctx.user.wallet, ctx), mcp.call("vanna_farm_overview", { action: "positions", authority: ctx.user.wallet }, ctx)]);
  const tables: NonNullable<StructuredAnswer["tables"]> = [];
  const facts: AnswerFact[] = [];
  const data: Record<string, unknown> = {};
  const gaps: string[] = [];

  if (healthR.status === "fulfilled" && healthR.value.kind === "ok") {
    const h = healthR.value.health;
    data.health = healthR.value.raw;
    facts.push(fact("health factor", fmtHf(h.hf), hfTone(h.hf)), fact("margin collateral", fmtUsd(h.collateralUsd)), fact("margin debt", fmtUsd(h.debtUsd)));
    // The Phoenix venue is one collateral holding of the margin, but it has no token amount: show it as its own card.
    const venueRows = phoenixRows(healthR.value.raw);
    const tokens = venueRows ? h.collateral.filter((r) => r.symbol !== "Phoenix") : h.collateral;
    if (tokens.length) tables.push(rowsTable("Margin collateral", tokens));
    if (venueRows) {
      facts.push(fact("Phoenix perps balance", fmtUsd(venueRows.valueUsd)));
      if (venueRows.positions.length) tables.push(perpsTable("Phoenix perps", venueRows.positions));
    }
    if (h.debt.length) tables.push(rowsTable("Debt", h.debt));
  } else if (healthR.status === "fulfilled" && healthR.value.kind === "no_account") {
    facts.push(fact("margin account", "not opened"));
  } else {
    gaps.push("margin account");
  }

  if (walletR.status === "fulfilled") {
    data.wallet = walletR.value;
    const assets = walletAssets(walletR.value);
    const sol = num(walletR.value.sol_balance);
    if (assets && sol !== null) {
      const held = assets.filter((a) => Number(a.wallet_balance) > 0);
      facts.push(fact("native SOL in wallet", fmtAmount(String(walletR.value.sol_balance), "SOL")));
      if (held.length) tables.push({ caption: "Wallet tokens", columns: ["Asset", "Balance"], rows: held.map((a) => [a.symbol, fmtAmount(a.wallet_balance)]) });
      const earn = assets.filter((a) => a.lender_redeemable_underlying !== null && Number(a.lender_redeemable_underlying) > 0);
      if (earn.length) tables.push({ caption: "Earn deposits", columns: ["Pool", "Shares", "Redeemable"], rows: earn.map((a) => [a.symbol, fmtAmount(a.lender_share_balance ?? "0"), fmtAmount(a.lender_redeemable_underlying ?? "0", a.symbol)]) });
    } else gaps.push("wallet");
  } else gaps.push("wallet");

  if (farmR.status === "fulfilled") {
    data.farm = farmR.value;
    const list = Array.isArray(farmR.value.positions) ? (farmR.value.positions as Array<Record<string, unknown>>) : [];
    if (list.length) {
      tables.push({
        caption: "Kamino farm",
        columns: ["Receipt", "Receipt amount", "Underlying"],
        rows: list.map((p) => [String(p.symbol), fmtAmount(String(p.receipt_balance)), fmtAmount(String(p.underlying_amount))]),
      });
    }
  } else if (!(farmR.reason instanceof MCPError && farmR.reason.code === "account_not_found")) {
    gaps.push("Kamino farm");
  }

  if (!tables.length && !facts.length) return unavailable(new Error("no position data came back"), "your positions");
  const headline = tables.length ? "Here are your current positions." : "You have no open positions yet.";
  return {
    ok: true,
    data,
    answer: { headline, facts, ...(tables.length ? { tables } : {}), ...(gaps.length ? { note: `I couldn't read: ${gaps.join(", ")}. Nothing is estimated in its place.` } : {}), venue: "none" },
  };
}

async function readPrices(assets: Asset[], ctx: ReadCtx): Promise<ReadOutcome> {
  const list = assets.length ? assets : [...PRODUCT_ASSETS];
  let raw: Record<string, unknown>;
  try {
    raw = list.length === 1 ? { [list[0]]: await mcp.price(list[0], ctx) } : await mcp.prices(list, ctx);
  } catch (err) {
    return unavailable(err, "prices");
  }
  const rows: string[][] = [];
  const facts: AnswerFact[] = [];
  let stale = 0;
  for (const a of list) {
    const p = raw[a];
    const usd = p && typeof p === "object" ? num((p as Record<string, unknown>).price_usd) : null;
    if (usd === null) {
      rows.push([a, "unavailable", "-"]);
      continue;
    }
    const isStale = (p as Record<string, unknown>).stale === true;
    if (isStale) stale++;
    rows.push([a, `$${usd.toLocaleString("en-US", { maximumFractionDigits: usd >= 10 ? 2 : 4 })}`, isStale ? "stale" : "live"]);
    facts.push(fact(`${a} price`, `$${usd.toLocaleString("en-US", { maximumFractionDigits: usd >= 10 ? 2 : 4 })}`, isStale ? "warn" : undefined));
  }
  const first = facts[0];
  return {
    ok: facts.length > 0,
    data: { prices: raw },
    answer: {
      headline: list.length === 1 && first ? `${list[0]} is ${first.value} on the Vanna oracle.` : "Here are the current oracle prices.",
      facts: list.length === 1 ? facts : [],
      ...(list.length > 1 ? { tables: [{ columns: ["Asset", "Price", "Status"], rows }] } : {}),
      ...(stale ? { note: "A price marked stale is older than the program allows; the program refuses to use it until it refreshes." } : {}),
      venue: "oracle",
    },
  };
}

async function readPools(assets: Asset[], ctx: ReadCtx): Promise<ReadOutcome> {
  const list = (assets.length ? assets : [...LEND_BORROW_ASSETS]).filter((a) => (LEND_BORROW_ASSETS as readonly string[]).includes(a));
  if (!list.length) {
    return { ok: true, fixedWording: true, data: {}, answer: { headline: `Only ${LEND_BORROW_ASSETS.join(", ")} have Vanna Earn pools. ${COLLATERAL_ONLY_ASSETS.join(", ")} can be margin collateral and swapped.`, facts: [], venue: "earn" } };
  }
  const settled = await Promise.allSettled(list.map((a) => mcp.poolStats(a, ctx)));
  const rows: string[][] = [];
  const data: Record<string, unknown> = {};
  const facts: AnswerFact[] = [];
  settled.forEach((s, i) => {
    const a = list[i];
    if (s.status !== "fulfilled") {
      rows.push([a, "unavailable", "-", "-", "-"]);
      return;
    }
    const p = s.value;
    data[a] = p;
    const supply = num(p.supply_apr_pct);
    const borrow = num(p.borrow_apr_pct);
    const util = num(p.utilization_rate_pct);
    rows.push([
      a,
      supply === null ? "-" : fmtPct(supply),
      borrow === null ? "-" : fmtPct(borrow),
      util === null ? "-" : fmtPct(util),
      typeof p.available_liquidity === "string" ? fmtAmount(p.available_liquidity, a) : "-",
    ]);
    if (supply !== null && list.length === 1) facts.push(fact(`${a} supply APR`, fmtPct(supply)), fact(`${a} borrow APR`, borrow === null ? "-" : fmtPct(borrow)), fact("utilization", util === null ? "-" : fmtPct(util)));
  });
  return {
    ok: Object.keys(data).length > 0,
    data,
    answer: {
      headline: list.length === 1 ? `The ${list[0]} Earn pool pays a ${rows[0][1]} supply APR.` : "Here are the Vanna Earn pool rates.",
      facts,
      ...(list.length > 1 ? { tables: [{ columns: ["Pool", "Supply APR", "Borrow APR", "Utilization", "Available"], rows }] } : {}),
      note: "Rates are APR (not compounded) and move with utilization.",
      venue: "earn",
    },
  };
}

async function readEarn(assets: Asset[], ctx: ReadCtx): Promise<ReadOutcome> {
  const list = (assets.length ? assets : [...LEND_BORROW_ASSETS]).filter((a) => (LEND_BORROW_ASSETS as readonly string[]).includes(a));
  const settled = await Promise.allSettled(list.map((a) => mcp.call("vanna_earn_position", { action: "earned_interest", owner: ctx.user.wallet, asset: a }, ctx)));
  const rows: string[][] = [];
  const data: Record<string, unknown> = {};
  let incomplete = false;
  settled.forEach((s, i) => {
    if (s.status !== "fulfilled") return;
    const p = s.value;
    data[list[i]] = p;
    if (p.complete === false) incomplete = true;
    rows.push([list[i], fmtAmount(String(p.redeemable_underlying), list[i]), fmtAmount(String(p.earned_interest), list[i])]);
  });
  if (!rows.length) return unavailable(settled.find((s) => s.status === "rejected") && (settled.find((s) => s.status === "rejected") as PromiseRejectedResult).reason, "your Earn balances");
  const held = rows.filter((r) => parseFloat(r[1].replace(/,/g, "")) > 0);
  return {
    ok: true,
    data,
    answer: {
      headline: held.length ? "Here is what you have supplied to the Vanna Earn pools." : "You have nothing supplied to the Vanna Earn pools.",
      facts: [],
      ...(held.length ? { tables: [{ columns: ["Pool", "Redeemable", "Interest earned"], rows }] } : {}),
      ...(incomplete && held.length ? { note: "Interest earned is computed from your recent on-chain history; older activity may not be included." } : {}),
      venue: "earn",
    },
  };
}

async function readFarmMarkets(ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.farmMarkets(ctx);
  } catch (err) {
    return unavailable(err, "the Kamino markets");
  }
  const markets = Array.isArray(raw.markets) ? (raw.markets as Array<Record<string, unknown>>) : [];
  if (!markets.length) return unavailable(new Error("no markets returned"), "the Kamino markets");
  return {
    ok: true,
    data: { markets: raw },
    answer: {
      headline: "Here are the Kamino farm markets you can supply to from your margin balance.",
      facts: [],
      tables: [
        {
          columns: ["Receipt", "Underlying", "Supply APY", "Kamino supply"],
          rows: markets.map((m) => [
            String(m.symbol),
            String(m.underlying),
            m.metrics_available === true && num(m.supply_apy_fraction) !== null ? fmtFractionPct(String(m.supply_apy_fraction)) : "unavailable",
            m.metrics_available === true && num(m.total_supply_usd) !== null ? fmtUsd(Number(m.total_supply_usd)) : "unavailable",
          ]),
        },
      ],
      note: "APY is Kamino's live rate for that reserve; it is not guaranteed.",
      venue: "kamino",
    },
  };
}

async function readFarmPositions(ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.call("vanna_farm_overview", { action: "positions", authority: ctx.user.wallet }, ctx);
  } catch (err) {
    return isNoAccount(err) ? noMargin("Kamino farm position") : unavailable(err, "your Kamino positions");
  }
  const list = Array.isArray(raw.positions) ? (raw.positions as Array<Record<string, unknown>>) : [];
  return {
    ok: true,
    data: { farm: raw },
    answer: {
      headline: list.length ? "Here are your Kamino farm positions." : "You have no Kamino farm positions.",
      facts: [],
      ...(list.length ? { tables: [{ columns: ["Receipt", "Receipt amount", "Underlying"], rows: list.map((p) => [String(p.symbol), fmtAmount(String(p.receipt_balance)), fmtAmount(String(p.underlying_amount))]) }] } : {}),
      venue: "kamino",
    },
  };
}

async function readCapacity(what: "borrow" | "withdraw", asset: Asset | null, ctx: ReadCtx): Promise<ReadOutcome> {
  const floor = copilotConfig.minHealthFactor;
  const h = await loadHealth(ctx);
  if (h.kind === "no_account") return noMargin(what === "borrow" ? "borrowing capacity" : "withdrawable collateral");
  if (h.kind !== "ok") return unavailable(h.kind === "unavailable" ? h.error : new Error("incomplete account data"), "your account");
  const targets: Asset[] = what === "borrow" ? (asset ? [asset] : [...LEND_BORROW_ASSETS]) : asset ? [asset] : (h.health.collateral.map((r) => r.symbol).filter((s): s is Asset => PRODUCT_ASSETS.includes(s)));
  if (!targets.length) return { ok: true, fixedWording: true, data: {}, answer: { headline: "You have no collateral to withdraw.", facts: [], venue: "margin" } };
  const sized = await Promise.all(targets.map((a) => (what === "borrow" ? sizeSafeBorrow(a, ctx, { hint: h }) : sizeSafeWithdraw(a, ctx, { hint: h }))));
  const rows: string[][] = [];
  const facts: AnswerFact[] = [];
  targets.forEach((a, i) => {
    const s = sized[i];
    if (s.ok) {
      rows.push([a, fmtAmount(s.amount, a), fmtUsd(s.usd), s.hfAfter === null ? "no debt" : s.hfAfter.toFixed(2)]);
      if (targets.length === 1) {
        facts.push(fact(`safe ${what} (HF >= ${floor.toFixed(2)})`, fmtAmount(s.amount, a)), fact("value", fmtUsd(s.usd)), fact("health factor after", fmtHf(s.hfAfter)));
        if (s.protocolMax) facts.push(fact(`protocol maximum (HF > ${LIQUIDATION_HF_TEXT})`, fmtAmount(s.protocolMax, a), "warn"));
      }
    } else rows.push([a, "none", "-", s.reason]);
  });
  const any = sized.find((s) => s.ok);
  const fail = sized.find((s) => !s.ok) as { ok: false; reason: string } | undefined;
  const one = targets.length === 1;
  return {
    ok: true,
    data: { health: h.raw, sized: sized.map((s, i) => ({ asset: targets[i], ...(s.ok ? { amount: s.amount, usd: s.usd, hf_after: s.hfAfter } : { reason: s.reason }) })) },
    answer: {
      headline: one
        ? any && any.ok
          ? `You can safely ${what} up to ${fmtAmount(any.amount, targets[0])} (${fmtUsd(any.usd)}) and stay at a ${floor.toFixed(2)} health factor or above.`
          : fail?.reason ?? "Nothing is available."
        : `Here is how much you can ${what} while keeping your health factor at ${floor.toFixed(2)} or above.`,
      facts,
      ...(one ? {} : { tables: [{ columns: ["Asset", "Safe amount", "Value", "HF after / note"], rows }] }),
      note: `Sized to the ${floor.toFixed(2)} safety floor, stricter than the protocol's ${LIQUIDATION_HF_TEXT} liquidation line, and checked against the program's own rules.`,
      venue: "margin",
    },
  };
}

/**
 * "Can I borrow 500 USDC?", "what will my HF be if I withdraw 1 SOL?", "how much to repay to reach HF 2?".
 * Borrow and withdraw go through the MCP's own can_borrow / can_withdraw (the program's rules); repay and
 * the target-HF cases are arithmetic on the MCP's collateral and debt figures and are labelled as such.
 */
async function readWhatIf(intent: Extract<ReadIntent, { kind: "whatif" }>, ctx: ReadCtx): Promise<ReadOutcome> {
  const { op, asset, amount, target_hf: target } = intent;
  const floor = copilotConfig.minHealthFactor;
  const h = await loadHealth(ctx);
  const subject = op === "borrow" ? "borrowing" : op === "withdraw" ? "withdrawing" : "repaying";
  if (h.kind === "no_account") return noMargin(subject);
  if (h.kind !== "ok") return unavailable(h.kind === "unavailable" ? h.error : new Error("incomplete account data"), "your account");
  const { collateralUsd: c, debtUsd: d } = h.health;
  const price = asset ? await loadFreshPrice(asset, ctx) : null;
  if (!asset || !price) return { ok: true, fixedWording: true, data: {}, answer: { headline: `The ${asset ?? "asset"} price is unavailable right now, so I can't work that out.`, facts: [], venue: "margin" } };
  const verdict = (hf: number | null): { tone: "good" | "warn" | "bad"; text: string } =>
    hf === null ? { tone: "good", text: "no debt, so no liquidation risk" } : hf < LIQUIDATION_HF ? { tone: "bad", text: `below the ${LIQUIDATION_HF_TEXT} liquidation line` } : hf < floor ? { tone: "warn", text: `above liquidation but under the ${floor.toFixed(2)} safety floor` } : { tone: "good", text: `at or above the ${floor.toFixed(2)} safety floor` };

  // Solve for an amount that reaches a target health factor.
  if (amount === null && target !== null) {
    if (op === "repay") {
      const needUsd = d - c / target;
      if (d === 0) return { ok: true, fixedWording: true, data: { health: h.raw }, answer: { headline: "You have no debt, so there is nothing to repay.", facts: [], venue: "margin" } };
      if (needUsd <= 0) return { ok: true, fixedWording: true, data: { health: h.raw }, answer: { headline: `Your health factor is already ${fmtHf(hfAfter(c, d))}, above ${target}.`, facts: [fact("health factor", fmtHf(hfAfter(c, d)), "good")], venue: "margin" } };
      const units = floorDecimals(needUsd / price.usd + 10 ** -tokenDecimals(asset), tokenDecimals(asset));
      return {
        ok: true,
        data: { health: h.raw, target },
        answer: {
          headline: `To bring your health factor above ${target}, repay about ${fmtAmount(units, asset)} (${fmtUsd(needUsd)}).`,
          facts: [fact("current health factor", fmtHf(hfAfter(c, d))), fact("debt now", fmtUsd(d)), fact("collateral", fmtUsd(c)), fact(`repay needed (${asset})`, fmtAmount(units, asset))],
          note: "Calculated from your current collateral and debt value and the health factor definition (collateral / debt). It is not a transaction.",
          venue: "margin",
        },
      };
    }
    if (op === "borrow") {
      const maxUsd = maxBorrowUsd(c, d, target, true);
      if (!(maxUsd > 0)) return { ok: true, fixedWording: true, data: { health: h.raw }, answer: { headline: `You can't borrow any ${asset} and stay at a ${target} health factor or above right now.`, facts: [fact("current health factor", fmtHf(hfAfter(c, d)))], venue: "margin" } };
      const units = floorDecimals(maxUsd / price.usd, tokenDecimals(asset));
      let checked = "";
      try {
        const can = readCan(await mcp.canBorrow({ authority: ctx.user.wallet, asset, amount: units }, ctx));
        if (can && typeof can.projectedHf === "number") checked = ` The program's own check projects a health factor of ${can.projectedHf.toFixed(2)}.`;
      } catch {
        /* the arithmetic answer stands on its own */
      }
      return {
        ok: true,
        data: { health: h.raw, target },
        answer: {
          headline: `You can borrow about ${fmtAmount(units, asset)} (${fmtUsd(maxUsd)}) and keep your health factor at ${target} or above.`,
          facts: [fact("health factor target", String(target)), fact("collateral", fmtUsd(c)), fact("debt now", fmtUsd(d))],
          note: `Calculated from your current collateral and debt value.${checked}`,
          venue: "margin",
        },
      };
    }
    return { ok: true, fixedWording: true, data: {}, answer: { headline: "Give me an amount to withdraw and I will check what your health factor would be.", facts: [], venue: "margin" } };
  }

  // A specific amount.
  const amt = amount as string;
  const usd = Number(amt) * price.usd;
  if (op === "repay") {
    const after = hfAfter(c, Math.max(d - usd, 0));
    const v = verdict(after);
    return {
      ok: true,
      data: { health: h.raw },
      answer: {
        headline: `If you repay ${fmtAmount(amt, asset)} (${fmtUsd(usd)}), your health factor would be about ${fmtHf(after)}.`,
        facts: [fact("health factor now", fmtHf(hfAfter(c, d))), fact("health factor after", fmtHf(after), v.tone), fact("debt after", fmtUsd(Math.max(d - usd, 0)))],
        note: "Calculated from your current collateral and debt value; it is not a transaction.",
        venue: "margin",
      },
    };
  }
  try {
    const can = readCan(await (op === "borrow" ? mcp.canBorrow({ authority: ctx.user.wallet, asset, amount: amt }, ctx) : mcp.canWithdraw({ authority: ctx.user.wallet, asset, amount: amt }, ctx)));
    if (!can) return unavailable(new Error("unreadable check result"), "that check");
    const hf = typeof can.projectedHf === "number" ? can.projectedHf : null;
    const v = verdict(hf);
    const ok = can.allowed && (hf === null || hf >= floor);
    const head = ok
      ? `Yes. ${op === "borrow" ? "Borrowing" : "Withdrawing"} ${fmtAmount(amt, asset)} (${fmtUsd(usd)}) would leave your health factor at ${fmtHf(hf)}, ${v.text}.`
      : can.allowed
        ? `${op === "borrow" ? "Borrowing" : "Withdrawing"} ${fmtAmount(amt, asset)} is allowed by the protocol but not advisable: your health factor would be ${fmtHf(hf)}, ${v.text}.`
        : `No. ${can.reason ?? "The protocol would not allow that."}`;
    return {
      ok: true,
      data: { health: h.raw, check: can },
      answer: {
        headline: head,
        facts: [fact("health factor now", fmtHf(hfAfter(c, d))), fact("health factor after", fmtHf(hf), v.tone), fact("liquidation at", LIQUIDATION_HF_TEXT)],
        note: "Checked with the protocol's own rules; this is a question, nothing was prepared. Say the action to prepare it for your approval.",
        venue: "margin",
      },
    };
  } catch (err) {
    return unavailable(err, "that check");
  }
}

async function readLiquidation(ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.call("vanna_margin_status", { action: "liquidation_snapshot", authority: ctx.user.wallet }, ctx);
  } catch (err) {
    return isNoAccount(err) ? noMargin("liquidation risk") : unavailable(err, "your liquidation status");
  }
  const hfRaw = raw.health_factor;
  const hf = hfRaw === null ? null : num(hfRaw);
  if (hfRaw !== null && hf === null) return unavailable(new Error("incomplete liquidation data"), "your liquidation status");
  const liquidatable = raw.health_at_or_below_threshold === true;
  const facts: AnswerFact[] = [fact("health factor", fmtHf(hf), hfTone(hf)), fact("liquidation at", LIQUIDATION_HF_TEXT), fact("debt", fmtUsd(Number(raw.total_debt_usd))), fact("collateral", fmtUsd(Number(raw.total_collateral_usd)))];
  let note = "This is a read-only check; the Copilot never executes a liquidation.";
  if (hf !== null && !liquidatable) note = `If the value of all your collateral fell together by about ${((1 - LIQUIDATION_HF / hf) * 100).toFixed(0)}%, your account would reach the liquidation line. ${note}`;
  return {
    ok: true,
    data: { snapshot: raw },
    answer: {
      headline: hf === null ? "You have no debt, so your account cannot be liquidated." : liquidatable ? `Your account is at or below the liquidation threshold (health factor ${hf.toFixed(2)}).` : `Your account is not liquidatable. Health factor ${hf.toFixed(2)}, liquidation at ${LIQUIDATION_HF_TEXT}.`,
      facts,
      note,
      venue: "margin",
    },
  };
}

async function readHistory(ctx: ReadCtx): Promise<ReadOutcome> {
  let raw: Record<string, unknown>;
  try {
    raw = await mcp.call("vanna_history", { action: "margin", authority: ctx.user.wallet, limit: 15 }, ctx);
  } catch (err) {
    return unavailable(err, "your history");
  }
  const events = Array.isArray(raw.events) ? (raw.events as Array<Record<string, unknown>>) : [];
  const when = (t: unknown): string => {
    const n = num(t);
    return n ? new Date(n * 1000).toISOString().slice(0, 16).replace("T", " ") : "-";
  };
  return {
    ok: true,
    data: { history: raw },
    answer: {
      headline: events.length ? `Here are your ${events.length} most recent margin events.` : "I found no margin activity for your wallet.",
      facts: [],
      ...(events.length
        ? { tables: [{ columns: ["When (UTC)", "Event", "Asset", "Amount"], rows: events.slice(0, 15).map((e) => [when(e.timestamp), String(e.event), String(e.asset ?? "-"), e.amount != null ? fmtAmount(String(e.amount)) : "-"]) }] }
        : {}),
      ...(raw.complete === false ? { note: "History is decoded from recent transactions only; older events may exist." } : {}),
      venue: "margin",
    },
  };
}

async function readProtocol(ctx: ReadCtx): Promise<ReadOutcome> {
  const [cfg, assets, integ] = await Promise.allSettled([mcp.protocolInfo("config", ctx), mcp.protocolInfo("assets", ctx), mcp.protocolInfo("integrations", ctx)]);
  if (cfg.status !== "fulfilled" || assets.status !== "fulfilled") return unavailable(cfg.status === "rejected" ? cfg.reason : (assets as PromiseRejectedResult).reason, "protocol information");
  const offered = (Array.isArray(assets.value.assets) ? (assets.value.assets as Array<Record<string, unknown>>) : []).filter((a) => PRODUCT_ASSETS.includes(String(a.symbol)));
  const integrations = integ.status === "fulfilled" && Array.isArray(integ.value.integrations) ? (integ.value.integrations as Array<Record<string, unknown>>) : [];
  return {
    ok: true,
    data: { config: cfg.value, assets: assets.value, integrations: integ.status === "fulfilled" ? integ.value : {} },
    answer: {
      headline: `The protocol is in ${String(cfg.value.operating_mode)} mode (${String(cfg.value.operating_mode_blocks)}).`,
      facts: [fact("max assets per margin account", String(cfg.value.max_assets_per_margin)), fact("liquidation at", LIQUIDATION_HF_TEXT), fact("Copilot safety floor", copilotConfig.minHealthFactor.toFixed(2))],
      tables: [
        { caption: "Assets", columns: ["Asset", "Lend / borrow", "Collateral", "Pool"], rows: offered.map((a) => [String(a.symbol), a.lend_borrow_offered === true ? "yes" : "no", a.collateral_enabled === true ? "yes" : "no", String(a.reserve_status)]) },
        ...(integrations.length ? [{ caption: "Integrations", columns: ["Adapter", "Enabled"], rows: integrations.map((i) => [String(i.adapter), i.enabled === true ? "yes" : "no"]) }] : []),
      ],
      venue: "none",
    },
  };
}

async function readQuote(from: Asset, to: Asset, amount: string, ctx: ReadCtx): Promise<ReadOutcome> {
  let q: Record<string, unknown>;
  try {
    q = await mcp.swapQuote({ from_asset: from, to_asset: to, amount }, ctx);
  } catch (err) {
    return unavailable(err, "a swap quote");
  }
  if (num(q.out_amount) === null) return unavailable(new Error("the quote was incomplete"), "a swap quote");
  const impact = num(q.price_impact_pct);
  return {
    ok: true,
    data: { quote: q },
    answer: {
      headline: `${fmtAmount(amount, from)} would swap to about ${fmtAmount(String(q.out_amount), to)} through Jupiter.`,
      facts: [
        fact("you send", fmtAmount(String(q.in_amount), from)),
        fact("you receive (estimate)", fmtAmount(String(q.out_amount), to)),
        fact("minimum received", fmtAmount(String(q.min_out_amount), to)),
        ...(impact !== null ? [fact("price impact (as reported by Jupiter)", String(q.price_impact_pct))] : []),
        fact("slippage limit", `${(Number(q.slippage_bps) / 100).toFixed(2)}%`),
        ...(Array.isArray(q.route) && q.route.length ? [fact("route", q.route.map(String).join(" > "))] : []),
      ],
      note: "This is a quote only; nothing was built or sent.",
      venue: "jupiter",
    },
  };
}
