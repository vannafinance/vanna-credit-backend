/**
 * World market catalog (server only). Ported from Backend-Solana-v2 `lib/world/catalog.server.ts`
 * and extended with World's on-chain `Group` accounts for event grouping.
 *
 * Markets are discovered on chain: every World market is a 320-byte account owned by `prediCt`,
 * every Group an account with the `Group` discriminator, both found with getProgramAccounts on
 * MAINNET (the Surfpool fork only has the accounts it already cloned, so it cannot list them).
 * Names come from each YES mint's Token-2022 metadata extension, the category / image / question
 * text from the JSON at the metadata `uri` (World's public token-metadata endpoint, the same file
 * wallets read). World's own catalog API is not used: it sits behind bot protection.
 *
 * Everything is cached in memory (and the static JSON metadata also on disk, `.cache/`), so page
 * loads never wait on the scan after the first one.
 */
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { Buffer } from "buffer";
import { utils } from "@coral-xyz/anchor";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CASH_DECIMALS, GROUP_DISCRIMINATOR_HEX, MARKET_ACCOUNT_SIZE, WORLD_PROGRAM_ID } from "./constants";
import { decodeGroup, decodeMarket, parseTokenMetadata, tokenAmountOf } from "./decode";
import { classify, questionFrom } from "./grouping";
import type { JsonMeta, MarketInfo, MintMeta, RawGroup, RawMarket } from "./types";
import { FEATURED_EVENTS, FEATURED_GROUP_IDS, FEATURED_MARKET_IDS, featuredOnly } from "./featured";
import { sweepUnpricedMarkets } from "./prices.server";
import { scanUrls, withFallback, withMainnet } from "./rpc.server";
import { getConnection } from "@/lib/solana/connection";

const CATALOG_TTL_MS = 5 * 60_000;
/** Crypto windows are pre-created for days ahead; list the live one and the next hour only. */
const UPCOMING_WINDOW_MS = 60 * 60_000;
/** Below this CASH in its vault a market reads as inactive and is hidden (unless its Group is live). */
const MIN_OPEN_INTEREST = 1;
const JSON_FETCH_CONCURRENCY = 6;
/** First load waits this long for missing JSON metadata (questions drive the grouping). */
const FIRST_LOAD_JSON_WAIT_MS = 12_000;
const CACHE_DIR = path.join(process.cwd(), ".cache");
const JSON_CACHE_FILE = path.join(CACHE_DIR, "predict-world-metadata.json");

interface CatalogState {
  /** Every market on chain (decoded), by id. */
  all: Map<string, RawMarket>;
  /** Markets listed now (live windows + markets with open interest + their Group siblings). */
  listed: string[];
  groups: Map<string, RawGroup>;
  groupOf: Map<string, string>;
  /** Every outcome mint of every market on chain → its market id (Portfolio lookups). */
  marketByMint: Map<string, string>;
  mintMeta: Map<string, MintMeta>;
  jsonMeta: Map<string, JsonMeta>;
  openInterest: Map<string, number>;
  loadedAt: number;
  loading: Promise<void> | null;
  jsonQueue: Set<string>;
  jsonWorker: Promise<void> | null;
}

const g = globalThis as unknown as { __predictCatalog?: CatalogState };
const state: CatalogState = (g.__predictCatalog ??= {
  all: new Map(),
  listed: [],
  groups: new Map(),
  groupOf: new Map(),
  marketByMint: new Map(),
  mintMeta: new Map(),
  jsonMeta: loadJsonCache(),
  openInterest: new Map(),
  loadedAt: 0,
  loading: null,
  jsonQueue: new Set(),
  jsonWorker: null,
});

function loadJsonCache(): Map<string, JsonMeta> {
  try {
    if (existsSync(JSON_CACHE_FILE)) return new Map(Object.entries(JSON.parse(readFileSync(JSON_CACHE_FILE, "utf8"))));
  } catch {
    /* a corrupt cache is simply rebuilt */
  }
  return new Map();
}

