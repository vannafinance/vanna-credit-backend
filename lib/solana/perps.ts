import { fetchWithTimeout } from "../async";
/**
 * Perps on Phoenix from the margin account — the Perps page's service layer.
 *
 * Every step is a `margin_execute` signed by Vanna as the margin account (the margin is its own
 * Phoenix trader authority), health-checked after it:
 *
 *   open  = [Ember deposit USDC → phUSD] → [Phoenix deposit_funds] → place_market_order   (one tx)
 *   close = place_market_order reduce-only                                                  (one tx)
 *           then, once no position is left: withdraw_funds → Ember withdraw phUSD → USDC    (one tx)
 *
 * Phoenix market orders are immediate-or-cancel and fill against the book inside the transaction:
 * there is no keeper and no pending order. Calls into Phoenix pass venue_asset = the Phoenix venue's
 * AssetConfig and the validator segment `[vanna_validator, market_book, exchange]`; the oracle
 * segment carries the venue's accounts (market book, exchange, perp asset map, trader, USDC price,
 * each open + targeted market's orderbook and index price). The validator caps each order's
 * exposure (at its limit price) at the market's leverage cap × the trader's Phoenix collateral.
 */
import { Buffer } from "buffer";
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import { LIQUIDATION_HEALTH_FACTOR } from "./config";
import { forkUnixTimestamp, getConnection } from "./connection";
import { fetchMarginSnapshot, loadContext, type BatchContext, type MarginServiceOptions } from "./margin";
import { appApiBase, EXEC_COMPUTE_UNITS, marginExecuteIx } from "./exec";
import { ensureFreshPrices } from "./price-refresh";
import { sendInstructions } from "./tx";
import { getActiveSigner, type TxSigner } from "./wallet-bridge";
import { toRaw } from "./math";
import { getProgram, vannaCoder } from "./program";
import vannaIdl from "@/idl/vanna_credit_layer.json";
import { marginPda, marginVault } from "./pdas";
import type { AssetConfigState } from "./protocol-state";
import {
  amountData,
  ASK,
  BID,
  DEPOSIT_FUNDS,
  depositAccounts,
  EMBER_DEPOSIT,
  EMBER_PROGRAM_ID,
  emberAccounts,
  emberWithdrawData,
  lotsToTokens,
  marketOrderData,
  orderAccounts,
  PERP_MARKETS,
  PHOENIX_EXCHANGE,
  PHOENIX_PROGRAM_ID,
  phoenixValidatorAccounts,
  FULL_TRADER_CAPABILITIES,
  PLACE_MARKET_ORDER,
  registerTraderIx,
  usdToTicks,
  WITHDRAW_FUNDS,
  withdrawAccounts,
  phoenixTraderPda,
} from "./phoenix";
import { loadPhoenixVenue, type PhoenixListedMarket, type PhoenixVenueContext } from "./phoenix-state";
import { getToken } from "./tokens";
import type { CancelPerpRequest, ClosePerpRequest, OpenPerpRequest, PerpHistoryRow, PerpPosition, PerpsView, WithdrawPerpCollateralRequest } from "./perps-types";

/** Phoenix collateral (the market book's `collateral_mint`). */
const USDC = getToken("USDC");
/** Default worst-price protection for market orders, bps: 1% on crypto markets, 2% on the stock
 * markets (thinner books, wider spreads). The Perps form offers 0.5 / 1 / 2%. */
const DEFAULT_SLIPPAGE_BPS = 100;
const STOCK_SLIPPAGE_BPS = 200;
const STOCK_MARKETS = new Set(["TSLA", "META"]);
/** The default price limit for a market, bps. */
export const defaultSlippageBps = (market: string): number => (STOCK_MARKETS.has(market.toUpperCase().replace(/-PERP$/, "")) ? STOCK_SLIPPAGE_BPS : DEFAULT_SLIPPAGE_BPS);
/** Widest price limit a close retries with when nothing fills inside the requested one, bps. */
const MAX_CLOSE_SLIPPAGE_BPS = 500;

