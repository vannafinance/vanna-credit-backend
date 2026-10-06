/**
 * Stage 2 read surface: the tools Gemini may call while it investigates a request.
 *
 * Every tool is backed by the Vanna Solana MCP through the same readers the deterministic answers use
 * (`mcp-facts.ts`), or by the protocol maths in `risk.ts` on MCP figures. None of them writes. The wallet is bound
 * here from the signed session (`ctx.user`), never taken from model arguments, so a read cannot be pointed at
 * someone else's account.
 */

import { copilotConfig } from "../config";
import { LEND_BORROW_ASSETS, PRODUCT_ASSETS, normalizeAsset, parseDecimalString, type Asset, type ConceptTopic, type ReadIntent } from "../intent";
import { loadFreshPrice, loadHealth, runRead, type ReadCtx } from "../mcp-facts";
import { DEFAULT_SLIPPAGE_BPS, maxLeverage, sizeLever } from "../risk";
import type { LlmFunctionDecl } from "../vertex";

const ASSETS = [...PRODUCT_ASSETS] as string[];
const LEND_ASSETS = [...LEND_BORROW_ASSETS] as string[];
const TOPICS: ConceptTopic[] = ["health_factor", "liquidation", "leverage", "collateral", "earn", "farm", "margin", "general"];

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "OBJECT", properties, ...(required.length ? { required } : {}) });
const assetList = (enumValues: string[], description: string) => ({ type: "ARRAY", items: { type: "STRING", enum: enumValues }, description });

export const READ_TOOLS: LlmFunctionDecl[] = [
  { name: "get_account_health", description: "The user's margin account: health factor, total collateral and debt in USD, each collateral and debt position with its oracle price, liquidation status. Says when the user has no margin account." },
  { name: "get_positions", description: "Everything the user holds in Vanna: margin collateral and debt, Earn pool deposits, Kamino farm receipts." },
  { name: "get_wallet_balances", description: "The user's wallet token balances (SOL, USDC, USDT, JitoSOL, JupSOL) and Earn shares. Use before planning anything that spends from the wallet." },
  { name: "get_prices", description: "Oracle USD prices the protocol itself uses.", parameters: obj({ assets: assetList(ASSETS, "Assets to price.") }, ["assets"]) },
  { name: "get_pool_rates", description: "Vanna Earn / borrow pool figures per asset: supply APR, borrow APR, utilization, liquidity available to borrow.", parameters: obj({ assets: assetList(LEND_ASSETS, "Pools to read.") }, ["assets"]) },
  { name: "get_earn_positions", description: "The user's Earn pool deposits: redeemable amount and interest earned.", parameters: obj({ assets: assetList(LEND_ASSETS, "Pools; empty means all.") }) },
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
    name: "get_swap_quote",
    description: "A live Jupiter quote: output amount and minimum received at the default slippage.",
    parameters: obj({ from: { type: "STRING", enum: ASSETS }, to: { type: "STRING", enum: ASSETS }, amount: { type: "STRING", description: "Decimal amount of `from`." } }, ["from", "to", "amount"]),
  },
  { name: "get_history", description: "The user's recent Vanna transactions." },
  { name: "get_protocol_info", description: "On-chain protocol configuration: operating mode, which assets can be lent, borrowed or used as collateral, integrations." },
  { name: "explain_concept", description: "The product's own explanation of a concept, for questions about how something works.", parameters: obj({ topic: { type: "STRING", enum: TOPICS } }, ["topic"]) },
];

export const READ_TOOL_NAMES = new Set(READ_TOOLS.map((t) => t.name));

const assetsArg = (v: unknown, allowed: readonly string[]): Asset[] =>
  (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? normalizeAsset(x) : null)).filter((a): a is Asset => !!a && allowed.includes(a));
const assetArg = (v: unknown): Asset | null => (typeof v === "string" ? normalizeAsset(v) : null);
const decimalArg = (v: unknown): string | null => (typeof v === "string" ? parseDecimalString(v.trim()) : typeof v === "number" ? parseDecimalString(String(v)) : null);

export type ReadOutput = { ok: boolean; result: unknown };

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
      return viaRead({ kind: "earn_position", assets: assetsArg(args.assets, LEND_ASSETS) }, ctx);
    case "get_kamino_markets":
      return viaRead({ kind: "farm_markets" }, ctx);
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
