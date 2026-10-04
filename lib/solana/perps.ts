/**
 * Perps on GMTrade from the margin account — the Perps page's service layer, following the
 * Frontend Integration Guide's "GMTrade: perpetual positions".
 *
 * Every trading call is `margin_execute` into GMTrade, signed by Vanna as the margin's venue account,
 * with venue_asset = ["asset", store], new_assets = 0, the margin USDC vault writable (it funds the
 * order), the target market's accounts in the oracle segment and the validator segment
 * [vanna_validator, market_book]. Before each call, in the same transaction: top the venue account
 * up to 0.05 SOL, create its USDC ATA, and for create_order_v2 the order escrow.
 *
 *   open   = [prepare_user] → [prepare_position] → create_order_v2 MarketIncrease (each its own tx)
 *   close  = create_order_v2 MarketDecrease → keeper fill → public_venue_settle
 *   cancel = close_order_v2 → public_venue_settle
 * GMTrade's keepers fill orders off-chain; on the fork `/api/perps/fill` stands in for them.
 */
import { ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountInfo, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import { ORACLE_PROGRAM_ID, LIQUIDATION_HEALTH_FACTOR } from "./config";
import { forkUnixTimestamp, getConnection } from "./connection";
import { fetchMarginSnapshot, legsOf, loadContext, type BatchContext, type MarginServiceOptions } from "./margin";
import { appApiBase, EXEC_COMPUTE_UNITS, marginExecuteIx } from "./exec";
import { ensureFreshPrices } from "./price-refresh";
import { sendInstructions } from "./tx";
import { getActiveSigner, type TxSigner } from "./wallet-bridge";
import { fromRaw, toRaw } from "./math";
import { getProgram } from "./program";
import { assetConfigPda, marginPda, marginVault, protocolConfigPda } from "./pdas";
import { fetchAllAssetConfigs, type AssetConfigState } from "./protocol-state";
import {
  closeOrderAccounts,
  closeOrderData,
  createOrderAccounts,
  createOrderData,
  GMTRADE_PROGRAM_ID,
  gmEscrow,
  gmOrderPda,
  MARKET_DECREASE,
  MARKET_INCREASE,
  ORDER_EXECUTION_LAMPORTS,
  PERP_MARKETS,
  preparePositionAccounts,
  preparePositionData,
  prepareUserAccounts,
  prepareUserData,
  USD_UNIT,
  validatorAccounts,
  VENUE_ACCOUNT_LAMPORTS,
  venueAccountOf,
  venueIdleAccount,
  venueOracleAccounts,
  type MarketBookEntry,
  type MarketBookState,
  type OrderParams,
} from "./perps-accounts";
import { fetchMarketBook, readVenueState, type VenueState } from "./perps-state";
import { getToken } from "./tokens";
import type { CancelPerpRequest, ClosePerpRequest, OpenPerpRequest, PerpOrder, PerpPosition, PerpsView } from "./perps-types";

const NANO = 1e9;
/** GMTrade collateral (the market book's `collateral_mint`); used before the book exists. */
const PERPS_COLLATERAL_MINT = getToken("USDC").mint;

export interface PerpTxResult {
  /** The last wallet transaction's signature. */
  signature: string;
  /** Human summary of what happened (fill price, USDC returned …). */
  summary: string;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** Everything the Perps page shows. Works without a wallet (markets only). */
export async function fetchPerpsView(owner: PublicKey | null): Promise<PerpsView> {
  const connection = getConnection();
  const [book, snapshot, now] = await Promise.all([
    fetchMarketBook(connection),
    owner ? fetchMarginSnapshot(owner) : Promise.resolve(null),
    forkUnixTimestamp(connection),
  ]);
  // The margin side is shown even before GMTrade markets are listed.
  const usdcMint = book?.collateralMint ?? PERPS_COLLATERAL_MINT;
  const account = snapshot?.exists
    ? {
        hasMargin: true,
        marginUsdc: snapshot.collateral.find((c) => c.mint.equals(usdcMint))?.amount ?? 0,
        venueValueUsd: snapshot.venue ? Number(snapshot.venue.valueNano) / NANO : 0,
        idleUsdc: snapshot.venue && book ? Number(snapshot.venue.idleRaw) / 10 ** book.collateralDecimals : 0,
        totalCollateralUsd: snapshot.totalCollateralUsd,
        totalDebtUsd: snapshot.totalDebtUsd,
        healthFactor: snapshot.healthFactor,
      }
    : { hasMargin: false, marginUsdc: 0, venueValueUsd: 0, idleUsdc: 0, totalCollateralUsd: 0, totalDebtUsd: 0, healthFactor: null };
  const empty: PerpsView = { markets: [], positions: [], orders: [], account };
  if (!book) return empty;
  const margin = owner ? marginPda(owner) : PublicKey.default;
  const venue = snapshot?.venue ?? (await readVenueState(connection, margin, book, 0n, now));
  const markets = venue.markets.map((m) => {
    const meta = m.entry.meta ?? PERP_MARKETS.find((x) => x.market.equals(m.entry.market));
    const key = meta?.key ?? m.entry.leg.toString();
    return {
      key,
      name: meta?.name ?? `${key}-PERP`,
      leg: m.entry.leg,
      indexPrice: m.indexPrice?.usd ?? null,
      priceFresh: Boolean(m.indexPrice?.fresh),
      maxLeverage: m.entry.maxLeverageBps / 10_000,
      tradingEnabled: m.entry.tradingEnabled,
      chartSymbol: meta?.chart ?? `PYTH:${key}USD`,
      icon: meta?.icon ?? "/coins/default.svg",
    };
  });
  if (!owner || !snapshot?.exists) return { ...empty, markets };

  const holdings = snapshot.totalCollateralUsd;
  const debt = snapshot.totalDebtUsd;
  const positions: PerpPosition[] = [];
  const orders: PerpOrder[] = [];
  venue.markets.forEach((m, i) => {
    const info = markets[i];
    const mark = m.indexPrice?.usd ?? 0;
    for (const p of m.positions) {
      if (!p) continue;
      // HF hits 1.10 when holdings + Δequity = 1.10 × debt; a long's equity moves by sizeTokens per
      // $1 of index, a short's against it (guide, "Liquidation price"). Equity floors at 0, so a move
      // past the zero-equity price can't take more.
      const zeroEquity = p.sizeTokens > 0 ? (p.isLong ? (p.sizeUsd - p.collateralUsdc) / p.sizeTokens : (p.sizeUsd + p.collateralUsdc) / p.sizeTokens) : 0;
      let liq: number | null = null;
      if (debt > 0 && p.sizeTokens > 0) {
        const room = (holdings - LIQUIDATION_HEALTH_FACTOR * debt) / p.sizeTokens;
        const candidate = p.isLong ? mark - room : mark + room;
        const reachable = p.isLong ? candidate > zeroEquity : candidate < zeroEquity;
        liq = reachable && candidate > 0 ? candidate : null;
      }
      positions.push({
        market: info.key,
        marketName: info.name,
        side: p.isLong ? "long" : "short",
        sizeUsd: p.sizeUsd,
        sizeTokens: p.sizeTokens,
        entryPrice: p.entryPrice,
        markPrice: mark,
        collateralUsdc: p.collateralUsdc,
        leverage: p.leverage,
        pnlUsd: p.pnlUsd,
        pnlPercent: p.collateralUsdc > 0 ? (p.pnlUsd / p.collateralUsdc) * 100 : 0,
        equityUsd: p.equityUsd,
        zeroEquityPrice: Math.max(0, zeroEquity),
        liquidationPrice: liq,
      });
    }
    for (const o of m.orders) {
      if (!o) continue;
      orders.push({
        market: info.key,
        marketName: info.name,
        side: o.isLong ? "long" : "short",
        kind: o.increase ? "open" : "close",
        sizeUsd: o.sizeUsd,
        collateralUsdc: o.collateralUsdc,
        escrowedUsdc: Number(o.escrowedRaw) / 10 ** book.collateralDecimals,
      });
    }
  });
  return { markets, positions, orders, account };
}

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

async function postApi<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${appApiBase()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

interface Fill {
  market: string;
  kind: "increase" | "decrease";
  price: number;
  payoutUsdc: number;
}

/**
 * Waits for GMTrade to execute the pending order at `order` (the guide: poll the order PDA; once it
 * is closed, read the position). On the fork the app's keeper route fills it first.
 */
async function awaitFill(owner: PublicKey, order: PublicKey, onStatus?: (s: string) => void): Promise<Fill | null> {
  onStatus?.("Waiting for the order to fill");
  const { fills } = await postApi<{ fills: Fill[] }>("/api/perps/fill", { owner: owner.toBase58() }).catch(() => ({ fills: [] as Fill[] }));
  const connection = getConnection();
  for (let i = 0; i < 40; i++) {
    const info = await connection.getAccountInfo(order);
    if (!info || !info.owner.equals(GMTRADE_PROGRAM_ID) || info.data.length === 0) return fills[0] ?? null;
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error("The order hasn't filled yet — it stays pending; check Open orders");
}

interface PerpsContext {
  ctx: BatchContext;
  book: MarketBookState;
  venueAsset: AssetConfigState;
  usdcAsset: AssetConfigState;
  venue: VenueState;
}

async function loadPerpsContext(owner: PublicKey): Promise<PerpsContext> {
  const connection = getConnection();
  const [ctx, book, now] = await Promise.all([loadContext(owner), fetchMarketBook(connection), forkUnixTimestamp(connection)]);
  if (!ctx.snapshot.exists) throw new Error("Create a margin account first");
  if (!book) throw new Error("Perps are not set up on this network yet");
  ctx.venueBook = book;
  const assets = [...ctx.assetMap.values()];
  const venueAsset = assets.find((a) => a.kind === "venue");
  const usdcAsset = assets.find((a) => a.kind === "token" && a.mint.equals(book.collateralMint));
  if (!venueAsset || !usdcAsset) throw new Error("GMTrade is not registered with the protocol");
  const venue = ctx.snapshot.venue ?? (await readVenueState(connection, ctx.margin, book, legsOf(ctx.snapshot.raw, venueAsset.assetIndex), now));
  return { ctx, book, venueAsset, usdcAsset, venue };
}

function entryFor(book: MarketBookState, market: string): MarketBookEntry {
  const entry = book.markets.find((e) => e.meta?.key === market || e.market.toBase58() === market);
  if (!entry) throw new Error(`${market}-PERP is not listed`);
  return entry;
}

/** `acceptable_price`: USD × 10^20 / 10^index decimals. */
function unitPrice(usd: number, indexDecimals: number): bigint {
  return (BigInt(Math.round(usd * 1e8)) * (USD_UNIT / 100_000_000n)) / 10n ** BigInt(indexDecimals);
}
const usdToGm = (usd: number) => BigInt(Math.round(usd * 1e6)) * (USD_UNIT / 1_000_000n);

/** SOL top-up to 0.05, the venue USDC ATA, and (for create_order_v2) the order escrow. */
function venuePrep(p: PerpsContext, entry: MarketBookEntry | null, isLong: boolean): TransactionInstruction[] {
  const owner = p.ctx.owner;
  const venueAccount = venueAccountOf(p.ctx.margin);
  const collateral = p.book.collateralMint;
  const ixs: TransactionInstruction[] = [];
  if (p.venue.lamports < VENUE_ACCOUNT_LAMPORTS) {
    ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: venueAccount, lamports: VENUE_ACCOUNT_LAMPORTS - p.venue.lamports }));
  }
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, venueIdleAccount(venueAccount, collateral), venueAccount, collateral));
  if (entry) {
    const order = gmOrderPda(venueAccount, entry.leg, isLong);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, gmEscrow(order, collateral), order, collateral));
  }
  return ixs;
}

