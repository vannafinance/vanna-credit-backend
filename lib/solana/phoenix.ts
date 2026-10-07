/**
 * Phoenix perps (Ellipsis Labs' perpetuals exchange) as a Vanna venue — accounts, decoders,
 * instruction data and the valuation the oracle agent uses (port of vanna-credit-layer
 * `programs/vanna_oracle/src/phoenix.rs` and `scripts/src/phoenix.ts`).
 *
 * How a margin trades on Phoenix (every step a `margin_execute`, health-checked after it):
 *   1. Ember deposit: margin USDC vault → phUSD (Phoenix's canonical USDC) in the margin's phUSD vault.
 *   2. Phoenix `deposit_funds`: phUSD vault → the margin's Phoenix trader account (cross margin).
 *   3. Phoenix `place_market_order`: an immediate-or-cancel order, filled against the book right away
 *      (no keeper, no pending orders). The validator caps leverage per market (market book).
 *   4. Close: a reduce-only market order for the whole position.
 *   5. Phoenix `withdraw_funds`: trader → phUSD vault (only when Phoenix pays now, never queued).
 *   6. Ember withdraw: phUSD → USDC back in the margin's USDC vault.
 *
 * The trader account is the PDA `["trader", margin, 0u16]` of the Phoenix program, owned (as
 * authority) by the margin account itself. The venue holding is keyed by the Phoenix exchange
 * (global config) and valued as collateral + Σ position equity (index price, funding owed and the
 * taker fee to close), floored at zero.
 */
import { Buffer } from "buffer";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountInfo, type AccountMeta, type Connection } from "@solana/web3.js";
import { marketBookPda } from "./pdas";
import { decodeOracleConfig, oracleAccounts, type OracleConfigState } from "./oracle";

export const PHOENIX_PROGRAM_ID = new PublicKey("EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih");
export const EMBER_PROGRAM_ID = new PublicKey("EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy");
/** Phoenix's global config — the venue key (its asset config and market book are keyed by it). */
export const PHOENIX_EXCHANGE = new PublicKey("2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ");
export const PHOENIX_LOG_AUTHORITY = new PublicKey("GdxfTLSsdSY37G6fZoYtdGDSfgFnbT2EmRpuePZxWShS");
/** phUSD — Phoenix's canonical USDC (Ember-wrapped 1:1); a collateral-only Vanna asset priced as USDC. */
export const PHUSD_MINT = new PublicKey("PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A");

const enc = (s: string) => Buffer.from(s, "utf8");

export const DEPOSIT_FUNDS = [202, 39, 52, 211, 53, 20, 250, 88];
export const WITHDRAW_FUNDS = [241, 36, 29, 111, 208, 31, 104, 217];
export const PLACE_MARKET_ORDER = [90, 118, 192, 252, 192, 99, 39, 145];
export const EMBER_DEPOSIT = [242, 35, 198, 137, 82, 225, 242, 182];
export const EMBER_WITHDRAW = [183, 18, 70, 156, 148, 109, 161, 34];
/** sha256("global:register_trader")[..8]. */
export const REGISTER_TRADER = [75, 243, 224, 167, 1, 5, 51, 32];

export const BID = 0;
export const ASK = 1;
const IMMEDIATE_OR_CANCEL = 2;
const REDUCE_ONLY = 128;
/** A trader entry key at or above this is an extension (native SOL), not a perp position. */
const EXTENSION_KEY = 0xff000000n;

/** The Phoenix markets Vanna lists (the oracle market book holds the leverage caps). */
export interface PerpMarketMeta {
  /** "SOL" | "ETH" | "BTC" | "TSLA" | "META" — Phoenix's own symbol and the app's market key. */
  key: string;
  name: string;
  icon: string;
  chartSymbol: string;
}