function saveJsonCache() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(JSON_CACHE_FILE, JSON.stringify(Object.fromEntries(state.jsonMeta)));
  } catch {
    /* read-only filesystem (e.g. a container): the memory cache still works */
  }
}

const isWindow = (m: RawMarket) => m.startMs !== null && m.endMs !== null;

async function scanProgram(filters: Parameters<import("@solana/web3.js").Connection["getProgramAccounts"]>[1]) {
  // Retried across endpoints with a short backoff: the shared public RPC is occasionally slow.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await withFallback(scanUrls(), (c) => c.getProgramAccounts(new PublicKey(WORLD_PROGRAM_ID), filters));
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("World market scan failed");
}

/**
 * Reads accounts on mainnet; any that are gone there are read from the fork instead. World closes a
 * market's accounts once it resolves (e.g. the losing drivers of a finished F1 race), while the
 * fork keeps the copy it cloned, and trades / positions on the fork still use it: without this an
 * event would shrink to its surviving market (a lone "Will X win?" in place of the race).
 */
async function readMany(keys: string[]): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100).map((k) => new PublicKey(k));
    out.push(...((await withMainnet((c) => c.getMultipleAccountsInfo(batch))) as (AccountInfo<Buffer> | null)[]));
  }
  const missing = out.flatMap((info, j) => (info ? [] : [j]));
  if (missing.length) {
    try {
      for (let i = 0; i < missing.length; i += 100) {
        const idx = missing.slice(i, i + 100);
        const infos = await getConnection().getMultipleAccountsInfo(idx.map((j) => new PublicKey(keys[j])));
        idx.forEach((j, n) => (out[j] = (infos[n] as AccountInfo<Buffer> | null) ?? null));
      }
    } catch (error) {
      console.warn("Predict fork account read failed:", error instanceof Error ? error.message : error);
    }
  }
  return out;
}

async function loadMintMeta(mints: string[]): Promise<void> {
  const missing = [...new Set(mints)].filter((k) => !state.mintMeta.has(k));
  const infos = await readMany(missing);
  infos.forEach((info, j) => {
    const meta = info ? parseTokenMetadata(info.data as Buffer) : null;
    if (meta) state.mintMeta.set(missing[j], meta);
  });
}

async function loadOpenInterest(ids: string[]): Promise<void> {
  const markets = ids.map((id) => state.all.get(id)).filter((m): m is RawMarket => Boolean(m));
  const infos = await readMany(markets.map((m) => m.vault));
  markets.forEach((m, i) => {
    const info = infos[i];
    state.openInterest.set(m.id, info ? Number(tokenAmountOf(info.data as Buffer)) / 10 ** CASH_DECIMALS : 0);
  });
}

/**
 * The featured markets and Groups (lib/predict/featured.ts) read directly by address — two batched
 * getMultipleAccounts calls instead of scanning every World market — in the scan's result shape.
 */
async function readFeatured() {
  const ids = [...FEATURED_MARKET_IDS, ...FEATURED_GROUP_IDS];
  const infos = await readMany(ids);
  const rows = ids.map((id, i) => ({ pubkey: new PublicKey(id), account: infos[i] })).filter((r): r is { pubkey: PublicKey; account: AccountInfo<Buffer> } => Boolean(r.account));
  const groupSet = new Set(FEATURED_GROUP_IDS);
  return [rows.filter((r) => !groupSet.has(r.pubkey.toBase58())), rows.filter((r) => groupSet.has(r.pubkey.toBase58()))] as const;
}

/**
 * Loads the catalog: by default only the featured markets (World's Trending events); with
 * PREDICT_ALL_MARKETS=1 it scans all World markets and Groups on mainnet. Then it fetches what the
 * listed ones need.
 */