function venueCall(p: PerpsContext, data: Buffer, cpi: ReturnType<typeof createOrderAccounts>, leg: number | null, opensLeg: boolean) {
  return marginExecuteIx(p.ctx, {
    target: GMTRADE_PROGRAM_ID,
    data,
    cpiAccounts: cpi,
    validatorAccounts: validatorAccounts(),
    venue: { asset: p.venueAsset, leg, opensLeg, settleAsset: p.usdcAsset },
  });
}

async function send(signer: TxSigner, ixs: TransactionInstruction[], label: string, tables: AddressLookupTableAccount[], opts: MarginServiceOptions) {
  return sendInstructions(ixs, { signer, label, computeUnits: EXEC_COMPUTE_UNITS, lookupTables: tables, onStatus: opts.onStatus as never });
}

/** Opens (or increases) a long / short with USDC from the margin account. */
export async function openPerp(req: OpenPerpRequest, opts: MarginServiceOptions = {}): Promise<PerpTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const isLong = req.side === "long";
  opts.onStatus?.("Refreshing oracle prices");
  await ensureFreshPrices();
  let p = await loadPerpsContext(signer.publicKey);
  const entry = entryFor(p.book, req.market);
  const name = entry.meta?.name ?? `${req.market}-PERP`;
  if (!entry.tradingEnabled) throw new Error(`${name} is closed for new positions`);
  if (!p.venueAsset.collateralEnabled) throw new Error("GMTrade is paused for new positions");
  const maxLeverage = entry.maxLeverageBps / 10_000;
  if (!(req.leverage >= 1 && req.leverage <= maxLeverage + 1e-9)) throw new Error(`Leverage must be between 1x and ${maxLeverage}x`);
  const market = p.venue.markets.find((m) => m.entry.leg === entry.leg);
  if (market?.orders[isLong ? 0 : 1]) throw new Error(`A ${name} ${req.side} order is still pending — wait for it or cancel it`);
  const index = market?.indexPrice;
  if (!index || !index.fresh) throw new Error("Price feed is updating, try again in a moment");

  const held = p.ctx.snapshot.collateral.find((c) => c.mint.equals(p.book.collateralMint))?.amountRaw ?? 0n;
  let collateralRaw = toRaw(req.collateral, p.book.collateralDecimals);
  if (collateralRaw <= 0n) throw new Error("Enter a collateral amount");
  if (collateralRaw > held) throw new Error(`Your margin account holds ${fromRaw(held, p.book.collateralDecimals)} USDC — deposit or borrow more first`);
  // Leave 1 base unit in the USDC vault: funding a venue that empties it keeps USDC on the active
  // list with a zero balance, and the program's next USDC deposit then fails (DuplicateAssetIndex).
  if (collateralRaw === held) collateralRaw = held - 1n;
  if (collateralRaw <= 0n) throw new Error("Not enough USDC in your margin account");

  const tables = await lookupTables(signer.publicKey);
  const venueAccount = venueAccountOf(p.ctx.margin);
  const collateral = p.book.collateralMint;
  const sizeUsd = Number(fromRaw(collateralRaw, p.book.collateralDecimals)) * req.leverage;
  const slippage = (req.slippageBps ?? 100) / 10_000;
  const params: OrderParams = {
    kind: MARKET_INCREASE,
    executionLamports: ORDER_EXECUTION_LAMPORTS,
    initialCollateralDeltaAmount: collateralRaw,
    sizeDeltaValue: usdToGm(sizeUsd),
    isLong,
    // A long increase buys: the worst price is above the index.
    acceptablePrice: unitPrice(index.usd * (isLong ? 1 + slippage : 1 - slippage), entry.indexDecimals),
  };

  // Step 1 (once per margin) and step 2 (once per market and side), each its own wallet transaction.
  if (!p.venue.userExists) {
    opts.onStatus?.("Setting up your GMTrade account");
    await send(signer, [...venuePrep(p, null, isLong), await venueCall(p, prepareUserData(), prepareUserAccounts(venueAccount), null, false)], "Set up GMTrade account", tables, opts);
    p = await loadPerpsContext(signer.publicKey);
  }
  const positionKey = preparePositionAccounts(venueAccount, entry, collateral, isLong)[3].pubkey;
  const positionInfo: AccountInfo<Buffer> | null = await getConnection().getAccountInfo(positionKey);
  if (!positionInfo || !positionInfo.owner.equals(GMTRADE_PROGRAM_ID)) {
    opts.onStatus?.(`Preparing your ${name} ${req.side} position`);
    await send(
      signer,
      [...venuePrep(p, null, isLong), await venueCall(p, preparePositionData(params), preparePositionAccounts(venueAccount, entry, collateral, isLong), entry.leg, false)],
      `Prepare ${name} ${req.side}`,
      tables,
      opts,
    );
    p = await loadPerpsContext(signer.publicKey);
  }

  // Step 3: the order.
  const order = await venueCall(p, createOrderData(params, entry.leg), createOrderAccounts(venueAccount, entry, collateral, isLong, true), entry.leg, true);
  const signature = await send(signer, [...venuePrep(p, entry, isLong), ...p.ctx.instructions, order], `${isLong ? "Long" : "Short"} ${name} ${req.leverage}x`, tables, opts);
  const fill = await awaitFill(signer.publicKey, gmOrderPda(venueAccount, entry.leg, isLong), opts.onStatus);
  const label = `${isLong ? "Long" : "Short"} ${name} ${req.leverage}x`;
  return { signature, summary: fill ? `${label} filled at $${fill.price.toFixed(2)}` : `${label} order placed` };
}

