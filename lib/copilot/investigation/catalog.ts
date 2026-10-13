/**
 * Stage 2 read surface: the tools Gemini may call while it investigates a request.
 *
 * Every tool is backed by the Vanna Solana MCP through the same readers the deterministic answers use
 * (`mcp-facts.ts`), or by the protocol maths in `risk.ts` on MCP figures. None of them writes. The wallet is bound
 * here from the signed session (`ctx.user`), never taken from model arguments, so a read cannot be pointed at
 * someone else's account.
 */

import { copilotConfig } from "../config";
import { LEND_BORROW_ASSETS, PERP_MARKETS, PREDICT_CATEGORIES, PREDICT_MAX_LEGS, PRODUCT_ASSETS, VAULT_IDS, isMarketId, normalizeAsset, parseDecimalString, perpMarketOf, vaultOf, type Asset, type ConceptTopic, type PredictCategory, type ReadIntent } from "../intent";
import { mcp } from "../mcp-client";
import { loadFreshPrice, loadHealth, runRead, type ReadCtx } from "../mcp-facts";
import { DEFAULT_SLIPPAGE_BPS, maxLeverage, sizeLever } from "../risk";
import type { LlmFunctionDecl } from "../vertex";
import { SIM_OPS, simulate, simulateArgsProblem } from "./simulate";
import { sharedRead } from "./read-cache";

const ASSETS = [...PRODUCT_ASSETS] as string[];
const LEND_ASSETS = [...LEND_BORROW_ASSETS] as string[];
const TOPICS: ConceptTopic[] = ["health_factor", "liquidation", "leverage", "collateral", "earn", "farm", "margin", "general"];

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "OBJECT", properties, ...(required.length ? { required } : {}) });
const assetList = (enumValues: string[], description: string) => ({ type: "ARRAY", items: { type: "STRING", enum: enumValues }, description });