export const PERP_MARKETS: PerpMarketMeta[] = [
  { key: "SOL", name: "SOL-PERP", icon: "/coins/sol.svg", chartSymbol: "PYTH:SOLUSD" },
  { key: "ETH", name: "ETH-PERP", icon: "/coins/eth.svg", chartSymbol: "PYTH:ETHUSD" },
  { key: "BTC", name: "BTC-PERP", icon: "/coins/btc.svg", chartSymbol: "PYTH:BTCUSD" },
  { key: "TSLA", name: "TSLA-PERP", icon: "/coins/tslax.png", chartSymbol: "NASDAQ:TSLA" },
  { key: "META", name: "META-PERP", icon: "/coins/meta.png", chartSymbol: "NASDAQ:META" },
];

// ---------------------------------------------------------------------------------------------
// Phoenix accounts
// ---------------------------------------------------------------------------------------------

const key = (data: Buffer, at: number) => new PublicKey(data.subarray(at, at + 32));

export interface PhoenixExchangeState {
  /** phUSD: the canonical (Ember-wrapped) USDC Phoenix accounts collateral in. */
  canonicalMint: PublicKey;
  globalVault: PublicKey;
  perpAssetMap: PublicKey;
  /** Header + extra arenas, all passed (writable) to deposit / withdraw / order. */
  traderIndex: PublicKey[];
  activeBuffer: PublicKey[];
  withdrawQueue: PublicKey;
  emberState: PublicKey;
  emberVault: PublicKey;
}

function arenaKeys(header: PublicKey, count: number, seed: string): PublicKey[] {
  const extra = Array.from({ length: Math.max(count - 1, 0) }, (_, i) => PublicKey.findProgramAddressSync([enc(seed), Buffer.from([i + 1])], PHOENIX_PROGRAM_ID)[0]);
  return [header, ...extra];
}

/** The exchange (global config) and its arenas' sizes, from three account reads. */
export async function readPhoenixExchange(connection: Connection): Promise<PhoenixExchangeState> {
  const info = await connection.getAccountInfo(PHOENIX_EXCHANGE);
  if (!info) throw new Error("Phoenix exchange not found on this network");
  const d = Buffer.from(info.data);
  const traderHeader = key(d, 392);
  const bufferHeader = key(d, 424);
  const [t, b] = await connection.getMultipleAccountsInfo([traderHeader, bufferHeader], { dataSlice: { offset: 0, length: 64 } } as never);
  return {
    canonicalMint: key(d, 296),
    globalVault: key(d, 328),
    perpAssetMap: key(d, 360),
    traderIndex: arenaKeys(traderHeader, t ? Buffer.from(t.data).readUInt16LE(52) : 1, "global_trader_index"),
    activeBuffer: arenaKeys(bufferHeader, b ? Buffer.from(b.data).readUInt16LE(52) : 1, "active_trader_buffer"),
    withdrawQueue: key(d, 472),
    emberState: PublicKey.findProgramAddressSync([PHOENIX_PROGRAM_ID.toBuffer(), enc("state")], EMBER_PROGRAM_ID)[0],
    emberVault: PublicKey.findProgramAddressSync([PHOENIX_PROGRAM_ID.toBuffer(), enc("vault")], EMBER_PROGRAM_ID)[0],
  };
}

/** One market of Phoenix's perp asset map. */
export interface PhoenixMarketState {
  symbol: string;
  assetId: number;
  orderbook: PublicKey;
  spline: PublicKey;
  /** Quote atoms (micro-USD) per base lot per tick. */
  tickSize: bigint;
  /** Base lots per token = 10^lotDecimals (can be negative). */
  lotDecimals: number;
  markTicks: bigint;
  cumulativeFunding: bigint;
  isolatedOnly: boolean;
}

