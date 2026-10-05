/**
 * GMTrade (GMX-Solana) perps as the Vanna agents see them — the client mirror of
 * `vanna-credit-layer/programs/vanna_oracle/src/{gmtrade,gmtrade_accounts}.rs`,
 * `programs/vanna_validator/src/gmtrade.rs` and the scripts' `scripts/src/gmtrade.ts`
 * (Frontend Integration Guide, "GMTrade: perpetual positions").
 *
 * A margin trades every listed market through ONE venue account, the core PDA
 * `["venue_account", margin, store]`: a plain system account that owns the margin's GMTrade user,
 * orders and positions, and that Vanna signs for in `margin_execute`. Each listed market is a "leg"
 * (its index in the oracle's market book — read it, never hard-code it). Per (market, side) there is
 * one order slot (nonce `[1 long | 2 short, leg, 0…]`) and one position PDA.
 *
 * Pure: no React, no wallet — safe to import from server routes and scripts.
 */
import { Buffer } from "buffer";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, type AccountInfo, type AccountMeta } from "@solana/web3.js";
import { decodeOracleConfig, oracleAccounts, type OracleConfigState } from "./oracle";
import { marketBookPda, venueAccountPda } from "./pdas";

export const GMTRADE_PROGRAM_ID = new PublicKey("Gmso1uvJnLbawvw7yezdfCDcPydwW2s2iqG3w6MDucLo");
/** The GMTrade store = the venue (its AssetConfig is `["asset", store]`). */
export const GMTRADE_STORE = new PublicKey("CTDLvGGXnoxvqLyTpGzdGLg9pD6JexKxKXSV8tqqo8bN");
/** GMTrade USD amounts carry 20 decimals. */
export const USD_UNIT = 10n ** 20n;
const FUNDING_ADJUSTMENT = 10n ** 10n;

/** Display metadata for the markets this app shows (the market book is the source of truth). */
export interface PerpMarketMeta {
  key: string;
  name: string;
  market: PublicKey;
  /** TradingView symbol for the chart. */
  chart: string;
  icon: string;
}

export const PERP_MARKETS: PerpMarketMeta[] = [
  { key: "ETH", name: "ETH-PERP", market: new PublicKey("6EnZdBzJsGznoh857PuhbrnrzWYGtZe6xMZiQjAPyFGT"), chart: "PYTH:ETHUSD", icon: "/coins/eth.svg" },
  { key: "BTC", name: "BTC-PERP", market: new PublicKey("4tM9cPqNpEYmstNdJMCc6rwdq42939w1SRFYoqMsqPQF"), chart: "PYTH:BTCUSD", icon: "/coins/btc.svg" },
  { key: "SOL", name: "SOL-PERP", market: new PublicKey("CJg17Dn4xgUyEW3gKSSyteNw7LhP1o9pzm9eLtvuNjkQ"), chart: "PYTH:SOLUSD", icon: "/coins/sol.svg" },
];

export const marketBook = (): PublicKey => marketBookPda(GMTRADE_STORE);
export const venueAccountOf = (margin: PublicKey): PublicKey => venueAccountPda(margin, GMTRADE_STORE);

// ---------------------------------------------------------------------------------------------
// Market book (oracle agent)
// ---------------------------------------------------------------------------------------------

export interface MarketBookEntry {
  leg: number;
  market: PublicKey;
  marketToken: PublicKey;
  indexDecimals: number;
  tradingEnabled: boolean;
  /** Leverage cap, bps (50_000 = 5x). */
  maxLeverageBps: number;
  indexPrice: OracleConfigState;
  meta: PerpMarketMeta | null;
}

export interface MarketBookState {
  venue: PublicKey;
  gmtradeProgram: PublicKey;
  collateralMint: PublicKey;
  collateralDecimals: number;
  collateralPrice: OracleConfigState;
  markets: MarketBookEntry[];
}

/**
 * `MarketBook` (zero-copy): disc 8 | venue 32 | gmtrade_program 32 | collateral_mint 32 |
 * collateral_decimals u8 | bump u8 | market_count u8 | padding u8 | collateral_price OracleConfig 184 |
 * 32 × MarketEntry (market 32 | market_token 32 | index_decimals u8 | trading_enabled u8 | padding 2 |
 * max_leverage_bps u32 | index_price OracleConfig 184 = 256 bytes).
 */