export const READ_TOOLS: LlmFunctionDecl[] = [
  { name: "get_account_health", description: "The user's margin account: health factor, total collateral and debt in USD, each collateral and debt position with its oracle price, liquidation status. Says when the user has no margin account." },
  { name: "get_positions", description: "Everything the user holds in Vanna: margin collateral and debt, Earn pool deposits, Kamino farm receipts." },
  { name: "get_wallet_balances", description: `The user's wallet token balances (${PRODUCT_ASSETS.join(", ")}) and Earn shares. Use before planning anything that spends from the wallet.` },
  { name: "get_prices", description: "Oracle USD prices the protocol itself uses.", parameters: obj({ assets: assetList(ASSETS, "Assets to price.") }, ["assets"]) },
  { name: "get_pool_rates", description: "Vanna Earn / borrow pool figures per asset: supply APR, borrow APR, utilization, liquidity available to borrow.", parameters: obj({ assets: assetList(LEND_ASSETS, "Pools to read.") }, ["assets"]) },
  { name: "get_earn_positions", description: "The user's Earn pool deposits: shares and the amount redeemable now, per pool. Fast.", parameters: obj({ assets: assetList(LEND_ASSETS, "Pools; empty means all.") }) },
  { name: "get_earn_interest", description: "Interest earned on Earn deposits, reconstructed from the user's on-chain history. Slow: only when the user asks what they earned.", parameters: obj({ assets: assetList(LEND_ASSETS, "Pools; empty means all.") }) },
  { name: "get_kamino_markets", description: "Kamino lend markets the farm supplies into: APYs and limits." },
  { name: "get_kamino_positions", description: "The user's Kamino farm receipts (kSOL, kUSDC, ...) and their underlying worth." },
  {
    name: "get_capacity",
    description: `The largest SAFE borrow or collateral withdrawal per asset that keeps the health factor at or above the ${copilotConfig.minHealthFactor.toFixed(2)} floor, verified with the program's own check. Use for "how much can I borrow / withdraw".`,
    parameters: obj({ what: { type: "STRING", enum: ["borrow", "withdraw"] }, asset: { type: "STRING", enum: ASSETS, description: "Optional; omit for every asset." } }, ["what"]),
  },
  {
    name: "what_if",
    description: "Projected health factor if the user borrowed, withdrew or repaid an amount, or the amount needed to reach a target health factor. Nothing is built.",
    parameters: obj({
      op: { type: "STRING", enum: ["borrow", "withdraw", "repay"] },
      asset: { type: "STRING", enum: ASSETS },
      amount: { type: "STRING", description: "Decimal amount to test (omit when asking for target_hf)." },
      target_hf: { type: "NUMBER", description: "Health factor to reach (omit when testing an amount)." },
    }, ["op", "asset"]),
  },
  {
    name: "get_leverage_capacity",
    description: "For a leveraged long on one asset (borrow a stable, swap it into the asset inside the margin account): the highest multiple that holds the health floor even at the swap's worst price, and the worst-case health factor at common multiples.",
    parameters: obj({
      asset: { type: "STRING", enum: ASSETS, description: "Asset to go long." },
      amount: { type: "STRING", description: "Units of the asset the leverage is on (omit = what is already in the margin account)." },
    }, ["asset"]),
  },
  { name: "get_liquidation_risk", description: "Whether the account is liquidatable and how far prices can fall before it is." },
  {
    name: "simulate",
    description:
      "The account's health under any scenario: price moves on any assets (\"SOL drops 10%\": percent -10), hypothetical changes (deposit, withdraw, borrow, repay, swap, farm), or both; changes apply in order, then the price moves. Returns collateral, debt and health factor now, after the changes and after the price moves, whether it would be liquidatable or below the Copilot floor, and how far each moved asset could fall (or rise) before liquidation. Uses the protocol's health maths on live oracle prices; nothing is built. Liquid-staking tokens (JitoSOL, JupSOL) have their own prices: move them too if the user means SOL in general. Inside a plan, a report leg with simulate runs on the account after the earlier steps, so its changes list only what has not happened yet.",
    parameters: obj({
      price_changes: { type: "ARRAY", items: obj({ asset: { type: "STRING", enum: ASSETS }, percent: { type: "NUMBER", description: "-10 = falls 10%, 25 = rises 25%." } }, ["asset", "percent"]), description: "Price moves to apply." },
      changes: {
        type: "ARRAY",
        items: obj({
          op: { type: "STRING", enum: [...SIM_OPS] },
          asset: { type: "STRING", enum: ASSETS },
          to_asset: { type: "STRING", enum: ASSETS, description: "swap only." },
          amount: { type: "STRING", description: "Token units, or \"all\"." },
          usd: { type: "STRING", description: "A dollar value instead of units." },
          source: { type: "STRING", enum: ["wallet", "margin"], description: "repay only: margin = paid from the margin balance." },
        }, ["op", "asset"]),
        description: "Hypothetical position changes, in order.",
      },
    }),
  },
  {
    name: "get_swap_quote",
    description: "A live swap quote (the better of Jupiter and Titan): output amount and minimum received at the default slippage.",
    parameters: obj({ from: { type: "STRING", enum: ASSETS }, to: { type: "STRING", enum: ASSETS }, amount: { type: "STRING", description: "Decimal amount of `from`." } }, ["from", "to", "amount"]),
  },
  { name: "get_history", description: "The user's recent Vanna transactions." },
  { name: "get_perps_markets", description: "Phoenix perps markets (SOL, ETH, BTC, TSLA, META): index and mark price, max leverage, whether each is open, taker fee." },
  { name: "get_perps_positions", description: "The user's Phoenix perps positions (side, size, entry, PnL, funding, liquidation price) and their Phoenix balance. Perps never borrow from Vanna." },
  {
    name: "preview_perp_order",
    description: "What opening or adding to a Phoenix perps position would do: size, limit price, fee, health factor and liquidation price after. Nothing is built.",
    parameters: obj(
      {
        market: { type: "STRING", enum: [...PERP_MARKETS] },
        side: { type: "STRING", enum: ["long", "short"] },
        collateral_usdc: { type: "STRING", description: "USDC from the margin account backing the order; \"0\" = the Phoenix balance already there." },
        leverage: { type: "NUMBER", description: "1 up to the market's max leverage." },
      },
      ["market", "side", "collateral_usdc", "leverage"],
    ),
  },
  {
    name: "compare_yield",
    description: "Every way to earn on an asset, side by side: Vanna Earn (APR, from the wallet), the Kamino farm (live APY, from the margin balance) and the Basis / Perena vaults (USDC; Perena's own 7-day APY, Phoenix funding for Basis, or the app's vault APY when it has one: share-price history, or an approximate deposit-based estimate, labelled as such). Use it when the user asks for yield without naming a product, then ask which.",
    parameters: obj({ asset: { type: "STRING", enum: [...PRODUCT_ASSETS], description: "The asset the user wants to earn on, if named." } }, []),
  },
  { name: "get_vaults", description: "Basis (delta-neutral SOL/ETH/BTC/TSLA/META) and Perena (USD*, USD* Junior) vaults: share price, TVL, whether deposits are open, and each one's yield with its source (Perena's 7-day APY; Phoenix funding for Basis; the app's vault APY when it has one, from share-price history or an approximate deposit-based estimate, said as such). Never estimate one yourself." },
  { name: "get_vault_positions", description: "The user's vault shares (in the margin account as collateral, or SOL Basis shares still in the wallet) and their value." },
  {
    name: "preview_vault",
    description: "What a vault deposit (USDC) or withdrawal (shares) would do, simulated: shares or USDC out, the minimum enforced, health factor after. Nothing is built.",
    parameters: obj(
      {
        vault: { type: "STRING", enum: [...VAULT_IDS] },
        call: { type: "STRING", enum: ["deposit", "withdraw"] },
        amount: { type: "STRING", description: "USDC for a deposit, shares for a withdrawal (the user's exact decimal)." },
      },
      ["vault", "call", "amount"],
    ),
  },
  {
    name: "get_predict_markets",
    description: "Predict (World.xyz prediction markets, on the test network): listed events with every outcome's market_id and its YES / NO buy and sell prices in cents (a share pays 1 CASH if that outcome wins), whether it is tradable, and whether a buy joins Vanna's pool. Search with query (team, candidate, asset, league) and/or a category. The only source of market_ids for a Predict trade.",
    parameters: obj({ category: { type: "STRING", enum: [...PREDICT_CATEGORIES] }, query: { type: "STRING", description: "Search words from the user's message, e.g. \"barcelona\", \"senate\", \"nfl\"." } }),
  },
  {
    name: "get_predict_market",
    description: "One Predict event with every outcome (market_id, YES / NO buy and sell prices in cents, tradable), its pool figures and its rules. id = an event_id or market_id from get_predict_markets.",
    parameters: obj({ id: { type: "STRING", description: "event_id or market_id from get_predict_markets." } }, ["id"]),
  },
  { name: "get_predict_positions", description: "The user's Predict positions (shares in the wallet and in Vanna's pool, average and current price, value, P&L, what each pays if it wins), the wallet's CASH, Vanna pool figures, and World shares in the wallet that can move into Vanna's pool. Predict is wallet-only: it never affects the health factor." },
  { name: "get_predict_history", description: "The user's Predict trades (buys and sells), optionally for one market_id.", parameters: obj({ market: { type: "STRING", description: "Optional market_id." } }) },
  {
    name: "get_predict_quote",
    description: "What a Predict trade would do at the live price, nothing built: for each leg the shares or CASH out, price in cents, what it pays if it wins, and shares that join Vanna's pool. buy amount = CASH; sell / deposit amount = shares.",
    parameters: obj({
      legs: {
        type: "ARRAY",
        items: obj({
          market: { type: "STRING", description: "market_id from get_predict_markets." },
          outcome: { type: "STRING", enum: ["yes", "no"] },
          side: { type: "STRING", enum: ["buy", "sell", "deposit"] },
          amount: { type: "STRING", description: "The user's exact decimal: CASH for a buy, shares for a sell / deposit." },
        }, ["market", "outcome", "side", "amount"]),
      },
    }, ["legs"]),
  },
  { name: "get_protocol_info", description: "On-chain protocol configuration: operating mode, which assets can be lent, borrowed or used as collateral, integrations." },
  { name: "explain_concept", description: "The product's own explanation of a concept, for questions about how something works.", parameters: obj({ topic: { type: "STRING", enum: TOPICS } }, ["topic"]) },
];