/** Decodes the perp asset map (`PerpAssetMap`): 48-byte header, 1584 bytes per asset. */
export function decodePerpAssetMap(data: Buffer): PhoenixMarketState[] {
  const markets: PhoenixMarketState[] = [];
  for (let i = 0; i < data.readUInt32LE(32); i++) {
    const base = 48 + 1584 * i;
    const meta = base + 16;
    if (data.length < meta + 1568 || data[meta + 1450] !== 0 || data[meta + 1567] !== 0) continue;
    const orderbook = key(data, meta + 904);
    markets.push({
      symbol: data.subarray(base, base + 16).toString("utf8").replace(/\0+$/, ""),
      assetId: data.readUInt16LE(meta + 944) | (data.readUInt16LE(meta + 948) << 16),
      orderbook,
      spline: PublicKey.findProgramAddressSync([enc("spline"), orderbook.toBuffer()], PHOENIX_PROGRAM_ID)[0],
      tickSize: data.readBigUInt64LE(meta + 936),
      lotDecimals: data.readInt8(meta + 946),
      markTicks: data.readBigUInt64LE(meta + 24),
      cumulativeFunding: data.readBigInt64LE(meta + 1312),
      isolatedOnly: data[meta + 1208] !== 0,
    });
  }
  return markets;
}

/**
 * Reads only the used part of the perp asset map (~150 KB instead of its 1.6 MB capacity): the
 * 48-byte header gives the asset count, then 1584 bytes per asset.
 */
export async function fetchPerpAssetMap(connection: Connection, address: PublicKey, knownUsed?: number): Promise<PhoenixMarketState[]> {
  let used = knownUsed;
  if (used === undefined) {
    const head = await connection.getAccountInfo(address, { dataSlice: { offset: 0, length: 48 } });
    if (!head) return [];
    used = Buffer.from(head.data).readUInt32LE(32);
  }
  const info = await connection.getAccountInfo(address, { dataSlice: { offset: 0, length: 48 + 1584 * used } });
  return info ? decodePerpAssetMap(Buffer.from(info.data)) : [];
}

/** Orderbook header bytes the app needs (`decodeOrderbook` reads up to byte 100). */
export const ORDERBOOK_HEADER_LEN = 104;

/** The orderbook header fields the oracle reads (`read_market`). */
export interface PhoenixOrderbookState {
  status: number;
  lotDecimals: number;
  assetId: number;
  tickSize: bigint;
  /** Taker fee, millionths of the notional. */
  takerFeeMicro: number;
}

export function decodeOrderbook(data: Buffer): PhoenixOrderbookState {
  return {
    status: data[8],
    lotDecimals: data.readInt8(9),
    assetId: data.readUInt32LE(32),
    tickSize: data.readBigUInt64LE(56),
    takerFeeMicro: data.readUInt32LE(96),
  };
}

export interface PhoenixPosition {
  assetId: number;
  baseLots: bigint;
  virtualQuoteLots: bigint;
  fundingSnapshot: bigint;
}

/** Trader flags (u32 at 96): bit 0 = hot; bits 1-5 = capabilities (place limit, place market,
 * deposit collateral, withdraw, …) that Phoenix's delegated authority grants. A fresh registration
 * gets only the two order capabilities; an onboarded mainnet trader has all five (0x3e). */
export const TRADER_FLAGS_OFFSET = 96;
export const FULL_TRADER_CAPABILITIES = 0x3e;

export interface PhoenixTrader {
  /** phUSD atoms (6 decimals) of cross-margin collateral. */
  collateral: bigint;
  /** Capability bits (see {@link FULL_TRADER_CAPABILITIES}); without the deposit bit Phoenix refuses deposits. */
  capabilities: number;
  hot: boolean;
  withdrawQueued: boolean;
  positions: PhoenixPosition[];
}

