/**
 * Stage 2 read surface: the tools Gemini may call while it investigates a request.
 *
 * Every tool is backed by the Vanna Solana MCP through the same readers the deterministic answers use
 * (`mcp-facts.ts`), or by the protocol maths in `risk.ts` on MCP figures. None of them writes. The wallet is bound
 * here from the signed session (`ctx.user`), never taken from model arguments, so a read cannot be pointed at
 * someone else's account.
 */

import { copilotConfig } from "../config";
import { LEND_BORROW_ASSETS, PRODUCT_ASSETS, normalizeAsset, parseDecimalString, perpMarketOf, type Asset, type ConceptTopic, type ReadIntent } from "../intent";
import { mcp } from "../mcp-client";
import { loadFreshPrice, loadHealth, runRead, type ReadCtx } from "../mcp-facts";
import { DEFAULT_SLIPPAGE_BPS, maxLeverage, sizeLever } from "../risk";
import type { LlmFunctionDecl } from "../vertex";
import { SIM_OPS, simulate, simulateArgsProblem } from "./simulate";

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
        market: { type: "STRING", enum: ["SOL", "ETH", "BTC", "TSLA", "META"] },
        side: { type: "STRING", enum: ["long", "short"] },
        collateral_usdc: { type: "STRING", description: "USDC from the margin account backing the order; \"0\" = the Phoenix balance already there." },
        leverage: { type: "NUMBER", description: "1 up to the market's max leverage." },
      },
      ["market", "side", "collateral_usdc", "leverage"],
    ),
  },
  { name: "get_protocol_info", description: "On-chain protocol configuration: operating mode, which assets can be lent, borrowed or used as collateral, integrations." },
  { name: "explain_concept", description: "The product's own explanation of a concept, for questions about how something works.", parameters: obj({ topic: { type: "STRING", enum: TOPICS } }, ["topic"]) },
];

export const READ_TOOL_NAMES = new Set(READ_TOOLS.map((t) => t.name));

/** Reads that scan on-chain history get more time than the default. */
export const SLOW_READS: Record<string, number> = { get_earn_interest: 30_000, get_history: 25_000 };

const assetsArg = (v: unknown, allowed: readonly string[]): Asset[] =>
  (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? normalizeAsset(x) : null)).filter((a): a is Asset => !!a && allowed.includes(a));
const assetArg = (v: unknown): Asset | null => (typeof v === "string" ? normalizeAsset(v) : null);
const decimalArg = (v: unknown): string | null => (typeof v === "string" ? parseDecimalString(v.trim()) : typeof v === "number" ? parseDecimalString(String(v)) : null);

export type ReadOutput = { ok: boolean; result: unknown };

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

/** Run one read the model asked for. Unknown tools and bad arguments come back as an error the model can see. */
export async function executeRead(tool: string, args: Record<string, unknown>, ctx: ReadCtx): Promise<ReadOutput> {
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
    case "get_kamino_positions":
      return viaRead({ kind: "farm_positions" }, ctx);
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