export const READ_TOOL_NAMES = new Set(READ_TOOLS.map((t) => t.name));

/** Reads that scan on-chain history get more time than the default. */
export const SLOW_READS: Record<string, number> = { get_earn_interest: 30_000, get_history: 25_000, get_vaults: 25_000, get_predict_markets: 45_000, get_predict_market: 45_000, get_predict_positions: 45_000, get_predict_history: 30_000, get_predict_quote: 45_000 };

/** A Predict quote's legs from model arguments, or null when any is unusable. */
function predictLegsArg(v: unknown): Array<{ market: string; outcome: "yes" | "no"; side: "buy" | "sell" | "deposit"; amount: string }> | null {
  if (!Array.isArray(v) || !v.length || v.length > PREDICT_MAX_LEGS) return null;
  const out = [];
  for (const l of v) {
    if (!l || typeof l !== "object") return null;
    const o = l as Record<string, unknown>;
    const amount = typeof o.amount === "string" ? parseDecimalString(o.amount.trim()) : typeof o.amount === "number" ? parseDecimalString(String(o.amount)) : null;
    const side = o.side === "sell" || o.side === "deposit" ? o.side : o.side === "buy" || o.side === undefined ? "buy" : null;
    if (!isMarketId(o.market) || (o.outcome !== "yes" && o.outcome !== "no") || !side || !amount) return null;
    out.push({ market: o.market, outcome: o.outcome, side, amount } as const);
  }
  return out;
}