export interface PerpTxResult {
  /** The last wallet transaction's signature. */
  signature: string;
  /** Human summary of what happened. */
  summary: string;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

function toMarketInfo(m: PhoenixListedMarket, i: number) {
  return {
    key: m.meta.key,
    name: m.meta.name,
    leg: i,
    indexPrice: m.index?.usd ?? null,
    markPrice: m.markUsd,
    priceFresh: Boolean(m.index?.fresh),
    maxLeverage: m.entry.maxLeverageBps / 10_000,
    tradingEnabled: m.entry.tradingEnabled,
    takerFee: (m.orderbook?.takerFeeMicro ?? 0) / 1e6,
    chartSymbol: m.meta.chartSymbol,
    icon: m.meta.icon,
  };
}

/** Everything the Perps page shows. Works without a wallet (markets only). */
export async function fetchPerpsView(owner: PublicKey | null): Promise<PerpsView> {
  const connection = getConnection();
  const [snapshot, now] = await Promise.all([owner ? fetchMarginSnapshot(owner) : Promise.resolve(null), forkUnixTimestamp(connection)]);
  const margin = owner ? marginPda(owner) : PublicKey.default;
  const venue = snapshot?.venue ?? (await loadPhoenixVenue(connection, margin, now));
  const account = snapshot?.exists
    ? {
        hasMargin: true,
        marginUsdc: snapshot.collateral.find((c) => c.mint.equals(USDC.mint))?.amount ?? 0,
        venueValueUsd: venue ? Number(venue.valueNano) / 1e9 : 0,
        idleUsdc: venue?.collateralUsd ?? 0,
        withdrawableNowUsdc: venue ? Number(venue.withdrawableNow) / 1e6 : 0,
        totalCollateralUsd: snapshot.totalCollateralUsd,
        totalDebtUsd: snapshot.totalDebtUsd,
        healthFactor: snapshot.healthFactor,
        // The venue's own line is valued from `positions` + `idleUsdc` by the account model, so only
        // that row is left out (its vault is the margin's Phoenix trader). Kamino receipts (kSOL…) and
        // vault shares (vbSOL, USD*…) have no registry token but are real collateral and stay in.
        collateralRows: snapshot.collateral
          .filter((c) => c.active && c.usd > 0 && !c.vault.equals(phoenixTraderPda(margin)))
          .map((c) => ({ symbol: c.symbol, usd: c.usd })),
        debtRows: snapshot.debts.filter((d) => d.usd > 0).map((d) => ({ symbol: d.symbol, usd: d.usd })),
        prices: Object.fromEntries(Object.entries(snapshot.prices).flatMap(([k, p]) => (p && p.usd > 0 ? [[k, p.usd]] : []))),
      }
    : { hasMargin: false, marginUsdc: 0, venueValueUsd: 0, idleUsdc: 0, withdrawableNowUsdc: 0, totalCollateralUsd: 0, totalDebtUsd: 0, healthFactor: null, collateralRows: [], debtRows: [], prices: {} };
  if (!venue) return { markets: [], positions: [], orders: [], account };
  const markets = venue.markets.map(toMarketInfo);
  if (!owner || !snapshot?.exists) return { markets, positions: [], orders: [], account };

  const holdings = snapshot.totalCollateralUsd;
  const debt = snapshot.totalDebtUsd;
  const venueValue = Number(venue.valueNano) / 1e9;
  const positions: PerpPosition[] = venue.positions.map((p) => {
    // Cross margin: the whole Phoenix balance backs every position. The venue's equity reaches zero
    // when this market alone moves by venueValue / sizeTokens against the position.
    const zeroEquity = p.sizeTokens > 0 ? (p.isLong ? p.indexPrice - venueValue / p.sizeTokens : p.indexPrice + venueValue / p.sizeTokens) : 0;
    // The margin becomes liquidatable (HF 1.10) when holdings + Δequity = 1.10 × debt.
    let liq: number | null = null;
    if (debt > 0 && p.sizeTokens > 0) {
      const room = (holdings - LIQUIDATION_HEALTH_FACTOR * debt) / p.sizeTokens;
      const candidate = p.isLong ? p.indexPrice - room : p.indexPrice + room;
      const reachable = p.isLong ? candidate > zeroEquity : candidate < zeroEquity;
      liq = reachable && candidate > 0 ? candidate : null;
    }
    const exposure = venue.positions.reduce((s, x) => s + x.sizeUsd, 0);
    return {
      market: p.key,
      marketName: p.name,
      side: p.isLong ? "long" : "short",
      sizeUsd: p.sizeUsd,
      sizeTokens: p.sizeTokens,
      entryPrice: p.entryPrice,
      markPrice: p.indexPrice,
      indexPrice: p.indexPrice,
      closeFeeUsd: p.closeFeeUsd,
      collateralUsdc: venue.collateralUsd,
      leverage: venueValue > 0 ? exposure / venueValue : 0,
      pnlUsd: p.pnlUsd,
      pnlPercent: p.entryPrice > 0 ? (p.pnlUsd / (p.entryPrice * p.sizeTokens)) * 100 : 0,
      fundingUsd: p.fundingUsd,
      equityUsd: p.equityUsd,
      zeroEquityPrice: Math.max(0, zeroEquity),
      liquidationPrice: liq,
    };
  });
  return { markets, positions, orders: [], account };
}

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

async function postApi<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(`${appApiBase()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `${path} failed (${res.status})`);
  return json as T;
}

/** The margin's lookup table (fork: written by the app's server), so each step fits one transaction. */
async function lookupTables(owner: PublicKey): Promise<AddressLookupTableAccount[]> {
  const { address } = await postApi<{ address: string }>("/api/perps/lookup-table", { owner: owner.toBase58() });
  const table = (await getConnection().getAddressLookupTable(new PublicKey(address))).value;
  return table ? [table] : [];
}

/** Starts the lookup table early (it only needs the owner), so it runs alongside the price and book refresh. */
function startLookupTables(owner: PublicKey): Promise<AddressLookupTableAccount[]> {
  const tables = lookupTables(owner);
  tables.catch(() => undefined); // awaited (and rethrown) where the transaction is built
  return tables;
}

interface PerpsContext {
  ctx: BatchContext;
  venue: PhoenixVenueContext;
  venueAsset: AssetConfigState;
  usdcAsset: AssetConfigState;
  phusdAsset: AssetConfigState;
}

function assetByMint(ctx: BatchContext, mint: PublicKey, label: string): AssetConfigState {
  for (const a of ctx.assetMap.values()) if (a.mint.equals(mint)) return a;
  throw new Error(`${label} is not registered with the protocol`);
}

async function loadPerpsContext(owner: PublicKey): Promise<PerpsContext> {
  const ctx = await loadContext(owner);
  if (!ctx.snapshot.exists) throw new Error("Create a margin account first");
  const venue = ctx.venue ?? (await loadPhoenixVenue(getConnection(), ctx.margin, ctx.snapshot.now));
  if (!venue) throw new Error("Phoenix markets aren't listed on this network yet");
  if (venue.trader && (venue.trader.hot || venue.trader.withdrawQueued)) throw new Error("This Phoenix account has a queued withdrawal; try again shortly");
  return {
    ctx,
    venue,
    venueAsset: assetByMint(ctx, PHOENIX_EXCHANGE, "The Phoenix venue"),
    usdcAsset: assetByMint(ctx, USDC.mint, "USDC"),
    phusdAsset: assetByMint(ctx, venue.exchange.canonicalMint, "phUSD"),
  };
}

/**
 * The price an order's limit is set from: the live index (on the fork Phoenix's own mark can lag,
 * while the book is refreshed from mainnet before each trade), else Phoenix's mark.
 */
/**
 * The price an order's limit is set around: where Phoenix's book trades (`liveMark` from the fork's
 * book refresh, else the market's own mark), falling back to the index. Orders fill against the
 * book, so pricing off the index missed fills whenever the two diverged (TSLA's index ran ~0.9% above
 * Phoenix's book and a 1% short found nothing).
 */
function refPrice(m: PhoenixListedMarket, liveMark?: number | null): number {
  if (liveMark && liveMark > 0) return liveMark;
  if (m.markUsd > 0) return m.markUsd;
  return m.index?.usd ?? 0;
}

/**
 * Fork only: re-copy the market's book from mainnet before trading and get mainnet Phoenix's mark
 * for it (null elsewhere / on error — the market's own mark is live there).
 */
async function refreshBook(market: string): Promise<number | null> {
  const res = await postApi<{ markUsd?: number | null }>("/api/perps/phoenix-book", { market }).catch(() => null);
  return res?.markUsd ?? null;
}

function marketFor(venue: PhoenixVenueContext, key: string): PhoenixListedMarket {
  const m = venue.markets.find((x) => x.meta.key === key.toUpperCase().replace(/-PERP$/, ""));
  if (!m) throw new Error(`${key}-PERP is not a listed Phoenix market`);
  return m;
}

/** A call at Phoenix: venue asset + validator segment; `opens` per the validator's permit. */
function phoenixCall(p: PerpsContext, data: Buffer, accounts: ReturnType<typeof orderAccounts>, opts: { targetAssetIds: number[]; opens: boolean; closes?: boolean; token?: Parameters<typeof marginExecuteIx>[1]["token"] }) {
  return marginExecuteIx(p.ctx, {
    target: PHOENIX_PROGRAM_ID,
    data,
    cpiAccounts: accounts,
    // The target market plus every open position: the validator prices them all.
    validatorAccounts: phoenixValidatorAccounts(p.venue.book, [...opts.targetAssetIds, ...p.venue.openAssetIds]),
    token: opts.token,
    venue: { asset: p.venueAsset, state: p.venue, targetAssetIds: opts.targetAssetIds, opens: opts.opens, closes: Boolean(opts.closes) },
  });
}

/**
 * The margin's Phoenix trader, ready to take deposits. First time: the wallet registers it (plain
 * `register_trader`, the wallet pays the rent), then Phoenix's onboarding grants the deposit /
 * withdraw capabilities — on the fork the app's `/api/perps/phoenix-access` stands in for that.
 * Returns true when it changed anything (the caller reloads its context).
 */
async function ensurePhoenixTrader(signer: TxSigner, p: PerpsContext, opts: MarginServiceOptions): Promise<boolean> {
  const trader = p.venue.trader;
  if (trader && (trader.capabilities & FULL_TRADER_CAPABILITIES) === FULL_TRADER_CAPABILITIES) return false;
  if (!trader) {
    opts.onStatus?.("Creating your Phoenix trading account");
    await sendInstructions([registerTraderIx(p.ctx.owner, p.ctx.margin)], { signer, label: "Create Phoenix account", onStatus: opts.onStatus as never });
  }
  opts.onStatus?.("Enabling Phoenix deposits");
  await postApi("/api/perps/phoenix-access", { owner: p.ctx.owner.toBase58() });
  return true;
}

/** USDC (margin vault) → phUSD → the Phoenix trader: two calls. */
async function fundIxs(p: PerpsContext, amount: bigint): Promise<TransactionInstruction[]> {
  const { ctx, venue } = p;
  const phusdVault = marginVault(ctx.margin, venue.exchange.canonicalMint, TOKEN_PROGRAM_ID);
  ctx.instructions.push(createAssociatedTokenAccountIdempotentInstruction(ctx.owner, phusdVault, ctx.margin, venue.exchange.canonicalMint, TOKEN_PROGRAM_ID));
  const wrap = await marginExecuteIx(ctx, {
    target: EMBER_PROGRAM_ID,
    data: amountData(EMBER_DEPOSIT, amount),
    cpiAccounts: emberAccounts(venue.exchange, ctx.margin, USDC.mint),
    token: { spent: p.usdcAsset, received: p.phusdAsset, expectedSpent: amount, expectedReceived: amount },
  });
  const deposit = await phoenixCall(p, amountData(DEPOSIT_FUNDS, amount), depositAccounts(venue.exchange, ctx.margin), {
    targetAssetIds: [],
    opens: true,
    token: { spent: p.phusdAsset, expectedSpent: amount, expectedReceived: 0n },
  });
  return [wrap, deposit];
}

async function send(signer: TxSigner, ixs: TransactionInstruction[], label: string, tables: AddressLookupTableAccount[], opts: MarginServiceOptions) {
  return sendInstructions(ixs, { signer, label, computeUnits: EXEC_COMPUTE_UNITS, lookupTables: tables, onStatus: opts.onStatus as never });
}

/** Lots for `sizeUsd` at `priceUsd` (floored), never zero. */
function lotsFor(m: PhoenixListedMarket, sizeUsd: number, priceUsd: number): bigint {
  const lots = BigInt(Math.floor((sizeUsd / priceUsd) * 10 ** m.market.lotDecimals));
  if (lots <= 0n) throw new Error(`Size too small for ${m.meta.name} (one lot is ${(10 ** -m.market.lotDecimals).toString()} ${m.meta.key})`);
  return lots;
}

/**
 * Open or add to a long / short: moves `collateral` USDC from the margin into Phoenix (Ember wrap +
 * deposit) and places an immediate-or-cancel market order of `collateral × leverage` USD, all in one
 * transaction. With `collateral = 0` the order uses the Phoenix balance already there.
 */
export async function openPerp(req: OpenPerpRequest, opts: MarginServiceOptions = {}): Promise<PerpTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  opts.onStatus?.("Refreshing prices and the order book");
  const tablesReady = startLookupTables(signer.publicKey);
  const [, liveMark] = await Promise.all([ensureFreshPrices(), refreshBook(req.market)]);
  opts.onStatus?.("Preparing your order");
  const p = await loadPerpsContext(signer.publicKey);
  const m = marketFor(p.venue, req.market);
  if (!m.entry.tradingEnabled) throw new Error(`${m.meta.name} is closed for new positions`);
  if (req.leverage < 1 || req.leverage > m.entry.maxLeverageBps / 10_000) throw new Error(`Leverage must be between 1x and ${m.entry.maxLeverageBps / 10_000}x`);
  const amount = toRaw(req.collateral, USDC.decimals);
  const marginUsdc = p.ctx.snapshot.collateral.find((c) => c.mint.equals(USDC.mint))?.amountRaw ?? 0n;
  if (amount > marginUsdc) throw new Error(`Not enough USDC in your margin account (${Number(marginUsdc) / 1e6} available)`);
  const traderCollateral = (p.venue.trader?.collateral ?? 0n) + amount;
  if (traderCollateral <= 0n) throw new Error("Add USDC to trade on Phoenix");

  const isLong = req.side === "long";
  const slip = (req.slippageBps ?? defaultSlippageBps(m.meta.key)) / 10_000;
  const ref = refPrice(m, liveMark);
  if (!(ref > 0)) throw new Error(`No price for ${m.meta.name}`);
  const limit = isLong ? ref * (1 + slip) : ref * (1 - slip);
  // Size = collateral × leverage, valued at the limit price as the validator does, and kept inside
  // the cap together with the other markets' open exposure.
  const sizeUsd = (Number(amount > 0n ? amount : traderCollateral) / 1e6) * req.leverage;
  const current = p.venue.trader?.positions.find((x) => x.assetId === m.entry.assetId)?.baseLots ?? 0n;
  const others = p.venue.trader?.positions.filter((x) => x.assetId !== m.entry.assetId && x.baseLots !== 0n).reduce((s, x) => s + Math.abs(Number(x.virtualQuoteLots)) / 1e6, 0) ?? 0;
  const capUsd = (Number(traderCollateral) / 1e6) * (m.entry.maxLeverageBps / 10_000) - others;
  let lots = lotsFor(m, sizeUsd, limit);
  const after = (l: bigint) => Math.abs(lotsToTokens(current + (isLong ? l : -l), m.market.lotDecimals)) * limit;
  while (lots > 0n && after(lots) > capUsd) lots = (lots * 995n) / 1000n;
  if (lots <= 0n) throw new Error(`Over ${m.meta.name}'s ${m.entry.maxLeverageBps / 10_000}x cap — add collateral or reduce size`);

  if (await ensurePhoenixTrader(signer, p, opts)) return openPerp(req, opts);
  opts.onStatus?.("Building the transaction");
  const tables = await tablesReady;
  const ixs: TransactionInstruction[] = [];
  if (amount > 0n) ixs.push(...(await fundIxs(p, amount)));
  const order = await phoenixCall(
    p,
    marketOrderData({ side: isLong ? BID : ASK, priceInTicks: usdToTicks(m.market, limit), lots, reduceOnly: false }),
    orderAccounts(p.venue.exchange, p.ctx.margin, m.market),
    { targetAssetIds: [m.entry.assetId], opens: true },
  );
  ixs.push(order);
  const label = `${isLong ? "Long" : "Short"} ${m.meta.name} ${req.leverage}x`;
  opts.onStatus?.(`Opening ${label}`);
  const signature = await send(signer, [...p.ctx.instructions, ...ixs.filter((ix) => !p.ctx.instructions.includes(ix))], label, tables, opts);
  const filled = await readFill(signer.publicKey, m.entry.assetId, current);
  const tokens = Math.abs(lotsToTokens(filled.delta, m.market.lotDecimals));
  return {
    signature,
    summary: filled.delta === 0n ? `${label}: no fill at your price limit — your USDC stays in Phoenix` : `${label}: ${tokens} ${m.meta.key} (~$${(tokens * ref).toFixed(2)})`,
  };
}

/** The position change after a transaction (Phoenix fills inside it). */
async function readFill(owner: PublicKey, assetId: number, before: bigint): Promise<{ delta: bigint }> {
  const connection = getConnection();
  const venue = await loadPhoenixVenue(connection, marginPda(owner), await forkUnixTimestamp(connection));
  const now = venue?.trader?.positions.find((x) => x.assetId === assetId)?.baseLots ?? 0n;
  return { delta: now - before };
}

/** phUSD back to USDC: Phoenix `withdraw_funds` then Ember withdraw of the whole phUSD vault. */
async function withdrawIxs(p: PerpsContext, amount: bigint, venueEmpties: boolean): Promise<TransactionInstruction[]> {
  const { ctx, venue } = p;
  const phusdVault = marginVault(ctx.margin, venue.exchange.canonicalMint, TOKEN_PROGRAM_ID);
  ctx.instructions.push(createAssociatedTokenAccountIdempotentInstruction(ctx.owner, phusdVault, ctx.margin, venue.exchange.canonicalMint, TOKEN_PROGRAM_ID));
  const withdraw = await phoenixCall(p, amountData(WITHDRAW_FUNDS, amount), withdrawAccounts(venue.exchange, ctx.margin), {
    targetAssetIds: [],
    opens: false,
    closes: venueEmpties,
    token: { received: p.phusdAsset, expectedSpent: 0n, expectedReceived: amount },
  });
  const usdcVault = marginVault(ctx.margin, USDC.mint, USDC.tokenProgram);
  ctx.instructions.push(createAssociatedTokenAccountIdempotentInstruction(ctx.owner, usdcVault, ctx.margin, USDC.mint, USDC.tokenProgram));
  const unwrap = await marginExecuteIx(ctx, {
    target: EMBER_PROGRAM_ID,
    data: emberWithdrawData(null),
    cpiAccounts: emberAccounts(venue.exchange, ctx.margin, USDC.mint),
    token: { spent: p.phusdAsset, received: p.usdcAsset, expectedSpent: amount, expectedReceived: amount },
  });
  return [withdraw, unwrap];
}

/** Moves USDC out of Phoenix back into the margin (all of it by default; only what Phoenix pays now). */
export async function withdrawPerpCollateral(req: WithdrawPerpCollateralRequest = {}, opts: MarginServiceOptions = {}): Promise<PerpTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const tablesReady = startLookupTables(signer.publicKey);
  await ensureFreshPrices();
  const p = await loadPerpsContext(signer.publicKey);
  const collateral = p.venue.trader?.collateral ?? 0n;
  if (collateral <= 0n) throw new Error("No USDC in Phoenix to withdraw");
  const requested = req.amount === undefined ? collateral : toRaw(req.amount, 6);
  const amount = requested > collateral ? collateral : requested;
  if (amount > p.venue.withdrawableNow) throw new Error(`Phoenix can pay out ${Number(p.venue.withdrawableNow) / 1e6} USDC right now — try a smaller amount or wait a moment`);
  const empties = amount === collateral && p.venue.positions.length === 0;
  const tables = await tablesReady;
  const ixs = await withdrawIxs(p, amount, empties);
  const signature = await send(signer, [...p.ctx.instructions, ...ixs.filter((ix) => !p.ctx.instructions.includes(ix))], "Withdraw from Phoenix", tables, opts);
  return { signature, summary: `${(Number(amount) / 1e6).toFixed(2)} USDC back in your margin account` };
}

