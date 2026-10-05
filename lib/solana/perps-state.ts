/**
 * Reading a margin's GMTrade venue account and valuing it exactly like the oracle agent does on
 * each health check (`vanna_oracle::gmtrade::venue_account_price`): idle USDC + USDC escrowed in
 * pending orders + every position's equity, over the legs the margin tracks.
 */
import { Buffer } from "buffer";
import { AccountLayout } from "@solana/spl-token";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { getMultipleAccountsChunked } from "./connection";
import { oracleAccounts, priceFromAccounts, type OraclePrice } from "./oracle";
import {
  decodeGmMarket,
  decodeGmOrder,
  decodeGmPosition,
  decodeMarketBook,
  gmEscrow,
  gmOrderPda,
  gmPositionPda,
  gmUserPda,
  isEmptyPosition,
  isGmAccount,
  legBit,
  marketBook,
  MARKET_INCREASE,
  positionEquityNano,
  USD_UNIT,
  valueNano,
  venueAccountOf,
  venueIdleAccount,
  type GmMarketState,
  type GmOrder,
  type GmPosition,
  type MarketBookEntry,
  type MarketBookState,
} from "./perps-accounts";

export async function fetchMarketBook(connection: Connection): Promise<MarketBookState | null> {
  const info = await connection.getAccountInfo(marketBook());
  return info ? decodeMarketBook(Buffer.from(info.data)) : null;
}

export interface VenueOrderView {
  isLong: boolean;
  increase: boolean;
  sizeUsd: number;
  collateralUsdc: number;
  escrowedRaw: bigint;
  address: PublicKey;
  raw: GmOrder;
}

export interface VenuePositionView {
  isLong: boolean;
  sizeUsd: number;
  sizeTokens: number;
  entryPrice: number;
  collateralUsdc: number;
  leverage: number;
  pnlUsd: number;
  equityUsd: number;
  equityNano: bigint;
  address: PublicKey;
  raw: GmPosition;
}

export interface VenueMarketView {
  entry: MarketBookEntry;
  market: GmMarketState | null;
  indexPrice: OraclePrice | null;
  tracked: boolean;
  /** [long, short]. */
  orders: (VenueOrderView | null)[];
  /** [long, short]. */
  positions: (VenuePositionView | null)[];
  /** A pending order or a non-empty position (the oracle's open leg). */
  open: boolean;
}

export interface VenueState {
  book: MarketBookState;
  venueAccount: PublicKey;
  lamports: number;
  userExists: boolean;
  idleRaw: bigint;
  markets: VenueMarketView[];
  /** The venue account's value as the oracle reports it over the tracked legs (nano-USD). */
  valueNano: bigint;
  /** Legs holding an order or a position. */
  openLegs: bigint;
}

const tokenAmount = (info: AccountInfo<Buffer> | null | undefined) =>
  info && info.data.length >= AccountLayout.span ? AccountLayout.decode(info.data.subarray(0, AccountLayout.span)).amount : 0n;

