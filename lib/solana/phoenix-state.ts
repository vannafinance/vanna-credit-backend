/**
 * Reading a margin's Phoenix venue and valuing it exactly like the oracle agent does on each health
 * check (`vanna_oracle::phoenix::venue_price`): the trader's collateral + every position's equity
 * (index price, funding owed, the taker fee to close), floored at zero.
 */
import { Buffer } from "buffer";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { getMultipleAccountsChunked } from "./connection";
import { oracleAccounts, priceFromAccounts, type OraclePrice } from "./oracle";
import {
  decodeMarketBook,
  decodeOrderbook,
  fetchPerpAssetMap,
  ORDERBOOK_HEADER_LEN,
  decodeTrader,
  decodeWithdrawBudget,
  lotsToTokens,
  PERP_MARKETS,
  phoenixMarketBook,
  phoenixOracleAccounts,
  phoenixTraderPda,
  positionEquityUsd,
  readPhoenixExchange,
  ticksToUsd,
  withdrawAvailable,
  type MarketBookEntry,
  type MarketBookState,
  type PerpMarketMeta,
  type PhoenixExchangeState,
  type PhoenixMarketState,
  type PhoenixOrderbookState,
  type PhoenixTrader,
} from "./phoenix";

const NANO = 1_000_000_000;

/** One Vanna-listed Phoenix market with everything the UI and the instruction builders need. */
export interface PhoenixListedMarket {
  meta: PerpMarketMeta;
  entry: MarketBookEntry;
  market: PhoenixMarketState;
  orderbook: PhoenixOrderbookState | null;
  /** Index price the oracle values positions at (null when no source is usable). */
  index: OraclePrice | null;
  /** Phoenix's own mark price (what orders fill near). */
  markUsd: number;
}

export interface PhoenixPositionView {
  key: string;
  name: string;
  assetId: number;
  isLong: boolean;
  baseLots: bigint;
  sizeTokens: number;
  sizeUsd: number;
  entryPrice: number;
  indexPrice: number;
  markPrice: number;
  pnlUsd: number;
  fundingUsd: number;
  closeFeeUsd: number;
  equityUsd: number;
}

/** Everything about the venue a health scan, a Phoenix call or the Perps page needs. */
export interface PhoenixVenueContext {
  book: MarketBookState;
  exchange: PhoenixExchangeState;
  markets: PhoenixListedMarket[];
  trader: PhoenixTrader | null;
  usdc: OraclePrice | null;
  /** Asset ids of positions with exposure (their markets join the oracle segment). */
  openAssetIds: number[];
  positions: PhoenixPositionView[];
  /** phUSD collateral sitting in the trader account, USD. */
  collateralUsd: number;
  /** The venue as the oracle values it (≥ 0). */
  valueNano: bigint;
  /** Venue still holds something (collateral or a position): it stays on the collateral list. */
  open: boolean;
  /** phUSD Phoenix would pay out now without queueing (6 decimals). */
  withdrawableNow: bigint;
}

/** Oracle segment accounts for this margin's venue, plus `extraAssetIds` (a call's target market). */
export function venueOracleAccounts(margin: PublicKey, venue: PhoenixVenueContext, extraAssetIds: number[] = []): PublicKey[] {
  return phoenixOracleAccounts(margin, venue.exchange, venue.book, [...venue.openAssetIds, ...extraAssetIds]);
}

/**
 * Reads the market book, the exchange, the perp asset map, the margin's trader, the listed
 * orderbooks and every price account involved, and values the venue. Null when Vanna has no
 * Phoenix market book on this network.
 */
/** How long the rarely-changing Phoenix setup (market book, exchange, asset count) is reused. */
const STATIC_TTL_MS = 5 * 60_000;
let statics: { at: number; book: MarketBookState; exchange: PhoenixExchangeState; assetCount: number } | null = null;

/**
 * The market book (changes only when an admin lists a market), the exchange's accounts and the
 * perp asset map's asset count, cached for {@link STATIC_TTL_MS} so a refresh doesn't re-walk them.
 */
async function phoenixStatics(connection: Connection) {
  if (statics && Date.now() - statics.at < STATIC_TTL_MS) return statics;
  const bookInfo = await connection.getAccountInfo(phoenixMarketBook());
  if (!bookInfo) return null;
  const book = decodeMarketBook(Buffer.from(bookInfo.data));
  const exchange = await readPhoenixExchange(connection);
  const head = await connection.getAccountInfo(exchange.perpAssetMap, { dataSlice: { offset: 0, length: 48 } });
  const assetCount = head ? Buffer.from(head.data).readUInt32LE(32) : 0;
  statics = { at: Date.now(), book, exchange, assetCount };
  return statics;
}