/**
 * Close (or partly close) a position with a reduce-only market order. When no position is left
 * afterwards, the whole Phoenix balance is withdrawn back to the margin's USDC in a second
 * transaction (Phoenix pays it now unless its withdraw budget is used up; it then stays in Phoenix).
 */
export async function closePerp(req: ClosePerpRequest, opts: MarginServiceOptions = {}): Promise<PerpTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  opts.onStatus?.("Refreshing prices and the order book");
  const tablesReady = startLookupTables(signer.publicKey);
  const [, liveMark] = await Promise.all([ensureFreshPrices(), refreshBook(req.market)]);
  opts.onStatus?.("Preparing your order");
  const p = await loadPerpsContext(signer.publicKey);
  const m = marketFor(p.venue, req.market);
  const base = p.venue.trader?.positions.find((x) => x.assetId === m.entry.assetId)?.baseLots ?? 0n;
  if (base === 0n) throw new Error(`No open ${m.meta.name} position`);
  const isLong = base > 0n;
  const abs = isLong ? base : -base;
  const ref = refPrice(m, liveMark);
  let lots = abs;
  if (req.sizeUsd !== undefined) {
    lots = lotsFor(m, req.sizeUsd, ref);
    if (lots > abs) lots = abs;
  }
  const tables = await tablesReady;
  const label = `Close ${m.meta.name} ${isLong ? "long" : "short"}`;
  // A close should go through: when the book has nothing inside the requested price limit, retry
  // once with a wider one (up to MAX_CLOSE_SLIPPAGE_BPS) instead of leaving the position open.
  const requested = req.slippageBps ?? defaultSlippageBps(m.meta.key);
  const attempts = [...new Set([requested, Math.max(requested, MAX_CLOSE_SLIPPAGE_BPS)])];
  let signature = "";
  let fill = { delta: 0n };
  for (const bps of attempts) {
    const ctx = signature ? await loadPerpsContext(signer.publicKey) : p;
    const slip = bps / 10_000;
    const limit = isLong ? ref * (1 - slip) : ref * (1 + slip);
    const close = await phoenixCall(
      ctx,
      marketOrderData({ side: isLong ? ASK : BID, priceInTicks: usdToTicks(m.market, limit), lots, reduceOnly: true }),
      orderAccounts(ctx.venue.exchange, ctx.ctx.margin, m.market),
      { targetAssetIds: [m.entry.assetId], opens: false },
    );
    opts.onStatus?.(bps === requested ? label : `${label} (wider price limit: ${bps / 100}%)`);
    signature = await send(signer, [...ctx.ctx.instructions, close], label, tables, opts);
    fill = await readFill(signer.publicKey, m.entry.assetId, base);
    if (fill.delta !== 0n) break;
  }
  if (fill.delta === 0n) return { signature, summary: `${label}: no liquidity within ${Math.max(...attempts) / 100}% of the mark — try again shortly` };
  let summary = `${label}: ${Math.abs(lotsToTokens(fill.delta, m.market.lotDecimals))} ${m.meta.key} closed`;

  // Nothing left open → bring the USDC home.
  const after = await loadPerpsContext(signer.publicKey);
  if (after.venue.positions.length === 0 && (after.venue.trader?.collateral ?? 0n) > 0n) {
    const collateral = after.venue.trader!.collateral;
    if (collateral <= after.venue.withdrawableNow) {
      opts.onStatus?.("Moving USDC back to your margin account");
      const ixs = await withdrawIxs(after, collateral, true);
      signature = await send(signer, [...after.ctx.instructions, ...ixs.filter((ix) => !after.ctx.instructions.includes(ix))], "Withdraw from Phoenix", tables, opts);
      summary += ` — ${(Number(collateral) / 1e6).toFixed(2)} USDC back in your margin account`;
    } else {
      summary += " — USDC stays in Phoenix until its withdraw budget refills (use Withdraw)";
    }
  }
  return { signature, summary };
}

