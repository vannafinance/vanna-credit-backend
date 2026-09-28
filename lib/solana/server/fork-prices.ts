// Server-side only: the fork price keeper. Ported from
// vanna-credit-layer/scripts/src/devnet-pyth.ts (buildForkPriceAccountData / forkUnixTimestamp /
// fabricatePrice), batched over the whole token registry.
import { Connection, PublicKey } from "@solana/web3.js";
import { PYTH_RECEIVER_PROGRAM_ID, SOLANA_RPC_URL } from "../config";
import { forkUnixTimestamp } from "../connection";
import { priceFeedAccount } from "../pdas";
import {
  CONF_OFFSET,
  EMA_CONF_OFFSET,
  EMA_PRICE_OFFSET,
  EXPONENT_OFFSET,
  MIN_PRICE_ACCOUNT_SIZE,
  PREV_PUBLISH_TIME_OFFSET,
  PRICE_FEED_ID_OFFSET,
  PRICE_OFFSET,
  PRICE_UPDATE_V2_DISCRIMINATOR,
  PUBLISH_TIME_OFFSET,
  decodePriceUpdate,
} from "../pyth";
import { TOKENS, type TokenInfo } from "../tokens";
import { callCheatcode } from "./cheatcodes";
import { jupiterBaseUrl, jupiterHeaders } from "./jupiter-api";

/**
 * Sentinel USD prices, used ONLY when neither Jupiter nor an existing on-chain price is available
 * (same table as devnet-pyth.ts's REFERENCE_PRICE_USD). Every use is reported as
 * `source: "reference"` in the keeper's response so it is never mistaken for a live price.
 */
const REFERENCE_PRICE_USD: Record<string, number> = {
  SOL: 190,
  USDC: 1,
  USDT: 1,
  JitoSOL: 240,
  JupSOL: 215,
};

function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex");
}

/** Builds a fresh PriceUpdateV2 account buffer from a template (any existing PriceUpdateV2 —
 * layout is identical across feeds), rewriting the feed ID/price/timestamps. */
export function buildForkPriceAccountData(template: Buffer, feedId: string, usdPrice: number, now: bigint): Buffer {
  const data = Buffer.from(template);
  if (data.length < MIN_PRICE_ACCOUNT_SIZE) {
    throw new Error(`template PriceUpdateV2 account too small (${data.length} bytes)`);
  }
  PRICE_UPDATE_V2_DISCRIMINATOR.copy(data, 0);
  hexToBytes(feedId).copy(data, PRICE_FEED_ID_OFFSET);
  const exponent = -8;
  const scale = 10 ** -exponent;
  const rawPrice = BigInt(Math.round(usdPrice * scale));
  const conf = BigInt(Math.max(1, Math.round(usdPrice * 0.002 * scale)));
  data.writeBigInt64LE(rawPrice, PRICE_OFFSET);
  data.writeBigUInt64LE(conf, CONF_OFFSET);
  data.writeInt32LE(exponent, EXPONENT_OFFSET);
  data.writeBigInt64LE(now, PUBLISH_TIME_OFFSET);
  data.writeBigInt64LE(now - 1n, PREV_PUBLISH_TIME_OFFSET);
  data.writeBigInt64LE(rawPrice, EMA_PRICE_OFFSET);
  data.writeBigUInt64LE(conf, EMA_CONF_OFFSET);
  return data;
}

/** Live USD prices for every registry mint from Jupiter's price API (one request). */
export async function fetchJupiterUsdPrices(tokens: readonly TokenInfo[] = TOKENS): Promise<Record<string, number>> {
  const ids = tokens.map((t) => t.mint.toBase58()).join(",");
  const out: Record<string, number> = {};
  const urls = [`${jupiterBaseUrl()}/price/v3?ids=${ids}`];
  if (process.env.JUPITER_API_KEY) urls.push(`https://lite-api.jup.ag/price/v3?ids=${ids}`);
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: url.includes("lite-api") ? {} : jupiterHeaders(),
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      if (!response.ok) continue;
      const body = (await response.json()) as Record<string, { usdPrice?: number }>;
      for (const t of tokens) {
        const price = body[t.mint.toBase58()]?.usdPrice;
        if (typeof price === "number" && price > 0) out[t.symbol] = price;
      }
      if (Object.keys(out).length === tokens.length) break;
    } catch {
      // try the next endpoint
    }
  }
  return out;
}

export interface RefreshedPrice {
  symbol: string;
  account: string;
  usd: number;
  source: "jupiter" | "previous" | "reference";
  publishTime: number;
}

/**
 * Fabricates (or refreshes) every registry asset's PriceUpdateV2 account directly on the Surfpool
 * fork via `surfnet_setAccount` — no Hermes call, no wallet signature. The SOL feed account (a real
 * cloned mainnet PriceUpdateV2) is the byte-layout template; publish time = the fork Clock's
 * unix_timestamp, since the program checks price age against that clock.
 *
 * Price source per asset: live Jupiter USD price → the account's current on-chain price
 * (re-stamped) → the reference table (flagged as such).
 */
export async function refreshForkPrices(rpcUrl: string = SOLANA_RPC_URL): Promise<RefreshedPrice[]> {
  const connection = new Connection(rpcUrl, "confirmed");
  const addresses = TOKENS.map((t) => priceFeedAccount(t.pythFeedId));
  const solAddress = priceFeedAccount(TOKENS.find((t) => t.symbol === "SOL")!.pythFeedId);
  const [infos, solTemplate, now, live] = await Promise.all([
    connection.getMultipleAccountsInfo(addresses, "confirmed"),
    connection.getAccountInfo(solAddress, "confirmed"),
    forkUnixTimestamp(connection),
    fetchJupiterUsdPrices(),
  ]);

  const results: RefreshedPrice[] = [];
  for (let i = 0; i < TOKENS.length; i++) {
    const token = TOKENS[i];
    const address = addresses[i];
    // This asset's own account when it's already a PriceUpdateV2, else the SOL feed's.
    let template = infos[i];
    if (!template?.owner.equals(PYTH_RECEIVER_PROGRAM_ID)) template = solTemplate;
    if (!template?.owner.equals(PYTH_RECEIVER_PROGRAM_ID)) {
      throw new Error(
        "No existing PriceUpdateV2 template found on the fork to clone the byte layout from — " +
          "run against a fork that has cloned mainnet Pyth accounts (the SOL feed).",
      );
    }
    let usd = live[token.symbol];
    let source: RefreshedPrice["source"] = "jupiter";
    if (!usd) {
      const previous = decodePriceUpdate(infos[i] as never);
      if (previous && previous.usd > 0) {
        usd = previous.usd;
        source = "previous";
      } else {
        usd = REFERENCE_PRICE_USD[token.symbol];
        source = "reference";
      }
    }
    const data = buildForkPriceAccountData(template.data, token.pythFeedId, usd, now);
    await callCheatcode("surfnet_setAccount", [
      address.toBase58(),
      {
        lamports: template.lamports,
        data: data.toString("hex"),
        owner: PYTH_RECEIVER_PROGRAM_ID.toBase58(),
        executable: false,
        rentEpoch: 0,
      },
    ]);
    results.push({ symbol: token.symbol, account: address.toBase58(), usd, source, publishTime: Number(now) });
  }
  return results;
}

export type { PublicKey };