export function decodeMarketBook(data: Buffer): MarketBookState {
  const key = (at: number) => new PublicKey(data.subarray(at, at + 32));
  const markets: MarketBookEntry[] = [];
  for (let leg = 0; leg < data[106]; leg++) {
    const at = 292 + 256 * leg;
    const market = key(at);
    markets.push({
      leg,
      market,
      marketToken: key(at + 32),
      indexDecimals: data[at + 64],
      tradingEnabled: data[at + 65] !== 0,
      maxLeverageBps: data.readUInt32LE(at + 68),
      indexPrice: decodeOracleConfig(data, at + 72),
      meta: PERP_MARKETS.find((m) => m.market.equals(market)) ?? null,
    });
  }
  return {
    venue: key(8),
    gmtradeProgram: key(40),
    collateralMint: key(72),
    collateralDecimals: data[104],
    collateralPrice: decodeOracleConfig(data, 108),
    markets,
  };
}

// ---------------------------------------------------------------------------------------------
// GMTrade accounts
// ---------------------------------------------------------------------------------------------

const enc = (s: string) => Buffer.from(s, "utf8");

export function orderNonce(leg: number, isLong: boolean): Buffer {
  const nonce = Buffer.alloc(32);
  nonce[0] = isLong ? 1 : 2;
  nonce[1] = leg;
  return nonce;
}