/** The margin's Phoenix trader (cross subaccount 0). */
export const phoenixTraderPda = (margin: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([enc("trader"), margin.toBuffer(), Buffer.from([0, 0])], PHOENIX_PROGRAM_ID)[0];

export function decodeTrader(data: Buffer): PhoenixTrader {
  const positions: PhoenixPosition[] = [];
  const len = Number(data.readBigUInt64LE(224));
  for (let j = 0; j < len; j++) {
    const at = 240 + 40 * j;
    if (data.length < at + 40) break;
    const entry = data.readBigUInt64LE(at);
    if (entry >= EXTENSION_KEY) continue;
    positions.push({
      assetId: Number(entry & 0xffffffffn),
      baseLots: data.readBigInt64LE(at + 8),
      virtualQuoteLots: data.readBigInt64LE(at + 16),
      fundingSnapshot: data.readBigInt64LE(at + 24),
    });
  }
  const flags = data.readUInt32LE(TRADER_FLAGS_OFFSET);
  return { collateral: data.readBigInt64LE(88), capabilities: flags & FULL_TRADER_CAPABILITIES, hot: (flags & 1) !== 0, withdrawQueued: data.readUInt32LE(108) !== 0, positions };
}

/** Phoenix's withdraw budget: a withdrawal larger than what's available is queued (refused by Vanna). */
export interface WithdrawBudget {
  maxBudget: bigint;
  remainingBudget: bigint;
  replenishPerSlot: bigint;
  lastUpdateSlot: bigint;
  totalQueued: bigint;
}

export function decodeWithdrawBudget(data: Buffer): WithdrawBudget {
  return {
    maxBudget: data.readBigUInt64LE(24),
    remainingBudget: data.readBigUInt64LE(32),
    replenishPerSlot: data.readBigUInt64LE(40),
    lastUpdateSlot: data.readBigUInt64LE(48),
    totalQueued: data.readBigUInt64LE(56),
  };
}

/** `WithdrawBudget::available` at `slot`. */
export function withdrawAvailable(b: WithdrawBudget, slot: bigint): bigint {
  const refill = (slot > b.lastUpdateSlot ? slot - b.lastUpdateSlot : 0n) * b.replenishPerSlot;
  const total = b.remainingBudget + refill;
  return total < b.maxBudget ? total : b.maxBudget;
}

// ---------------------------------------------------------------------------------------------
// Vanna's Phoenix market book (oracle agent)
// ---------------------------------------------------------------------------------------------

export interface MarketBookEntry {
  /** The Phoenix orderbook. */
  market: PublicKey;
  assetId: number;
  maxLeverageBps: number;
  tradingEnabled: boolean;
  indexPrice: OracleConfigState;
}

export interface MarketBookState {
  address: PublicKey;
  venue: PublicKey;
  program: PublicKey;
  collateralMint: PublicKey;
  collateralDecimals: number;
  collateralPrice: OracleConfigState;
  markets: MarketBookEntry[];
}

export const phoenixMarketBook = (): PublicKey => marketBookPda(PHOENIX_EXCHANGE);

/** `MarketBook` (zero copy): header to 100, collateral price at 100 (184), entries at 284 (228 each). */
export function decodeMarketBook(data: Buffer): MarketBookState {
  const count = data[106];
  const markets: MarketBookEntry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 292 + 228 * i;
    markets.push({
      market: key(data, at),
      assetId: data.readUInt32LE(at + 32),
      maxLeverageBps: data.readUInt32LE(at + 36),
      tradingEnabled: data[at + 40] !== 0,
      indexPrice: decodeOracleConfig(data, at + 44),
    });
  }
  return {
    address: phoenixMarketBook(),
    venue: key(data, 8),
    program: key(data, 40),
    collateralMint: key(data, 72),
    collateralDecimals: data[104],
    collateralPrice: decodeOracleConfig(data, 108),
    markets,
  };
}

// ---------------------------------------------------------------------------------------------
// Prices and valuation
// ---------------------------------------------------------------------------------------------

/** USD per tick-priced base unit: price (USD per token) → ticks, and back. */
export function usdToTicks(m: { tickSize: bigint; lotDecimals: number }, usd: number): bigint {
  return BigInt(Math.max(1, Math.round((usd * 1e6) / (Number(m.tickSize) * 10 ** m.lotDecimals))));
}