/** `public_venue_settle` from the wallet: sweeps the venue account's USDC back to the margin vault. */
async function settle(signer: TxSigner, opts: MarginServiceOptions, tables: AddressLookupTableAccount[]): Promise<string> {
  const owner = signer.publicKey;
  const margin = marginPda(owner);
  const connection = getConnection();
  const [book, snapshot, assetMap] = await Promise.all([fetchMarketBook(connection), fetchMarginSnapshot(owner), fetchAllAssetConfigs(connection)]);
  if (!book) throw new Error("GMTrade market book not found");
  const venueAsset = [...assetMap.values()].find((a) => a.kind === "venue")!;
  const usdc = [...assetMap.values()].find((a) => a.kind === "token" && a.mint.equals(book.collateralMint))!;
  const venueAccount = venueAccountOf(margin);
  const legs = legsOf(snapshot.raw, venueAsset.assetIndex);
  const ix = await getProgram()
    .methods.publicVenueSettle()
    .accountsStrict({
      caller: owner,
      protocolConfig: protocolConfigPda(),
      marginAccount: margin,
      venueAsset: venueAsset.address,
      settleAsset: assetConfigPda(book.collateralMint),
      settleMint: book.collateralMint,
      venueAccount,
      idle: venueIdleAccount(venueAccount, book.collateralMint),
      marginVault: marginVault(margin, usdc.mint, usdc.tokenProgram),
      oracle: ORACLE_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as never)
    // The venue price accounts for the open legs, with no oracle program in front.
    .remainingAccounts(venueOracleAccounts(venueAccount, book, legs).map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })))
    .instruction();
  opts.onStatus?.("Settling USDC back to your margin account");
  return sendInstructions([ix], { signer, label: "Settle GMTrade", computeUnits: 600_000, lookupTables: tables, onStatus: opts.onStatus as never });
}