const assetsArg = (v: unknown, allowed: readonly string[]): Asset[] =>
  (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? normalizeAsset(x) : null)).filter((a): a is Asset => !!a && allowed.includes(a));
const assetArg = (v: unknown): Asset | null => (typeof v === "string" ? normalizeAsset(v) : null);
const decimalArg = (v: unknown): string | null => (typeof v === "string" ? parseDecimalString(v.trim()) : typeof v === "number" ? parseDecimalString(String(v)) : null);

export type ReadOutput = { ok: boolean; result: unknown };

/**
 * Larger observation budgets for reads whose rows the model must be able to quote exactly: a Predict market list carries
 * every outcome's market_id, which a trade has to use as written (a truncated list would hide some).
 */
export const OBSERVATION_CHARS: Record<string, number> = { get_predict_markets: 14_000, get_predict_market: 10_000, get_predict_positions: 10_000 };

/** Predict events as the model reads them: one row per outcome, the market_id first, prices in cents per share. */
function predictEventsForModel(events: unknown): unknown {
  return (Array.isArray(events) ? events : []).map((e: Record<string, unknown>) => ({
    event_id: e.event_id,
    title: e.title,
    ...(e.league ? { league: e.league } : {}),
    ...(e.ends ? { ends: e.ends } : {}),
    ...(e.one_outcome_wins === true ? { one_outcome_wins: true } : {}),
    outcomes: (Array.isArray(e.outcomes) ? e.outcomes : []).map((o: Record<string, unknown>) => [
      o.market_id,
      o.name,
      o.yes_label && o.yes_label !== "Yes" ? `${o.yes_label}/${o.no_label}` : undefined,
      o.yes_buy_cents ?? null,
      o.yes_sell_cents ?? null,
      o.no_buy_cents ?? null,
      o.no_sell_cents ?? null,
      o.tradable === true ? 1 : 0,
      o.joins_vanna_pool === true ? 1 : 0,
    ].filter((x) => x !== undefined)),
  }));
}

const PREDICT_COLUMNS = "outcomes rows: [market_id, name, (custom YES/NO labels when not Yes/No), yes_buy_cents, yes_sell_cents, no_buy_cents, no_sell_cents, tradable 1/0, joins_vanna_pool 1/0]. A share pays 1 CASH if its outcome wins.";