export function ticksToUsd(m: { tickSize: bigint; lotDecimals: number }, ticks: bigint): number {
  return (Number(ticks) * Number(m.tickSize) * 10 ** m.lotDecimals) / 1e6;
}

export const lotsToTokens = (lots: bigint, lotDecimals: number): number => Number(lots) / 10 ** lotDecimals;

/**
 * A position's equity in USD exactly as the oracle computes it (`position_equity`): base value at
 * the index price + virtual quote + funding owed − the taker fee to close. USDC priced at `usdcUsd`.
 */
export function positionEquityUsd(
  p: PhoenixPosition,
  cumulativeFunding: bigint,
  indexUsd: number,
  lotDecimals: number,
  takerFeeMicro: number,
  usdcUsd: number,
): { valueUsd: number; pnlUsd: number; fundingUsd: number; feeUsd: number; equityUsd: number } {
  const valueUsd = lotsToTokens(p.baseLots, lotDecimals) * indexUsd;
  const quoteUsd = (Number(p.virtualQuoteLots) / 1e6) * usdcUsd;
  const owed = (cumulativeFunding - p.fundingSnapshot) * p.baseLots;
  const fundingUsd = (-Number(owed) / 1e6) * usdcUsd;
  const feeUsd = (Math.abs(valueUsd) * takerFeeMicro) / 1e6;
  return { valueUsd, pnlUsd: valueUsd + quoteUsd, fundingUsd, feeUsd, equityUsd: valueUsd + quoteUsd + fundingUsd - feeUsd };
}

/**
 * The oracle segment's Phoenix part for a margin (`price_keys`): market book, exchange, perp asset
 * map, the trader, the USDC price accounts, then per market `[orderbook, ...index price accounts]`
 * for the markets the trader holds plus `extraAssetIds` (a call's target market).
 */
export function phoenixOracleAccounts(margin: PublicKey, ex: PhoenixExchangeState, book: MarketBookState, assetIds: number[]): PublicKey[] {
  const keys: PublicKey[] = [book.address, PHOENIX_EXCHANGE, ex.perpAssetMap, phoenixTraderPda(margin), ...oracleAccounts(book.collateralPrice)];
  for (const id of new Set(assetIds)) {
    const entry = book.markets.find((m) => m.assetId === id);
    if (!entry) throw new Error(`Phoenix market ${id} is not in Vanna's market book`);
    keys.push(entry.market, ...oracleAccounts(entry.indexPrice));
  }
  return keys;
}

/** The validator segment for a Phoenix call: `[market_book, exchange]`. */
export const phoenixValidatorAccounts = (book: MarketBookState): PublicKey[] => [book.address, PHOENIX_EXCHANGE];

// ---------------------------------------------------------------------------------------------
// Instructions (the outside call wrapped by margin_execute)
// ---------------------------------------------------------------------------------------------

const u64 = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const option = (v: bigint | null) => (v === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), u64(v)]));
const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });

export interface MarketOrder {
  side: typeof BID | typeof ASK;
  /** Worst price accepted (required by the validator's leverage check). */
  priceInTicks: bigint;
  lots: bigint;
  reduceOnly: boolean;
  /** Reduce-only closes in liquidation fill completely or fail; app closes leave it null. */
  minBaseLotsToFill?: bigint;
}

/** `place_market_order` data (an immediate-or-cancel order; Phoenix's Borsh layout). */
export function marketOrderData(o: MarketOrder): Buffer {
  return Buffer.concat([
    Buffer.from(PLACE_MARKET_ORDER),
    Buffer.from([IMMEDIATE_OR_CANCEL, o.side]),
    option(o.priceInTicks),
    u64(o.lots),
    option(null),
    u64(o.minBaseLotsToFill ?? 0n),
    u64(0),
    Buffer.from([0]),
    option(null),
    Buffer.alloc(16),
    option(null),
    Buffer.from([o.reduceOnly ? REDUCE_ONLY : 0, 0]),
  ]);
}