async function loadCatalog(): Promise<void> {
  const featured = featuredOnly();
  const [marketAccounts, groupAccounts] = featured
    ? await readFeatured()
    : await Promise.all([
        scanProgram({ filters: [{ dataSize: MARKET_ACCOUNT_SIZE }] }),
        scanProgram({ filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(Buffer.from(GROUP_DISCRIMINATOR_HEX, "hex")) } }] }),
      ]);
  const now = Date.now();
  const all = new Map<string, RawMarket>();
  const marketByMint = new Map<string, string>();
  for (const { pubkey, account } of marketAccounts) {
    const m = decodeMarket(pubkey.toBase58(), account.data as Buffer);
    if (!m) continue;
    all.set(m.id, m);
    marketByMint.set(m.yesMint, m.id);
    marketByMint.set(m.noMint, m.id);
  }
  const groups = new Map<string, RawGroup>();
  const groupOf = new Map<string, string>();
  for (const { pubkey, account } of groupAccounts) {
    const grp = decodeGroup(pubkey.toBase58(), account.data as Buffer);
    if (!grp) continue;
    groups.set(grp.id, grp);
    for (const m of grp.members) groupOf.set(m, grp.id);
  }
  if (featured) {
    // A featured Group World has closed (its match resolved) and the fork never cloned: its members
    // come from the curated list, so the event keeps its id and outcomes instead of splitting into
    // one lone market per side.
    for (const e of FEATURED_EVENTS) {
      if (!e.groupId || groups.has(e.groupId)) continue;
      groups.set(e.groupId, { id: e.groupId, members: e.markets });
      for (const m of e.markets) if (!groupOf.has(m)) groupOf.set(m, e.groupId);
    }
  }
  state.all = all;
  state.marketByMint = marketByMint;
  state.groups = groups;
  state.groupOf = groupOf;

  // Open interest of every non-window market decides what is listed.
  const nonWindow = [...all.values()].filter((m) => !isWindow(m)).map((m) => m.id);
  await loadOpenInterest(nonWindow);
  const live = new Set<string>();
  for (const m of all.values()) {
    if (featured) {
      // Curated: every featured market is listed (no open-interest floor) until it ends.
      if (m.endMs === null || m.endMs > now) live.add(m.id);
    } else if (isWindow(m)) {
      if (m.endMs! > now && m.startMs! <= now + UPCOMING_WINDOW_MS) live.add(m.id);
    } else if ((state.openInterest.get(m.id) ?? 0) >= MIN_OPEN_INTEREST && (m.endMs === null || m.endMs > now)) {
      live.add(m.id);
    }
  }
  // A live Group lists all its members, so a match keeps its draw / other side.
  for (const id of [...live]) {
    const gid = groupOf.get(id);
    if (gid) for (const sibling of groups.get(gid)!.members) if (all.has(sibling)) live.add(sibling);
  }
  state.listed = [...live];
  await loadMintMeta(state.listed.map((id) => all.get(id)!.yesMint));
  state.loadedAt = Date.now();

  const needJson = state.listed.map((id) => all.get(id)!).filter((m) => !isWindow(m)).map((m) => m.yesMint);
  needJson.forEach(queueJson);
  if (state.jsonWorker) await Promise.race([state.jsonWorker, new Promise((r) => setTimeout(r, FIRST_LOAD_JSON_WAIT_MS))]);
  sweepUnpricedMarkets(state.listed.map((id) => all.get(id)!).filter((m) => !isWindow(m)));
}

function queueJson(mint: string) {
  if (state.jsonMeta.has(mint)) return;
  state.jsonQueue.add(mint);
  if (!state.jsonWorker) state.jsonWorker = runJsonWorker().finally(() => (state.jsonWorker = null));
}