async function predictRead(read: ReadIntent, key: string, ctx: ReadCtx): Promise<ReadOutput> {
  const out = await runRead(read, ctx);
  if (!out.ok) return { ok: false, result: { summary: out.answer.headline, note: out.answer.note } };
  const raw = (out.data[key] ?? {}) as Record<string, unknown>;
  if (key === "predict_markets") return { ok: true, result: { summary: out.answer.headline, columns: PREDICT_COLUMNS, events: predictEventsForModel(raw.events), note: out.answer.note } };
  const e = (raw.event ?? {}) as Record<string, unknown>;
  return { ok: true, result: { summary: out.answer.headline, columns: PREDICT_COLUMNS, event: { ...(predictEventsForModel([e]) as unknown[])[0] as object, rules: e.rules }, facts: out.answer.facts, note: out.answer.note } };
}

/**
 * Why these arguments can't run this read tool, or null when they can. The same checks `executeRead` applies, done up
 * front for a read the model puts inside a plan (it runs later, when nobody can correct it).
 */
export function readArgsProblem(tool: string, args: Record<string, unknown>): string | null {
  if (!READ_TOOL_NAMES.has(tool)) return `unknown read tool ${tool}`;
  switch (tool) {
    case "get_prices":
      return assetsArg(args.assets, ASSETS).length ? null : "get_prices needs at least one product asset in assets";
    case "what_if":
      return assetArg(args.asset) && (decimalArg(args.amount) || (typeof args.target_hf === "number" && args.target_hf > 1)) ? null : "what_if needs an asset and either an amount or a target_hf";
    case "get_leverage_capacity":
      return assetArg(args.asset) ? null : "get_leverage_capacity needs a product asset";
    case "get_swap_quote": {
      const from = assetArg(args.from);
      const to = assetArg(args.to);
      return from && to && from !== to && decimalArg(args.amount) ? null : "get_swap_quote needs two different product assets and a decimal amount";
    }
    case "simulate":
      return simulateArgsProblem(args);
    case "get_predict_market":
      return typeof args.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(args.id.trim()) ? null : "get_predict_market needs an event_id or market_id";
    case "get_predict_quote":
      return predictLegsArg(args.legs) ? null : "get_predict_quote needs 1-8 legs, each with a market_id, yes or no, buy / sell / deposit and a decimal amount";
    default:
      return null;
  }
}

async function viaRead(read: ReadIntent, ctx: ReadCtx): Promise<ReadOutput> {
  const out = await runRead(read, ctx);
  return { ok: out.ok, result: { summary: out.answer.headline, facts: out.answer.facts, tables: out.answer.tables ?? (out.answer.table ? [out.answer.table] : undefined), note: out.answer.note, data: out.data } };
}

async function leverageCapacity(asset: Asset, amount: string | null, ctx: ReadCtx): Promise<ReadOutput> {
  const floor = copilotConfig.minHealthFactor;
  const [h, p] = await Promise.all([loadHealth(ctx), loadFreshPrice(asset, ctx)]);
  if (h.kind === "unavailable" || h.kind === "malformed") return { ok: false, result: { error: "account data unavailable" } };
  if (!p) return { ok: false, result: { error: `${asset} price unavailable` } };
  const health = h.kind === "ok" ? h.health : null;
  const marginUnits = health?.collateral.find((r) => r.symbol === asset)?.units ?? 0;
  const equityUnits = amount ? Number(amount) : marginUnits;
  if (!(equityUnits > 0)) return { ok: true, result: { asset, note: `No ${asset} in the margin account; give an amount to size a deposit-and-lever.`, margin_units: marginUnits } };
  const depositUnits = Math.max(0, equityUnits - marginUnits);
  const args = { collateralUsd: health?.collateralUsd ?? 0, debtUsd: health?.debtUsd ?? 0, equityUsd: equityUnits * p.usd, depositUsd: depositUnits * p.usd, floor };
  const best = maxLeverage({ ...args, slippageBps: DEFAULT_SLIPPAGE_BPS });
  const table = [1.5, 2, 2.5, 3, 4, 5].map((n) => {
    const s = sizeLever({ ...args, leverage: n });
    return s.ok ? { multiple: n, borrow_usd: Number(s.borrowUsd.toFixed(2)), worst_case_hf: Number(s.hfAfter.toFixed(4)), holds_floor: true } : { multiple: n, holds_floor: false };
  });
  return {
    ok: true,
    result: {
      asset, price_usd: p.usd, equity_units: equityUnits, deposit_needed_units: depositUnits, health_floor: floor, slippage_bps: DEFAULT_SLIPPAGE_BPS,
      max_leverage_at_floor: Number((Math.floor(best * 100) / 100).toFixed(2)), table,
    },
  };
}