export const gmUserPda = (owner: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([enc("user"), GMTRADE_STORE.toBuffer(), owner.toBuffer()], GMTRADE_PROGRAM_ID)[0];

export const gmOrderPda = (owner: PublicKey, leg: number, isLong: boolean): PublicKey =>
  PublicKey.findProgramAddressSync([enc("order"), GMTRADE_STORE.toBuffer(), owner.toBuffer(), orderNonce(leg, isLong)], GMTRADE_PROGRAM_ID)[0];

export const gmPositionPda = (owner: PublicKey, marketToken: PublicKey, collateral: PublicKey, isLong: boolean): PublicKey =>
  PublicKey.findProgramAddressSync(
    [enc("position"), GMTRADE_STORE.toBuffer(), owner.toBuffer(), marketToken.toBuffer(), collateral.toBuffer(), Buffer.from([isLong ? 1 : 2])],
    GMTRADE_PROGRAM_ID,
  )[0];

/** An order's USDC escrow = ATA(USDC, order PDA). */
export const gmEscrow = (order: PublicKey, collateral: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(collateral, order, true, TOKEN_PROGRAM_ID);

/** The venue account's idle USDC (decrease output, refunds) = ATA(USDC, venue account). */
export const venueIdleAccount = (venueAccount: PublicKey, collateral: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(collateral, venueAccount, true, TOKEN_PROGRAM_ID);

export const GMTRADE_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([enc("__event_authority")], GMTRADE_PROGRAM_ID)[0];
export const GMTRADE_STORE_WALLET = PublicKey.findProgramAddressSync([enc("store_wallet"), GMTRADE_STORE.toBuffer()], GMTRADE_PROGRAM_ID)[0];

const u128At = (data: Buffer, at: number) => data.readBigUInt64LE(at) + (data.readBigUInt64LE(at + 8) << 64n);

export interface GmMarketState {
  longToken: PublicKey;
  shortToken: PublicKey;
  closeFeeFactor: bigint;
  /** [long, short]. */
  borrowingFactor: [bigint, bigint];
  /** [position side][collateral side]. */
  fundingPerSize: [[bigint, bigint], [bigint, bigint]];
}

/** GMTrade `Market` (8 + 9168 bytes): the fields the oracle agent reads (`read_market`). */
export function decodeGmMarket(data: Buffer): GmMarketState {
  const key = (at: number) => new PublicKey(data.subarray(at, at + 32));
  const pool = (index: number): [bigint, bigint] => {
    const base = 8 + 1952 + 64 * index;
    const [long, short] = [u128At(data, base + 32), u128At(data, base + 48)];
    return data[base + 16] === 0 ? [long, short] : [(long + 1n) / 2n, long / 2n];
  };
  return {
    longToken: key(8 + 144),
    shortToken: key(8 + 176),
    closeFeeFactor: u128At(data, 8 + 560),
    borrowingFactor: pool(8),
    fundingPerSize: [pool(9), pool(10)],
  };
}

export interface GmPosition {
  sizeInTokens: bigint;
  collateralAmount: bigint;
  sizeInUsd: bigint;
  borrowingFactor: bigint;
  fundingFeeAmountPerSize: bigint;
}

/** Position account fields: u128s at these offsets after the 8-byte discriminator. */
export function decodeGmPosition(data: Buffer): GmPosition {
  const at = (i: number) => u128At(data, 8 + i);
  return { sizeInTokens: at(176), collateralAmount: at(192), sizeInUsd: at(208), borrowingFactor: at(224), fundingFeeAmountPerSize: at(240) };
}

export function encodeGmPosition(template: Buffer, p: GmPosition): Buffer {
  const data = Buffer.from(template);
  const put = (i: number, v: bigint) => {
    data.writeBigUInt64LE(v & ((1n << 64n) - 1n), 8 + i);
    data.writeBigUInt64LE(v >> 64n, 8 + i + 8);
  };
  put(176, p.sizeInTokens);
  put(192, p.collateralAmount);
  put(208, p.sizeInUsd);
  put(224, p.borrowingFactor);
  put(240, p.fundingFeeAmountPerSize);
  return data;
}

export const isEmptyPosition = (p: GmPosition) => p.sizeInUsd === 0n && p.sizeInTokens === 0n && p.collateralAmount === 0n;

export interface GmOrder {
  kind: number;
  initialCollateralDeltaAmount: bigint;
  sizeDeltaValue: bigint;
}

export function decodeGmOrder(data: Buffer): GmOrder {
  return { kind: data[8 + 2096], initialCollateralDeltaAmount: data.readBigUInt64LE(8 + 2168), sizeDeltaValue: u128At(data, 8 + 2176) };
}

export const isGmAccount = (info: AccountInfo<Buffer> | null | undefined): info is AccountInfo<Buffer> =>
  !!info && info.owner.equals(GMTRADE_PROGRAM_ID) && info.data.length > 0;

// ---------------------------------------------------------------------------------------------
// Valuation — exactly `vanna_oracle::gmtrade::position_equity`, in nano-USD
// ---------------------------------------------------------------------------------------------

const NANO_PER_USD_UNIT = USD_UNIT / 1_000_000_000n;

/** `value_of`: amount × (value × 10^exponent), normalised to nano-USD. */
export function valueNano(amount: bigint, value: bigint, exponent: number, decimals: number, roundUp: boolean): bigint {
  const net = exponent - decimals + 9;
  if (net >= 0) return amount * value * 10n ** BigInt(net);
  const factor = 10n ** BigInt(-net);
  const product = amount * value;
  return roundUp ? (product + factor - 1n) / factor : product / factor;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const usdToNano = (usd: bigint, roundUp: boolean) => (roundUp ? ceilDiv(usd, NANO_PER_USD_UNIT) : usd / NANO_PER_USD_UNIT);
const sat = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

export interface Quote {
  value: bigint;
  exponent: number;
}

/**
 * A position's equity the way the oracle values it on every health check: collateral + PnL at the
 * index price − pending borrowing fee − pending funding fee − close fee, floored at 0. Rounds
 * against the trader like the program (gain down, costs up).
 */
export function positionEquityNano(
  p: GmPosition,
  isLong: boolean,
  collateralSideIsLong: boolean,
  market: GmMarketState,
  index: Quote,
  indexDecimals: number,
  collateral: Quote,
  collateralDecimals: number,
): bigint {
  if (isEmptyPosition(p)) return 0n;
  const side = isLong ? 0 : 1;
  const collateralValue = valueNano(p.collateralAmount, collateral.value, collateral.exponent, collateralDecimals, false);
  const tokensValue = valueNano(p.sizeInTokens, index.value, index.exponent, indexDecimals, !isLong);
  const sizeUsd = usdToNano(p.sizeInUsd, isLong);
  const sizeUsdUp = usdToNano(p.sizeInUsd, true);
  const borrowingFee = ceilDiv(sizeUsdUp * sat(market.borrowingFactor[side], p.borrowingFactor), USD_UNIT);
  const fundingDelta = sat(market.fundingPerSize[side][collateralSideIsLong ? 0 : 1], p.fundingFeeAmountPerSize);
  const fundingAmount = ceilDiv(ceilDiv(p.sizeInUsd, FUNDING_ADJUSTMENT) * fundingDelta, USD_UNIT);
  const fundingFee = valueNano(fundingAmount, collateral.value, collateral.exponent, collateralDecimals, true);
  const closeFee = ceilDiv(sizeUsdUp * market.closeFeeFactor, USD_UNIT);
  const [gain, cost] = isLong ? [tokensValue, sizeUsd] : [sizeUsd, tokensValue];
  return sat(collateralValue + gain, cost + borrowingFee + fundingFee + closeFee);
}

// ---------------------------------------------------------------------------------------------
// Instructions (the validator's allowed set)
// ---------------------------------------------------------------------------------------------

export const MARKET_INCREASE = 3;
export const MARKET_DECREASE = 4;
const DISCRIMINATORS = {
  prepareUser: [190, 173, 143, 193, 139, 80, 231, 133],
  preparePosition: [178, 215, 55, 90, 137, 15, 108, 15],
  createOrderV2: [200, 157, 3, 182, 3, 164, 162, 240],
  closeOrderV2: [213, 217, 98, 100, 225, 205, 76, 184],
  closeEmptyPosition: [175, 105, 138, 38, 237, 235, 250, 59],
};

export interface OrderParams {
  kind: number;
  /** Keeper fee paid from the venue account's SOL. */
  executionLamports: bigint;
  /** Increase: USDC (base units) to add. Decrease: USDC to take out. */
  initialCollateralDeltaAmount: bigint;
  /** Size change, USD × 10^20. */
  sizeDeltaValue: bigint;
  isLong: boolean;
  /** Worst fill price, USD × 10^20 / 10^index decimals; null = no limit. */
  acceptablePrice: bigint | null;
}

/** Keeper fee per order (the scripts' value). */
export const ORDER_EXECUTION_LAMPORTS = 300_000n;
/** Keep the venue account at this many lamports before every GMTrade call (0.05 SOL). */
export const VENUE_ACCOUNT_LAMPORTS = 50_000_000;

const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const u128 = (v: bigint) => Buffer.concat([u64(v & ((1n << 64n) - 1n)), u64(v >> 64n)]);
const option = (v: Buffer | null) => (v ? Buffer.concat([Buffer.from([1]), v]) : Buffer.from([0]));

/** Order params, Borsh, in the guide's field order. `is_collateral_long` = true (USDC is the long token). */
function paramsData(p: OrderParams): Buffer {
  return Buffer.concat([
    Buffer.from([p.kind]),
    option(null),
    u64(p.executionLamports),
    Buffer.from([0]),
    u64(p.initialCollateralDeltaAmount),
    u128(p.sizeDeltaValue),
    Buffer.from([p.isLong ? 1 : 0, 1]),
    option(null),
    option(null),
    option(p.acceptablePrice === null ? null : u128(p.acceptablePrice)),
    Buffer.from([0]),
    option(null),
  ]);
}

export const prepareUserData = () => Buffer.from(DISCRIMINATORS.prepareUser);
export const preparePositionData = (p: OrderParams) => Buffer.concat([Buffer.from(DISCRIMINATORS.preparePosition), paramsData(p)]);
export const createOrderData = (p: OrderParams, leg: number) =>
  Buffer.concat([Buffer.from(DISCRIMINATORS.createOrderV2), orderNonce(leg, p.isLong), paramsData(p), option(null)]);
export const closeEmptyPositionData = () => Buffer.from(DISCRIMINATORS.closeEmptyPosition);
export function closeOrderData(reason: string): Buffer {
  const text = Buffer.from(reason, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(text.length);
  return Buffer.concat([Buffer.from(DISCRIMINATORS.closeOrderV2), len, text]);
}

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
/** "Unset" = the GMTrade program id (Anchor's None). */
const unset = () => ro(GMTRADE_PROGRAM_ID);

export function prepareUserAccounts(venueAccount: PublicKey): AccountMeta[] {
  return [w(venueAccount), ro(GMTRADE_STORE), w(gmUserPda(venueAccount)), ro(SystemProgram.programId)];
}

export function preparePositionAccounts(venueAccount: PublicKey, entry: MarketBookEntry, collateral: PublicKey, isLong: boolean): AccountMeta[] {
  return [w(venueAccount), ro(GMTRADE_STORE), ro(entry.market), w(gmPositionPda(venueAccount, entry.marketToken, collateral, isLong)), ro(SystemProgram.programId)];
}

/** `create_order_v2`'s 25 call accounts (guide table "create_order_v2 call accounts"). */
export function createOrderAccounts(venueAccount: PublicKey, entry: MarketBookEntry, collateral: PublicKey, isLong: boolean, increase: boolean): AccountMeta[] {
  const order = gmOrderPda(venueAccount, entry.leg, isLong);
  const escrow = gmEscrow(order, collateral);
  const onIncrease = (meta: AccountMeta) => (increase ? meta : unset());
  return [
    w(venueAccount),
    ro(venueAccount),
    ro(GMTRADE_STORE),
    w(entry.market),
    w(gmUserPda(venueAccount)),
    w(order),
    w(gmPositionPda(venueAccount, entry.marketToken, collateral, isLong)),
    onIncrease(ro(collateral)),
    ro(collateral),
    ro(collateral),
    ro(collateral),
    onIncrease(w(escrow)),
    w(escrow),
    w(escrow),
    w(escrow),
    onIncrease(w(venueIdleAccount(venueAccount, collateral))),
    ro(SystemProgram.programId),
    ro(TOKEN_PROGRAM_ID),
    ro(ASSOCIATED_TOKEN_PROGRAM_ID),
    unset(),
    unset(),
    unset(),
    unset(),
    ro(GMTRADE_EVENT_AUTHORITY),
    ro(GMTRADE_PROGRAM_ID),
  ];
}

/** `close_order_v2`'s 30 call accounts (guide table "Cancel a pending order"). */
export function closeOrderAccounts(venueAccount: PublicKey, entry: MarketBookEntry, collateral: PublicKey, isLong: boolean, increase: boolean): AccountMeta[] {
  const order = gmOrderPda(venueAccount, entry.leg, isLong);
  const escrow = gmEscrow(order, collateral);
  const refund = venueIdleAccount(venueAccount, collateral);
  const initial = (meta: AccountMeta) => (increase ? meta : unset());
  const output = (meta: AccountMeta) => (increase ? unset() : meta);
  return [
    w(venueAccount),
    w(GMTRADE_STORE),
    w(GMTRADE_STORE_WALLET),
    w(venueAccount),
    w(venueAccount),
    w(venueAccount),
    w(gmUserPda(venueAccount)),
    unset(),
    w(order),
    initial(ro(collateral)),
    output(ro(collateral)),
    ro(collateral),
    ro(collateral),
    initial(w(escrow)),
    output(w(escrow)),
    w(escrow),
    w(escrow),
    initial(w(refund)),
    output(w(refund)),
    w(refund),
    w(refund),
    ro(SystemProgram.programId),
    ro(TOKEN_PROGRAM_ID),
    ro(ASSOCIATED_TOKEN_PROGRAM_ID),
    unset(),
    unset(),
    unset(),
    unset(),
    ro(GMTRADE_EVENT_AUTHORITY),
    ro(GMTRADE_PROGRAM_ID),
  ];
}

// ---------------------------------------------------------------------------------------------
// Agent accounts
// ---------------------------------------------------------------------------------------------

export const legBit = (leg: number) => 1n << BigInt(leg);

/**
 * What the oracle reads to value a venue account over `legs` (guide "Price accounts", GMTrade venue):
 * the market book, the USDC price accounts, the venue account's USDC ATA, then per leg its market,
 * index price accounts, both order PDAs, both escrows and both positions.
 */
export function venueOracleAccounts(venueAccount: PublicKey, book: MarketBookState, legs: bigint): PublicKey[] {
  const collateral = book.collateralMint;
  const keys = [marketBook(), ...oracleAccounts(book.collateralPrice), venueIdleAccount(venueAccount, collateral)];
  for (const entry of book.markets.filter((e) => (legs & legBit(e.leg)) !== 0n)) {
    keys.push(entry.market, ...oracleAccounts(entry.indexPrice));
    for (const isLong of [true, false]) {
      const order = gmOrderPda(venueAccount, entry.leg, isLong);
      keys.push(order, gmEscrow(order, collateral), gmPositionPda(venueAccount, entry.marketToken, collateral, isLong));
    }
  }
  return keys;
}

/** The validator segment's accounts for a GMTrade call: `[market_book]`. */
export const validatorAccounts = (): PublicKey[] => [marketBook()];
