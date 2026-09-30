// Server-side only: the fork price keeper. Ported from vanna-credit-layer/scripts/src/oracle.ts
// (refreshOraclesOnFork: Scope copied from mainnet, restamped) and devnet-pyth.ts
// (buildForkPriceAccountData), driven by each asset's on-chain OracleConfig.
import { Connection, PublicKey } from "@solana/web3.js";
import { PYTH_RECEIVER_PROGRAM_ID, SOLANA_RPC_URL } from "../config";
import { forkUnixTimestamp } from "../connection";
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
import { fetchAllAssetConfigs } from "../protocol-state";
import { SCOPE_CHAIN_UNUSED, scopeEntryOffset, type OracleConfigState } from "../oracle";
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
  /** Pyth account refreshed for this asset (its fallback feed), when it has one. */
  account: string;
  usd: number;
  source: "jupiter" | "previous" | "reference";
  publishTime: number;
}

/** Scope's `OraclePrices` program; the mainnet account is copied onto the fork. */
const SCOPE_PROGRAM_ID = new PublicKey("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ");
/** Where live Scope prices are read from (the fork's copy freezes at clone time). */
const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";

/**
 * Copies Kamino's live Scope `OraclePrices` account from mainnet onto the fork and restamps every
 * entry the given oracles read (price + TWAP chains) with the fork clock — the program measures
 * age against the fork's clock, which need not match mainnet's. Same as
 * `vanna-credit-layer/scripts/src/oracle.ts::refreshOraclesOnFork`. If mainnet is unreachable the
 * fork's existing copy is restamped instead (its values then lag; reported as "restamped").
 */
async function refreshScopeOnFork(connection: Connection, oracles: OracleConfigState[], now: bigint): Promise<"mainnet" | "restamped" | "none"> {
  const byAccount = new Map<string, Set<number>>();
  for (const o of oracles) {
    if (o.scopePrices.equals(PublicKey.default)) continue;
    const set = byAccount.get(o.scopePrices.toBase58()) ?? new Set<number>();
    for (const e of [...o.scopeChain, ...o.scopeTwapChain]) if (e !== SCOPE_CHAIN_UNUSED) set.add(e);
    byAccount.set(o.scopePrices.toBase58(), set);
  }
  let result: "mainnet" | "restamped" | "none" = "none";
  for (const [address, entries] of byAccount) {
    const key = new PublicKey(address);
    let source = await new Connection(MAINNET_RPC_URL, "confirmed").getAccountInfo(key).catch(() => null);
    result = "mainnet";
    if (!source?.owner.equals(SCOPE_PROGRAM_ID)) {
      source = await connection.getAccountInfo(key);
      result = "restamped";
    }
    if (!source?.owner.equals(SCOPE_PROGRAM_ID)) throw new Error(`Scope prices account ${address} unavailable on mainnet and the fork`);
    const data = Buffer.from(source.data);
    for (const entry of entries) data.writeBigUInt64LE(now, scopeEntryOffset(entry) + 24);
    await callCheatcode("surfnet_setAccount", [
      address,
      { lamports: source.lamports, data: data.toString("hex"), owner: SCOPE_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 },
    ]);
  }
  return result;
}

/**
 * The fork price keeper, driven by each registry token's ON-CHAIN OracleConfig:
 *   1. Scope (primary): copy the live mainnet account, restamped to the fork clock.
 *   2. Pyth (fallback): rewrite every configured `pyth_price` account via `surfnet_setAccount` from
 *      a live Jupiter USD price, stamped with the fork clock, keeping each account's own feed id.
 *      A feed paired with a `pyth_factor` publishes a RATE, not USD (JupSOL = JUPSOL/SOL rate ×
 *      SOL/USD), so it gets usd(asset) / usd(factor's asset).
 * Price per asset: live Jupiter USD → the account's current on-chain value (re-stamped) → the
 * reference table (flagged `source: "reference"`).
 */
export async function refreshForkPrices(rpcUrl: string = SOLANA_RPC_URL): Promise<RefreshedPrice[]> {
  const connection = new Connection(rpcUrl, "confirmed");
  const [assetMap, now, live] = await Promise.all([fetchAllAssetConfigs(connection), forkUnixTimestamp(connection), fetchJupiterUsdPrices()]);
  const configs = TOKENS.map((token) => ({ token, asset: [...assetMap.values()].find((a) => a.mint.equals(token.mint)) ?? null }));
  await refreshScopeOnFork(connection, configs.flatMap((c) => (c.asset ? [c.asset.oracle] : [])), now);

  // USD per token for the fallback feeds (live → reference), and which token each Pyth account prices.
  const usdOf = (symbol: string) => live[symbol] ?? REFERENCE_PRICE_USD[symbol];
  const tokenByPyth = new Map<string, string>();
  for (const { token, asset } of configs) if (asset && !asset.oracle.pythPrice.equals(PublicKey.default)) tokenByPyth.set(asset.oracle.pythPrice.toBase58(), token.symbol);

  const pythKeys = configs.flatMap((c) => (c.asset && !c.asset.oracle.pythPrice.equals(PublicKey.default) ? [c.asset.oracle.pythPrice] : []));
  const infos = await connection.getMultipleAccountsInfo(pythKeys, "confirmed");
  const infoByKey = new Map(pythKeys.map((k, i) => [k.toBase58(), infos[i]]));

  const results: RefreshedPrice[] = [];
  for (const { token, asset } of configs) {
    if (!asset || asset.oracle.pythPrice.equals(PublicKey.default)) continue;
    const address = asset.oracle.pythPrice;
    const current = infoByKey.get(address.toBase58());
    if (!current?.owner.equals(PYTH_RECEIVER_PROGRAM_ID) || current.data.length < MIN_PRICE_ACCOUNT_SIZE) {
      // The bootstrap creates every configured feed account; without one there's no feed id to keep.
      continue;
    }
    let usd = live[token.symbol];
    let source: RefreshedPrice["source"] = usd ? "jupiter" : "reference";
    if (!usd) usd = REFERENCE_PRICE_USD[token.symbol];
    let value = usd;
    if (!asset.oracle.pythFactor.equals(PublicKey.default)) {
      const factorSymbol = tokenByPyth.get(asset.oracle.pythFactor.toBase58());
      const factorUsd = factorSymbol ? usdOf(factorSymbol) : undefined;
      if (!factorUsd) continue; // can't express the rate without the factor's USD price
      value = usd / factorUsd;
    }
    if (!(value > 0)) {
      const previous = decodePriceUpdate(current as never);
      if (!previous) continue;
      value = previous.usd;
      source = "previous";
    }
    const feedIdHex = Buffer.from(current.data.subarray(PRICE_FEED_ID_OFFSET, PRICE_FEED_ID_OFFSET + 32)).toString("hex");
    const data = buildForkPriceAccountData(current.data, feedIdHex, value, now);
    await callCheatcode("surfnet_setAccount", [
      address.toBase58(),
      { lamports: current.lamports, data: data.toString("hex"), owner: PYTH_RECEIVER_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 },
    ]);
    results.push({ symbol: token.symbol, account: address.toBase58(), usd, source, publishTime: Number(now) });
  }
  return results;
}

export type { PublicKey };