/** Earn deposits from `deposited_balance` (one read per pool, in parallel): no history scan, so it answers in about a second. */
async function earnBalances(assets: Asset[], ctx: ReadCtx): Promise<ReadOutput> {
  const list = assets.length ? assets : [...LEND_BORROW_ASSETS];
  const settled = await Promise.allSettled(list.map((a) => mcp.earnPosition(ctx.user.wallet, a, ctx)));
  const pools: Record<string, unknown> = {};
  settled.forEach((s, i) => {
    pools[list[i]] = s.status === "fulfilled" ? s.value : { error: "unavailable" };
  });
  return { ok: settled.some((s) => s.status === "fulfilled"), result: { pools } };
}

/**
 * Run one read the model asked for. Unknown tools and bad arguments come back as an error the model can see. Every read
 * goes through the shared layer (`read-cache.ts`): one already running is joined, a recent success is reused.
 */
export function executeRead(tool: string, args: Record<string, unknown>, ctx: ReadCtx): Promise<ReadOutput> {
  return sharedRead(ctx.user.wallet, tool, args, () => readNow(tool, args, ctx));
}

async function readNow(tool: string, args: Record<string, unknown>, ctx: ReadCtx): Promise<ReadOutput> {
  switch (tool) {
    case "get_account_health":
      return viaRead({ kind: "health" }, ctx);
    case "get_positions":
      return viaRead({ kind: "positions" }, ctx);
    case "get_wallet_balances":
      return viaRead({ kind: "wallet" }, ctx);
    case "get_prices": {
      const assets = assetsArg(args.assets, ASSETS);
      return assets.length ? viaRead({ kind: "price", assets }, ctx) : { ok: false, result: { error: "name at least one product asset" } };
    }
    case "get_pool_rates": {
      const assets = assetsArg(args.assets, LEND_ASSETS);
      return viaRead({ kind: "pool", assets: assets.length ? assets : [...LEND_BORROW_ASSETS] }, ctx);
    }
    case "get_earn_positions":
      return earnBalances(assetsArg(args.assets, LEND_ASSETS), ctx);
    case "get_earn_interest":
      return viaRead({ kind: "earn_position", assets: assetsArg(args.assets, LEND_ASSETS) }, ctx);
    case "get_kamino_markets":
      return viaRead({ kind: "farm_markets" }, ctx);
    case "get_perps_markets":
      return viaRead({ kind: "perps_markets" }, ctx);
    case "get_perps_positions":
      return viaRead({ kind: "perps_positions" }, ctx);
    case "preview_perp_order": {
      const market = perpMarketOf(args.market);
      const side = args.side === "long" || args.side === "short" ? args.side : null;
      const collateral = typeof args.collateral_usdc === "string" ? args.collateral_usdc.trim() : typeof args.collateral_usdc === "number" ? String(args.collateral_usdc) : null;
      const leverage = typeof args.leverage === "number" ? args.leverage : Number(args.leverage);
      if (!market || !side || !collateral || !(leverage >= 1)) return { ok: false, result: { error: "a preview needs market, side, collateral_usdc and leverage >= 1" } };
      return viaRead({ kind: "perps_preview", market, side, collateral, leverage }, ctx);
    }
    case "compare_yield": {
      const asset = typeof args.asset === "string" ? normalizeAsset(args.asset) : null;
      return viaRead({ kind: "yield_options", asset }, ctx);
    }
    case "get_vaults":
      return viaRead({ kind: "vaults_list" }, ctx);
    case "get_vault_positions":
      return viaRead({ kind: "vaults_positions" }, ctx);
    case "preview_vault": {
      const vault = vaultOf(args.vault);
      const call = args.call === "deposit" || args.call === "withdraw" ? args.call : null;
      const amount = typeof args.amount === "string" ? args.amount.trim() : typeof args.amount === "number" ? String(args.amount) : null;
      if (!vault || !call || !amount || parseDecimalString(amount) === null) return { ok: false, result: { error: "a vault preview needs vault, call (deposit or withdraw) and a decimal amount" } };
      return viaRead({ kind: "vault_preview", vault, call, amount }, ctx);
    }
    case "get_kamino_positions":
      return viaRead({ kind: "farm_positions" }, ctx);
    case "get_predict_markets": {
      const category = (PREDICT_CATEGORIES as readonly string[]).includes(String(args.category)) ? (args.category as PredictCategory) : null;
      const query = typeof args.query === "string" && args.query.trim() ? args.query.trim().slice(0, 80) : null;
      return predictRead({ kind: "predict_markets", category, query }, "predict_markets", ctx);
    }
    case "get_predict_market": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, result: { error: "give an event_id or market_id from get_predict_markets" } };
      return predictRead({ kind: "predict_market", id }, "predict_market", ctx);
    }
    case "get_predict_positions":
      return viaRead({ kind: "predict_positions" }, ctx);
    case "get_predict_history":
      return viaRead({ kind: "predict_history", market: isMarketId(args.market) ? args.market : null }, ctx);
    case "get_predict_quote": {
      const legs = predictLegsArg(args.legs);
      if (!legs) return { ok: false, result: { error: "a quote needs 1-8 legs, each with a market_id, yes or no, buy / sell / deposit and a decimal amount" } };
      return viaRead({ kind: "predict_quote", legs }, ctx);
    }
    case "get_capacity":
      return viaRead({ kind: "capacity", what: args.what === "withdraw" ? "withdraw" : "borrow", asset: assetArg(args.asset) }, ctx);
    case "what_if": {
      const op = args.op === "withdraw" || args.op === "repay" ? args.op : "borrow";
      const asset = assetArg(args.asset);
      const amount = decimalArg(args.amount);
      const target = typeof args.target_hf === "number" && args.target_hf > 1 ? args.target_hf : null;
      if (!asset || (!amount && !target)) return { ok: false, result: { error: "what_if needs an asset and either an amount or a target_hf" } };
      return viaRead({ kind: "whatif", op, asset, amount, target_hf: target }, ctx);
    }
    case "get_leverage_capacity": {
      const asset = assetArg(args.asset);
      if (!asset) return { ok: false, result: { error: "name a product asset" } };
      return leverageCapacity(asset, decimalArg(args.amount), ctx);
    }
    case "get_liquidation_risk":
      return viaRead({ kind: "liquidation_risk" }, ctx);
    case "simulate":
      return simulate(args, ctx);
    case "get_swap_quote": {
      const from = assetArg(args.from);
      const to = assetArg(args.to);
      const amount = decimalArg(args.amount);
      if (!from || !to || !amount || from === to) return { ok: false, result: { error: "a quote needs two different product assets and a decimal amount" } };
      return viaRead({ kind: "quote", from, to, amount }, ctx);
    }
    case "get_history":
      return viaRead({ kind: "history" }, ctx);
    case "get_protocol_info":
      return viaRead({ kind: "protocol" }, ctx);
    case "explain_concept": {
      const topic = TOPICS.includes(args.topic as ConceptTopic) ? (args.topic as ConceptTopic) : "general";
      return viaRead({ kind: "concept", topic }, ctx);
    }
    default:
      return { ok: false, result: { error: `unknown tool ${tool}` } };
  }
}