/** Background fetch of World's per-mint JSON metadata (category image + question text). */
async function runJsonWorker() {
  let sinceSave = 0;
  while (state.jsonQueue.size) {
    const batch = [...state.jsonQueue].slice(0, JSON_FETCH_CONCURRENCY);
    batch.forEach((m) => state.jsonQueue.delete(m));
    await Promise.all(
      batch.map(async (mint) => {
        const uri = state.mintMeta.get(mint)?.uri;
        if (!uri?.startsWith("https://")) return;
        try {
          const res = await fetch(uri, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
          if (res.ok) state.jsonMeta.set(mint, (await res.json()) as JsonMeta);
        } catch {
          /* retried on the next catalog refresh */
        }
      }),
    );
    if ((sinceSave += batch.length) >= 60) {
      saveJsonCache();
      sinceSave = 0;
    }
  }
  saveJsonCache();
}

/** Loads (or refreshes in the background) the catalog; the first call waits for the scan. */
export async function ensureCatalog(): Promise<void> {
  const stale = Date.now() - state.loadedAt > CATALOG_TTL_MS;
  if (!stale) return;
  if (!state.loading) state.loading = loadCatalog().finally(() => (state.loading = null));
  if (state.loadedAt === 0) await state.loading;
}

function toInfo(m: RawMarket): MarketInfo {
  const meta = state.mintMeta.get(m.yesMint);
  const json = state.jsonMeta.get(m.yesMint);
  const { category, league } = classify(meta, json);
  return {
    id: m.id,
    yesMint: m.yesMint,
    noMint: m.noMint,
    vault: m.vault,
    resolutionKind: m.resolutionKind,
    startMs: m.startMs,
    endMs: m.endMs,
    name: meta?.name ?? "",
    symbol: meta?.symbol ?? "",
    question: questionFrom(meta, json),
    description: json?.description ?? null,
    image: json?.image ?? null,
    category,
    league,
    groupId: state.groupOf.get(m.id) ?? null,
  };
}

/** Every listed market (with metadata), plus the Group membership needed to group them. */
export async function listMarketInfos(): Promise<{ markets: MarketInfo[]; groups: Map<string, string[]> }> {
  await ensureCatalog();
  const now = Date.now();
  const markets = state.listed
    .map((id) => state.all.get(id)!)
    .filter((m) => m && (m.endMs === null || m.endMs > now) && state.mintMeta.has(m.yesMint))
    .map(toInfo);
  const groups = new Map<string, string[]>();
  for (const m of markets) if (m.groupId && !groups.has(m.groupId)) groups.set(m.groupId, state.groups.get(m.groupId)!.members);
  return { markets, groups };
}

/** One market (listed or not, e.g. an ended window a user still holds), read directly if needed. */
export async function getMarketInfo(id: string): Promise<MarketInfo | null> {
  await ensureCatalog();
  let m = state.all.get(id);
  if (!m) {
    let key: PublicKey;
    try {
      key = new PublicKey(id);
    } catch {
      return null; // not an account address (e.g. a stale derived event id "f-…")
    }
    // Mainnet first, then the fork's copy of a market World has since closed (see readMany).
    const info = (await withMainnet((c) => c.getAccountInfo(key))) ?? (await getConnection().getAccountInfo(key).catch(() => null));
    const decoded = info && info.owner.toBase58() === WORLD_PROGRAM_ID ? decodeMarket(id, info.data as Buffer) : null;
    if (!decoded) return null;
    m = decoded;
    state.all.set(id, m);
  }
  await loadMintMeta([m.yesMint]);
  if (!isWindow(m)) queueJson(m.yesMint);
  return toInfo(m);
}

/** The market an outcome mint belongs to (any market on chain), or null. */
export async function marketIdForMint(mint: string): Promise<string | null> {
  await ensureCatalog();
  return state.marketByMint.get(mint) ?? null;
}

/** Open interest (CASH in the vault) as of the last catalog load; refresh with `refreshOpenInterest`. */
export const openInterestOf = (id: string) => state.openInterest.get(id) ?? 0;

/** Re-reads the vault balance of a few markets (event page / after a trade). */
export async function refreshOpenInterest(ids: string[]): Promise<void> {
  await loadOpenInterest(ids);
}
