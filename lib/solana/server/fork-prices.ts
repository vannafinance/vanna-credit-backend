import { alignPerenaNavClock } from "./perena-fork";
// Server-side only, FORK ONLY (the guide's "fork-only helpers" — never port to production): the
// fork price keeper. Ported from vanna-credit-layer/scripts/src/oracle.ts
// (refreshOraclesOnFork: Scope copied from mainnet, restamped) and devnet-pyth.ts
// (buildForkPriceAccountData), driven by each asset's on-chain OracleConfig.
import { Connection, PublicKey } from "@solana/web3.js";
import { PYTH_RECEIVER_PROGRAM_ID, SOLANA_RPC_URL } from "../config";
import { forkUnixTimestamp, forkFetch } from "../connection";
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
import { decodeMarketBook, fetchPerpAssetMap, PHOENIX_EXCHANGE, PHOENIX_PROGRAM_ID, phoenixMarketBook, readPhoenixExchange } from "../phoenix";
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
  JupUSD: 1,
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

/**
 * Spot tokens Jupiter prices for each Phoenix market's index (Phoenix markets have no mint): ETH =
 * Wormhole WETH, BTC = cbBTC, SOL = wSOL, TSLA / META = the xStocks. Only used to refresh a market's
 * Pyth index feed on the fork (Scope-priced markets are refreshed with the Scope copy).
 */
const PERP_INDEX_PROXY: Record<string, PublicKey> = {
  ETH: new PublicKey("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"),
  BTC: new PublicKey("cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij"),
  SOL: new PublicKey("So11111111111111111111111111111111111111112"),
  TSLA: new PublicKey("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"),
  META: new PublicKey("Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu"),
};

/** The Phoenix markets Vanna lists, with each one's index price config (from the market book). */
async function listedPerpIndexes(connection: Connection): Promise<{ symbol: string; mint: PublicKey; oracle: OracleConfigState }[]> {
  const info = await connection.getAccountInfo(phoenixMarketBook());
  if (!info) return [];
  const book = decodeMarketBook(Buffer.from(info.data));
  const ex = await readPhoenixExchange(connection);
  const markets = await fetchPerpAssetMap(connection, ex.perpAssetMap);
  return book.markets.flatMap((e) => {
    const symbol = markets.find((m) => m.assetId === e.assetId)?.symbol;
    return symbol && PERP_INDEX_PROXY[symbol] ? [{ symbol, mint: PERP_INDEX_PROXY[symbol], oracle: e.indexPrice }] : [];
  });
}

type Priced = Pick<TokenInfo, "symbol" | "mint">;