/** Reads every listed market of the margin's venue account; only `trackedLegs` count toward its value. */
export async function readVenueState(
  connection: Connection,
  margin: PublicKey,
  book: MarketBookState,
  trackedLegs: bigint,
  now: bigint,
): Promise<VenueState> {
  const venueAccount = venueAccountOf(margin);
  const collateral = book.collateralMint;
  const head = [venueAccount, venueIdleAccount(venueAccount, collateral), gmUserPda(venueAccount)];
  const priceKeys = [...oracleAccounts(book.collateralPrice), ...book.markets.flatMap((e) => oracleAccounts(e.indexPrice))];
  const perLeg = book.markets.flatMap((e) => {
    const orders = [true, false].map((long) => gmOrderPda(venueAccount, e.leg, long));
    return [e.market, ...orders, ...orders.map((o) => gmEscrow(o, collateral)), ...[true, false].map((long) => gmPositionPda(venueAccount, e.marketToken, collateral, long))];
  });
  const keys = [...head, ...priceKeys, ...perLeg];
  const infos = await getMultipleAccountsChunked(connection, keys);
  const byKey = new Map(keys.map((k, i) => [k.toBase58(), infos[i] as AccountInfo<Buffer> | null]));
  const get = (k: PublicKey) => byKey.get(k.toBase58()) ?? null;

  const collateralPrice = priceFromAccounts(book.collateralPrice, byKey, now);
  const usdc = collateralPrice ? { value: collateralPrice.price, exponent: collateralPrice.exponent } : null;
  const idleRaw = tokenAmount(get(head[1]));
  let value = usdc ? valueNano(idleRaw, usdc.value, usdc.exponent, book.collateralDecimals, false) : 0n;
  let openLegs = 0n;

  const markets: VenueMarketView[] = book.markets.map((entry) => {
    const marketInfo = get(entry.market);
    const market = isGmAccount(marketInfo) ? decodeGmMarket(Buffer.from(marketInfo.data)) : null;
    const indexPrice = priceFromAccounts(entry.indexPrice, byKey, now);
    const tracked = (trackedLegs & legBit(entry.leg)) !== 0n;
    const index = indexPrice ? { value: indexPrice.price, exponent: indexPrice.exponent } : null;
    const collateralSideIsLong = market ? market.longToken.equals(collateral) : true;
    let open = false;

    const orders = [true, false].map((isLong) => {
      const address = gmOrderPda(venueAccount, entry.leg, isLong);
      const info = get(address);
      if (!isGmAccount(info)) return null;
      open = true;
      const raw = decodeGmOrder(Buffer.from(info.data));
      const escrowedRaw = tokenAmount(get(gmEscrow(address, collateral)));
      if (tracked && usdc) value += valueNano(escrowedRaw, usdc.value, usdc.exponent, book.collateralDecimals, false);
      return {
        isLong,
        increase: raw.kind === MARKET_INCREASE,
        sizeUsd: Number(raw.sizeDeltaValue) / Number(USD_UNIT),
        collateralUsdc: Number(raw.initialCollateralDeltaAmount) / 10 ** book.collateralDecimals,
        escrowedRaw,
        address,
        raw,
      } satisfies VenueOrderView;
    });

    const positions = [true, false].map((isLong) => {
      const address = gmPositionPda(venueAccount, entry.marketToken, collateral, isLong);
      const info = get(address);
      if (!isGmAccount(info)) return null;
      const raw = decodeGmPosition(Buffer.from(info.data));
      if (isEmptyPosition(raw)) return null;
      open = true;
      const equityNano = market && index && usdc ? positionEquityNano(raw, isLong, collateralSideIsLong, market, index, entry.indexDecimals, usdc, book.collateralDecimals) : 0n;
      if (tracked) value += equityNano;
      const sizeUsd = Number(raw.sizeInUsd) / Number(USD_UNIT);
      const sizeTokens = Number(raw.sizeInTokens) / 10 ** entry.indexDecimals;
      const collateralUsdc = Number(raw.collateralAmount) / 10 ** book.collateralDecimals;
      const mark = indexPrice?.usd ?? 0;
      return {
        isLong,
        sizeUsd,
        sizeTokens,
        entryPrice: sizeTokens > 0 ? sizeUsd / sizeTokens : 0,
        collateralUsdc,
        leverage: collateralUsdc > 0 ? sizeUsd / collateralUsdc : 0,
        pnlUsd: isLong ? sizeTokens * mark - sizeUsd : sizeUsd - sizeTokens * mark,
        equityUsd: Number(equityNano) / 1e9,
        equityNano,
        address,
        raw,
      } satisfies VenuePositionView;
    });
    if (open) openLegs |= legBit(entry.leg);
    return { entry, market, indexPrice, tracked, orders, positions, open };
  });

  return {
    book,
    venueAccount,
    lamports: get(venueAccount)?.lamports ?? 0,
    userExists: isGmAccount(get(head[2])),
    idleRaw,
    markets,
    valueNano: value,
    openLegs,
  };
}