/** Phoenix market orders fill or cancel inside their transaction: there's never a pending order. */
export async function cancelPerpOrder(_req: CancelPerpRequest, _opts: MarginServiceOptions = {}): Promise<PerpTxResult> {
  void _req;
  void _opts;
  throw new Error("Phoenix market orders fill immediately — there is no pending order to cancel");
}

// ---------------------------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------------------------

const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex");
const SEL_ORDER = hex(PLACE_MARKET_ORDER);
const SEL_DEPOSIT = hex(DEPOSIT_FUNDS);
const SEL_WITHDRAW = hex(WITHDRAW_FUNDS);
/**
 * `margin_execute`'s named accounts before its remaining accounts (authority … venue_asset,
 * event_authority, program — 9 since the emit_cpi upgrade; read from the IDL so it can't drift).
 */
const MARGIN_EXECUTE_NAMED_ACCOUNTS = vannaIdl.instructions.find((i) => i.name === "margin_execute")?.accounts.length ?? 9;

/**
 * The margin's Phoenix actions, newest first, decoded from the wallet's transactions: each
 * `margin_execute` into Phoenix carries Phoenix's own instruction (place_market_order: side, lots,
 * reduce-only; deposit_funds / withdraw_funds: amount). Ember wraps are part of a deposit / withdraw.
 */