/** Live USD prices for every registry mint from Jupiter's price API (one request). */
export async function fetchJupiterUsdPrices(tokens: readonly Priced[] = TOKENS): Promise<Record<string, number>> {
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
    let source = await new Connection(MAINNET_RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: forkFetch }).getAccountInfo(key).catch(() => null);
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
  const connection = new Connection(rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: forkFetch });
  // Independent reads run together (each is a round trip to the hosted fork or an API).
  const [perps, assetMap, now, tokenPrices] = await Promise.all([
    listedPerpIndexes(connection).catch(() => []),
    fetchAllAssetConfigs(connection),
    forkUnixTimestamp(connection),
    // Registry tokens + every Phoenix index proxy, one Jupiter call (the listed set is a subset).
    fetchJupiterUsdPrices([
      ...TOKENS,
      // SOL's proxy is the SOL token itself: skip duplicates so the fetch can tell it got everything.
      ...Object.entries(PERP_INDEX_PROXY)
        .filter(([, mint]) => !TOKENS.some((t) => t.mint.equals(mint)))
        .map(([symbol, mint]) => ({ symbol, mint })),
    ]),
  ]);
  // A perp market is priced like the token that proxies it (SOL-PERP = SOL).
  const live: Record<string, number> = { ...tokenPrices };
  for (const [symbol, mint] of Object.entries(PERP_INDEX_PROXY)) {
    const token = TOKENS.find((t) => t.mint.equals(mint));
    if (token && live[token.symbol] && !live[symbol]) live[symbol] = live[token.symbol];
  }
  // Every price the program reads: the registry tokens' price-book entries, then each listed Phoenix
  // market's index price (from the oracle's market book).
  const configs: { token: Priced; oracle: OracleConfigState | null }[] = [
    ...TOKENS.map((token) => ({ token: token as Priced, oracle: [...assetMap.values()].find((a) => a.mint.equals(token.mint))?.oracle ?? null })),
    ...perps.map((p) => ({ token: { symbol: p.symbol, mint: p.mint }, oracle: p.oracle })),
  ];
  // The Scope copy, the Phoenix exchange alignment and the Pyth writes below all go out together.
  const background: (() => Promise<unknown>)[] = [() => refreshScopeOnFork(connection, configs.flatMap((c) => (c.oracle ? [c.oracle] : [])), now)];
  if (perps.length) background.push(() => alignPhoenixExchangeOnFork(connection));

  // USD per token for the fallback feeds (live → reference), and which token each Pyth account prices.
  const usdOf = (symbol: string) => live[symbol] ?? REFERENCE_PRICE_USD[symbol];
  const tokenByPyth = new Map<string, string>();
  for (const { token, oracle } of configs) if (oracle && !oracle.pythPrice.equals(PublicKey.default)) tokenByPyth.set(oracle.pythPrice.toBase58(), token.symbol);

  const pythKeys = [
    ...new Map(configs.flatMap((c) => (c.oracle && !c.oracle.pythPrice.equals(PublicKey.default) ? [c.oracle.pythPrice] : [])).map((k) => [k.toBase58(), k])).values(),
  ];
  const infos = await connection.getMultipleAccountsInfo(pythKeys, "confirmed");
  const infoByKey = new Map(pythKeys.map((k, i) => [k.toBase58(), infos[i]]));

  const results: RefreshedPrice[] = [];
  const written = new Set<string>();
  for (const { token, oracle } of configs) {
    if (!oracle || oracle.pythPrice.equals(PublicKey.default)) continue;
    const address = oracle.pythPrice;
    if (written.has(address.toBase58())) continue;
    written.add(address.toBase58());
    const current = infoByKey.get(address.toBase58());
    if (!current?.owner.equals(PYTH_RECEIVER_PROGRAM_ID) || current.data.length < MIN_PRICE_ACCOUNT_SIZE) {
      // The bootstrap creates every configured feed account; without one there's no feed id to keep.
      continue;
    }
    let usd = live[token.symbol];
    let source: RefreshedPrice["source"] = usd ? "jupiter" : "reference";
    if (!usd) usd = REFERENCE_PRICE_USD[token.symbol];
    let value = usd;
    if (!oracle.pythFactor.equals(PublicKey.default)) {
      const factorSymbol = tokenByPyth.get(oracle.pythFactor.toBase58());
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
    background.push(
      () => callCheatcode("surfnet_setAccount", [
        address.toBase58(),
        { lamports: current.lamports, data: data.toString("hex"), owner: PYTH_RECEIVER_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 },
      ]),
    );
    results.push({ symbol: token.symbol, account: address.toBase58(), usd, source, publishTime: Number(now) });
  }
  // Four writes at a time; wait for all started work even when one write fails.
  let failure: PromiseRejectedResult | undefined;
  for (let i = 0; i < background.length; i += 4) {
    const batch = await Promise.allSettled(background.slice(i, i + 4).map((run) => run()));
    failure ??= batch.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failure) throw failure.reason;
  }
  await alignPerenaNavClock(connection);
  return results;
}

const LAST_RESTART_SLOT_SYSVAR = new PublicKey("SysvarLastRestartS1ot1111111111111111111111");
/** Phoenix's global config records the cluster's last restart slot here and refuses every call
 * ("Global configuration must be active") while it differs from the LastRestartSlot sysvar. */
const PHOENIX_LAST_RESTART_SLOT_OFFSET = 1096;

/**
 * Fork only: a fork's LastRestartSlot sysvar differs from mainnet's (0 vs mainnet's last restart),
 * so Phoenix treats its cloned global config as inactive. Align the recorded slot with the fork's
 * sysvar (same idea as GMTrade's store alignment before it).
 */
export async function alignPhoenixExchangeOnFork(connection: Connection): Promise<void> {
  const [exchange, sysvar] = await connection.getMultipleAccountsInfo([PHOENIX_EXCHANGE, LAST_RESTART_SLOT_SYSVAR]);
  if (!exchange || exchange.data.length < PHOENIX_LAST_RESTART_SLOT_OFFSET + 8) return;
  const forkRestart = sysvar && sysvar.data.length >= 8 ? Buffer.from(sysvar.data).readBigUInt64LE(0) : 0n;
  const data = Buffer.from(exchange.data);
  if (data.readBigUInt64LE(PHOENIX_LAST_RESTART_SLOT_OFFSET) === forkRestart) return;
  data.writeBigUInt64LE(forkRestart, PHOENIX_LAST_RESTART_SLOT_OFFSET);
  await callCheatcode("surfnet_setAccount", [
    PHOENIX_EXCHANGE.toBase58(),
    { lamports: exchange.lamports, data: data.toString("hex"), owner: PHOENIX_PROGRAM_ID.toBase58(), executable: false, rentEpoch: 0 },
  ]);
}

export type { PublicKey };