export const amountData = (discriminator: number[], amount: bigint) => Buffer.concat([Buffer.from(discriminator), u64(amount)]);
/** Ember withdraw of the whole phUSD vault (None) or `amount`. */
export const emberWithdrawData = (amount: bigint | null) => Buffer.concat([Buffer.from(EMBER_WITHDRAW), option(amount)]);

const vaultOf = (margin: PublicKey, mint: PublicKey) => getAssociatedTokenAddressSync(mint, margin, true, TOKEN_PROGRAM_ID);

/** Ember (USDC ↔ phUSD) accounts: margin, state, USDC mint, phUSD mint, USDC vault, phUSD vault, Ember vault, token program. */
export function emberAccounts(ex: PhoenixExchangeState, margin: PublicKey, usdc: PublicKey): AccountMeta[] {
  return [
    ro(margin),
    ro(ex.emberState),
    ro(usdc),
    w(ex.canonicalMint),
    w(vaultOf(margin, usdc)),
    w(vaultOf(margin, ex.canonicalMint)),
    w(ex.emberVault),
    ro(TOKEN_PROGRAM_ID),
  ];
}

function head(margin: PublicKey): AccountMeta[] {
  return [ro(PHOENIX_PROGRAM_ID), ro(PHOENIX_LOG_AUTHORITY), w(PHOENIX_EXCHANGE), ro(margin)];
}

const arenas = (ex: PhoenixExchangeState) => [...ex.traderIndex, ...ex.activeBuffer].map(w);

export function depositAccounts(ex: PhoenixExchangeState, margin: PublicKey): AccountMeta[] {
  return [...head(margin), w(vaultOf(margin, ex.canonicalMint)), w(phoenixTraderPda(margin)), w(ex.globalVault), ro(TOKEN_PROGRAM_ID), ...arenas(ex)];
}

export function withdrawAccounts(ex: PhoenixExchangeState, margin: PublicKey): AccountMeta[] {
  return [
    ...head(margin),
    w(phoenixTraderPda(margin)),
    w(ex.perpAssetMap),
    w(ex.globalVault),
    w(vaultOf(margin, ex.canonicalMint)),
    ro(TOKEN_PROGRAM_ID),
    ...arenas(ex),
    w(ex.withdrawQueue),
  ];
}

export function orderAccounts(ex: PhoenixExchangeState, margin: PublicKey, market: { orderbook: PublicKey; spline: PublicKey }): AccountMeta[] {
  return [...head(margin), w(phoenixTraderPda(margin)), w(ex.perpAssetMap), ...arenas(ex), w(market.orderbook), w(market.spline)];
}

/**
 * `register_trader`: creates the margin's Phoenix trader account (cross subaccount 0, 128 position
 * slots). Permissionless — the wallet pays the rent and the margin is the trader's authority without
 * signing — so it runs as a plain instruction before the margin's first Phoenix deposit.
 */
export function registerTraderIx(payer: PublicKey, margin: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(8 + 4 + 4 + 2);
  Buffer.from(REGISTER_TRADER).copy(data, 0);
  data.writeUInt32LE(128, 8);
  data.writeUInt32LE(0, 12);
  return new TransactionInstruction({
    programId: PHOENIX_PROGRAM_ID,
    keys: [
      ro(PHOENIX_PROGRAM_ID),
      ro(PHOENIX_LOG_AUTHORITY),
      ro(PHOENIX_EXCHANGE),
      { pubkey: payer, isSigner: true, isWritable: true },
      ro(margin),
      w(phoenixTraderPda(margin)),
      ro(SystemProgram.programId),
    ],
    data,
  });
}

/** Account fetch helper shared by the state readers. */
export type AccountMap = Map<string, AccountInfo<Buffer> | null>;