/** Closes (or partly closes) a position, then settles its USDC back into the margin account. */
export async function closePerp(req: ClosePerpRequest, opts: MarginServiceOptions = {}): Promise<PerpTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const isLong = req.side === "long";
  opts.onStatus?.("Refreshing oracle prices");
  await ensureFreshPrices();
  const p = await loadPerpsContext(signer.publicKey);
  const entry = entryFor(p.book, req.market);
  const name = entry.meta?.name ?? `${req.market}-PERP`;
  const market = p.venue.markets.find((m) => m.entry.leg === entry.leg);
  const position = market?.positions[isLong ? 0 : 1];
  if (!position) throw new Error(`No open ${name} ${req.side}`);
  if (market?.orders[isLong ? 0 : 1]) throw new Error("This position has a pending order — wait for it or cancel it first");
  const index = market?.indexPrice;
  if (!index) throw new Error("Price feed is updating, try again in a moment");
  const full = req.sizeUsd === undefined || req.sizeUsd >= position.sizeUsd - 1e-6;
  const slippage = (req.slippageBps ?? 100) / 10_000;
  const params: OrderParams = {
    kind: MARKET_DECREASE,
    executionLamports: ORDER_EXECUTION_LAMPORTS,
    initialCollateralDeltaAmount: 0n,
    sizeDeltaValue: full ? position.raw.sizeInUsd : usdToGm(req.sizeUsd!),
    isLong,
    // A long close sells (worst price below the index); a short close buys (above).
    acceptablePrice: unitPrice(index.usd * (isLong ? 1 - slippage : 1 + slippage), entry.indexDecimals),
  };
  const tables = await lookupTables(signer.publicKey);
  const venueAccount = venueAccountOf(p.ctx.margin);
  const order = await venueCall(p, createOrderData(params, entry.leg), createOrderAccounts(venueAccount, entry, p.book.collateralMint, isLong, false), entry.leg, false);
  await send(signer, [...venuePrep(p, entry, isLong), order], `Close ${name} ${req.side}`, tables, opts);
  const fill = await awaitFill(signer.publicKey, gmOrderPda(venueAccount, entry.leg, isLong), opts.onStatus);
  const signature = await settle(signer, opts, tables);
  return {
    signature,
    summary: fill ? `Closed ${name} ${req.side} at $${fill.price.toFixed(2)} — ${fill.payoutUsdc.toFixed(2)} USDC back to margin` : `Close order placed for ${name} ${req.side}`,
  };
}

/** Cancels a pending order; its escrowed USDC is refunded and settled back into the margin account. */
export async function cancelPerpOrder(req: CancelPerpRequest, opts: MarginServiceOptions = {}): Promise<PerpTxResult> {
  const signer = opts.signer ?? getActiveSigner();
  const isLong = req.side === "long";
  opts.onStatus?.("Refreshing oracle prices");
  await ensureFreshPrices();
  const p = await loadPerpsContext(signer.publicKey);
  const entry = entryFor(p.book, req.market);
  const pending = p.venue.markets.find((m) => m.entry.leg === entry.leg)?.orders[isLong ? 0 : 1];
  if (!pending) throw new Error("No pending order to cancel");
  const tables = await lookupTables(signer.publicKey);
  const venueAccount = venueAccountOf(p.ctx.margin);
  const ix = await venueCall(p, closeOrderData("cancelled by owner"), closeOrderAccounts(venueAccount, entry, p.book.collateralMint, isLong, pending.increase), entry.leg, false);
  await send(signer, [...venuePrep(p, null, isLong), ix], `Cancel ${entry.meta?.name ?? req.market} order`, tables, opts);
  const signature = await settle(signer, opts, tables);
  return { signature, summary: "Order cancelled — USDC back to your margin account" };
}