export async function fetchPerpsHistory(owner: PublicKey, limit = 100): Promise<PerpHistoryRow[]> {
  const connection = getConnection();
  const now = await forkUnixTimestamp(connection);
  const venue = await loadPhoenixVenue(connection, marginPda(owner), now);
  if (!venue) return [];
  const byOrderbook = new Map(venue.markets.map((m) => [m.entry.market.toBase58(), m]));
  // The wallet signs every Phoenix call; the fork's signature index only reliably covers signers.
  const sigs = (await connection.getSignaturesForAddress(owner, { limit }, "confirmed")).filter((s) => !s.err);
  const program = getProgram();
  const rows: PerpHistoryRow[] = [];
  for (let i = 0; i < sigs.length; i += 6) {
    const txs = await Promise.all(sigs.slice(i, i + 6).map((s) => connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })));
    txs.forEach((tx, k) => {
      if (!tx?.meta) return;
      const sig = sigs[i + k];
      const timestamp = sig.blockTime ?? tx.blockTime ?? 0;
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
      const fills = orderFills(tx.meta.logMessages ?? []);
      let orderIndex = 0;
      for (const ix of tx.transaction.message.compiledInstructions) {
        if (!keys.get(ix.programIdIndex)?.equals(program.programId)) continue;
        // margin_execute's target program is its 5th named account.
        if (!keys.get(ix.accountKeyIndexes[4])?.equals(PHOENIX_PROGRAM_ID)) continue;
        let decoded: { name: string; data: Record<string, unknown> } | null = null;
        try {
          decoded = vannaCoder.instruction.decode(Buffer.from(ix.data)) as { name: string; data: Record<string, unknown> } | null;
        } catch {
          continue;
        }
        if (!decoded || decoded.name.replace(/_/g, "").toLowerCase() !== "marginexecute") continue;
        const inner = Buffer.from(decoded.data.data as Uint8Array);
        const callCount = Number(decoded.data.callAccountCount ?? decoded.data.call_account_count ?? 0);
        const selector = inner.subarray(0, 8).toString("hex");
        if (selector === SEL_DEPOSIT || selector === SEL_WITHDRAW) {
          rows.push({
            signature: sig.signature,
            timestamp,
            action: selector === SEL_DEPOSIT ? "deposit" : "settle",
            market: null,
            side: null,
            sizeUsd: null,
            usdc: Number(inner.readBigUInt64LE(8)) / 1e6,
          });
        } else if (selector === SEL_ORDER && inner.length > 20) {
          // [8] order type, [9] side, Option<u64> price, u64 lots, …, last 2 bytes: flags.
          const side = inner[9] === BID ? "long" : "short";
          const hasPrice = inner[10] === 1;
          const at = hasPrice ? 19 : 11;
          const lots = inner.readBigUInt64LE(at);
          const reduceOnly = (inner[inner.length - 2] & 128) !== 0;
          const orderbookKey = keys.get(ix.accountKeyIndexes[MARGIN_EXECUTE_NAMED_ACCOUNTS + callCount - 2])?.toBase58();
          const m = orderbookKey ? byOrderbook.get(orderbookKey) : undefined;
          const tokens = m ? lotsToTokens(lots, m.market.lotDecimals) : null;
          const price = hasPrice && m ? (Number(inner.readBigUInt64LE(11)) * Number(m.market.tickSize) * 10 ** m.market.lotDecimals) / 1e6 : null;
          // What Phoenix actually filled (its return data); an IOC order with nothing in range fills 0.
          const fill = fills[orderIndex++];
          const unfilled = fill !== undefined && fill.baseLots === 0n && fill.quoteMicro === 0n;
          const filledUsd = fill && fill.quoteMicro > 0n ? Number(fill.quoteMicro) / 1e6 : null;
          rows.push({
            signature: sig.signature,
            timestamp,
            action: unfilled ? "nofill" : reduceOnly ? "close" : "open",
            // A reduce-only buy closes a short; a reduce-only sell closes a long.
            market: m?.meta.key ?? null,
            side: reduceOnly ? (side === "long" ? "short" : "long") : side,
            sizeUsd: unfilled ? null : filledUsd ?? (tokens !== null && price !== null ? tokens * price : null),
            usdc: null,
          });
        }
      }
    });
  }
  return rows.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Phoenix `place_market_order` results in log order, from each call's return data (u64 slots): a
 * buy fills quote paid at byte 16 and base lots received at byte 40; a sell fills base lots sold at
 * byte 24 and quote received at byte 32 (USDC micro-units). All zero = the immediate-or-cancel order
 * found nothing inside its price limit.
 */
function orderFills(logs: string[]): { quoteMicro: bigint; baseLots: bigint }[] {
  const fills: { quoteMicro: bigint; baseLots: bigint }[] = [];
  let pending = false;
  const prefix = `Program return: ${PHOENIX_PROGRAM_ID.toBase58()} `;
  for (const line of logs) {
    if (line.includes("Phoenix Eternal: Place Market Order")) pending = true;
    else if (pending && line.startsWith(prefix)) {
      pending = false;
      const data = Buffer.from(line.slice(prefix.length), "base64");
      const slot = (offset: number) => (data.length >= offset + 8 ? data.readBigUInt64LE(offset) : 0n);
      const max = (x: bigint, y: bigint) => (x > y ? x : y);
      fills.push({ quoteMicro: max(slot(16), slot(32)), baseLots: max(slot(24), slot(40)) });
    }
  }
  return fills;
}

/** Every market Vanna lists on Phoenix (static metadata, used before the market book loads). */
export { PERP_MARKETS };
