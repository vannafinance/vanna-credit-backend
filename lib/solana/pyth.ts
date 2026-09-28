import { Buffer } from "buffer";
import type { AccountInfo, Connection } from "@solana/web3.js";
import { PYTH_RECEIVER_PROGRAM_ID } from "./config";
import { priceFeedAccount } from "./pdas";
import { TOKENS, type TokenInfo } from "./tokens";
import { getMultipleAccountsChunked } from "./connection";

/**
 * PriceUpdateV2 byte layout (Anchor account, owned by the Pyth receiver):
 *   8 discriminator | 32 write_authority | 1 verification_level (Full = 1 byte variant) |
 *   32 feed_id | i64 price | u64 conf | i32 exponent | i64 publish_time | i64 prev_publish_time |
 *   i64 ema_price | u64 ema_conf | u64 posted_slot
 * Offsets match vanna-credit-layer/scripts/src/devnet-pyth.ts.
 */
export const PRICE_UPDATE_V2_DISCRIMINATOR = Buffer.from([0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]);
export const PRICE_FEED_ID_OFFSET = 41;
export const PRICE_OFFSET = 73;
export const CONF_OFFSET = 81;
export const EXPONENT_OFFSET = 89;
export const PUBLISH_TIME_OFFSET = 93;
export const PREV_PUBLISH_TIME_OFFSET = 101;
export const EMA_PRICE_OFFSET = 109;
export const EMA_CONF_OFFSET = 117;
export const MIN_PRICE_ACCOUNT_SIZE = 134;

export interface OnchainPrice {
  /** Raw Pyth price (scaled by 10^exponent). */
  price: bigint;
  conf: bigint;
  exponent: number;
  /** Unix seconds (fork clock domain). */
  publishTime: bigint;
  /** Price as a JS float, USD. */
  usd: number;
}

/** Decodes a PriceUpdateV2 account; null when missing / not owned by the receiver / too small. */
export function decodePriceUpdate(info: AccountInfo<Buffer> | null): OnchainPrice | null {
  if (!info || !info.owner.equals(PYTH_RECEIVER_PROGRAM_ID) || info.data.length < MIN_PRICE_ACCOUNT_SIZE) return null;
  const data = info.data;
  if (!data.subarray(0, 8).equals(PRICE_UPDATE_V2_DISCRIMINATOR)) return null;
  const price = data.readBigInt64LE(PRICE_OFFSET);
  const conf = data.readBigUInt64LE(CONF_OFFSET);
  const exponent = data.readInt32LE(EXPONENT_OFFSET);
  const publishTime = data.readBigInt64LE(PUBLISH_TIME_OFFSET);
  return { price, conf, exponent, publishTime, usd: Number(price) * 10 ** exponent };
}

/** The price-update account the program reads for a token (derived from its feed id). */
export function priceAccountFor(token: TokenInfo) {
  return priceFeedAccount(token.pythFeedId);
}

/** Reads every registry token's on-chain price in one getMultipleAccounts call. */
export async function readOnchainPrices(connection: Connection): Promise<Record<string, OnchainPrice | null>> {
  const infos = await getMultipleAccountsChunked(connection, TOKENS.map(priceAccountFor));
  return Object.fromEntries(TOKENS.map((t, i) => [t.symbol, decodePriceUpdate(infos[i] as AccountInfo<Buffer> | null)]));
}