export async function loadPhoenixVenue(connection: Connection, margin: PublicKey, now: bigint): Promise<PhoenixVenueContext | null> {
  const fixed = await phoenixStatics(connection);
  if (!fixed) return null;
  const { book, exchange } = fixed;

  const priceKeys = new Map<string, PublicKey>();
  for (const k of [...oracleAccounts(book.collateralPrice), ...book.markets.flatMap((m) => oracleAccounts(m.indexPrice))]) priceKeys.set(k.toBase58(), k);
  // The big Phoenix accounts are read in slices: the used part of the perp asset map and only the
  // orderbook headers (1.2 MB each in full) — reading them whole made every refresh take ~20 s.
  const small = [phoenixTraderPda(margin), exchange.withdrawQueue, ...priceKeys.values()];
  const [infos, headers, phoenixMarkets, currentSlot] = await Promise.all([
    getMultipleAccountsChunked(connection, small),
    connection.getMultipleAccountsInfo(book.markets.map((m) => m.market), { dataSlice: { offset: 0, length: ORDERBOOK_HEADER_LEN } }),
    fetchPerpAssetMap(connection, exchange.perpAssetMap, fixed.assetCount),
    connection.getSlot("confirmed"),
  ]);
  const accounts = new Map<string, AccountInfo<Buffer> | null>();
  small.forEach((k, i) => accounts.set(k.toBase58(), (infos[i] as AccountInfo<Buffer> | null) ?? null));
  book.markets.forEach((m, i) => accounts.set(m.market.toBase58(), (headers[i] as AccountInfo<Buffer> | null) ?? null));
  const traderInfo = accounts.get(phoenixTraderPda(margin).toBase58());
  const trader = traderInfo && traderInfo.data.length > 0 ? decodeTrader(Buffer.from(traderInfo.data)) : null;
  const queueInfo = accounts.get(exchange.withdrawQueue.toBase58());
  const slot = BigInt(currentSlot);
  const withdrawableNow = queueInfo
    ? (() => {
        const b = decodeWithdrawBudget(Buffer.from(queueInfo.data));
        return b.totalQueued > 0n ? 0n : withdrawAvailable(b, slot);
      })()
    : 0n;

  const usdc = priceFromAccounts(book.collateralPrice, accounts, now);
  const usdcUsd = usdc?.usd ?? 1;
  const markets: PhoenixListedMarket[] = [];
  for (const entry of book.markets) {
    const market = phoenixMarkets.find((m) => m.assetId === entry.assetId);
    const meta = PERP_MARKETS.find((m) => m.key === market?.symbol);
    if (!market || !meta) continue;
    const ob = accounts.get(entry.market.toBase58());
    markets.push({
      meta,
      entry,
      market,
      orderbook: ob ? decodeOrderbook(Buffer.from(ob.data)) : null,
      index: priceFromAccounts(entry.indexPrice, accounts, now),
      markUsd: ticksToUsd(market, market.markTicks),
    });
  }
  markets.sort((a, b) => PERP_MARKETS.findIndex((m) => m.key === a.meta.key) - PERP_MARKETS.findIndex((m) => m.key === b.meta.key));

  const collateralUsd = trader ? (Number(trader.collateral) / 1e6) * usdcUsd : 0;
  let equity = collateralUsd;
  const positions: PhoenixPositionView[] = [];
  const openAssetIds: number[] = [];
  for (const p of trader?.positions ?? []) {
    if (p.baseLots === 0n && p.virtualQuoteLots === 0n) continue;
    const listed = markets.find((m) => m.entry.assetId === p.assetId);
    if (!listed) continue;
    openAssetIds.push(p.assetId);
    const indexUsd = listed.index?.usd ?? listed.markUsd;
    const e = positionEquityUsd(p, listed.market.cumulativeFunding, indexUsd, listed.market.lotDecimals, listed.orderbook?.takerFeeMicro ?? 0, usdcUsd);
    equity += e.equityUsd;
    if (p.baseLots === 0n) continue;
    const sizeTokens = Math.abs(lotsToTokens(p.baseLots, listed.market.lotDecimals));
    positions.push({
      key: listed.meta.key,
      name: listed.meta.name,
      assetId: p.assetId,
      isLong: p.baseLots > 0n,
      baseLots: p.baseLots,
      sizeTokens,
      sizeUsd: sizeTokens * indexUsd,
      // virtual quote = −(entry notional) for a long, +(entry notional) for a short.
      entryPrice: sizeTokens > 0 ? Math.abs(Number(p.virtualQuoteLots) / 1e6) / sizeTokens : 0,
      indexPrice: indexUsd,
      markPrice: listed.markUsd,
      pnlUsd: e.pnlUsd,
      fundingUsd: e.fundingUsd,
      closeFeeUsd: e.feeUsd,
      equityUsd: e.equityUsd,
    });
  }
  const valueUsd = Math.max(0, equity);
  return {
    book,
    exchange,
    markets,
    trader,
    usdc,
    openAssetIds,
    positions,
    collateralUsd,
    valueNano: BigInt(Math.floor(valueUsd * NANO)),
    open: Boolean(trader && (trader.collateral !== 0n || positions.length > 0)),
    withdrawableNow,
  };
}
