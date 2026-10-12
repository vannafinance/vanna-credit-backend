/**
 * Server-side analytics store: stale-while-revalidate with single-flight refresh.
 *
 * Requests NEVER trigger a scan. They read the latest published snapshot and, if it is older than
 * the refresh interval (or discovery still has a backlog), kick a background refresh and return at
 * once. The browser polls; the server keeps its own pace regardless of how many tabs are open.
 *
 * A refresh pass = one bounded registry tick + shared reads (once) + a batch read of the accounts
 * that need it:
 *   - while discovery has a backlog: only newly found accounts are read (each pass is short, the
 *     partial picture is published immediately with honest `coverage`);
 *   - when idle: every known account is re-read in one batched pass.
 *
 * In-memory, per server process. See docs/ANALYTICS_ARCHITECTURE.md for the multi-instance path.
 */
import { forkUnixTimestamp } from "@/lib/solana/connection";
import { fetchAllAssetConfigs, fetchPoolStates, serializePoolState, type SerializedPoolState } from "@/lib/solana/protocol-state";
import { oracleSourceLabel } from "@/lib/solana/oracle";
import { annualBorrowRate, WAD } from "@/lib/solana/math";
import { readOnchainPrices } from "@/lib/solana/prices";
import { TOKENS, tokenByMint } from "@/lib/solana/tokens";
import { receiptByMint } from "@/lib/solana/kamino";
import { vaultByMint } from "@/lib/solana/vault-catalogue";
import { accounts as programAccounts } from "@/lib/solana/program";
import { protocolConfigPda } from "@/lib/solana/pdas";
import { PHUSD_MINT } from "@/lib/solana/phoenix";
import { getConnection } from "@/lib/solana/connection";
import { summarize } from "../risk";
import type { AccountRow, AccountView, AccountsSummary, Coverage } from "../types";
import { exportKnownVaults, importKnownVaults, knownVaultCount, loadSharedContext, readAccountRows, type SharedContext } from "./accounts";
import { coverage, exportRegistry, firstSeenTime, hasBacklog, importRegistry, knownMargins, newestKnownSignature, registerMargin, registerOwner, registryError, registryFingerprint, tick } from "./registry";
import { eventsFingerprint, exportEvents, importEvents } from "./events";
import { loadState, persistenceBackend, saveState, SCHEMA } from "./persistence";
import { VANNA_PROGRAM_ID } from "@/lib/solana/config";

const REFRESH_MS = Math.max(5, Number(process.env.ANALYTICS_REFRESH_SECONDS) || 45) * 1000;
/** Pause between back-to-back scan bursts while discovery has a backlog. */
const BACKLOG_PAUSE_MS = Math.max(0, Number(process.env.ANALYTICS_BACKLOG_PAUSE_MS) || 2000);

export interface Snapshot {
  rows: AccountRow[];
  summary: AccountsSummary;
  coverage: Coverage;
  /** Wall-clock ms the snapshot was published. */
  asOf: number;
  /** Fork clock (unix seconds) the values were measured against. */
  forkTime: number;
}

const rowCache = new Map<string, AccountRow>();
/** Server-measured health factors per account (one point per full pass), bounded. */
const HISTORY_POINTS = 30;
const hfHistory = new Map<string, number[]>();
let current: Snapshot | null = null;
let running: Promise<void> | null = null;
let lastError: string | null = null;
let lastFullAt = 0;
let lastAttemptAt = 0;

function publish(ctx: SharedContext) {
  const rows = [...rowCache.values()];
  current = { rows, summary: summarize(rows), coverage: coverage(), asOf: Date.now(), forkTime: Number(ctx.now) };
}

// ---- durable copy of the scan state (see persistence.ts) ----------------------------------------
const SAVE_EVERY_MS = 15_000;
export const persistence = { backend: persistenceBackend(), restoredAt: null as number | null, lastSavedAt: null as number | null, lastError: null as string | null };
let loaded: Promise<void> | null = null;
let lastFingerprint = "";
let lastSaveAttempt = 0;
let lastRowsSavedAt = 0;
/** Rows are bigger than the registry, so they are saved less often. */
const ROWS_SAVE_EVERY_MS = 120_000;

/** Once per process, before the first scan: resume from the saved state if it still matches the network. */
function ensureLoaded(): Promise<void> {
  loaded ??= (async () => {
    try {
      const saved = await loadState();
      if (!saved || saved.v !== SCHEMA || saved.program !== VANNA_PROGRAM_ID.toBase58()) return;
      // A fork reset invalidates saved signatures: trust the state only if its newest transaction still exists.
      if (saved.registry.newestSignature) {
        const status = await getConnection().getSignatureStatuses([saved.registry.newestSignature], { searchTransactionHistory: true });
        if (!status.value[0]) return;
      }
      importRegistry(saved.registry);
      importEvents(saved.events);
      for (const [address, h] of Object.entries(saved.hfHistory)) hfHistory.set(address, h.slice(-HISTORY_POINTS));
      if (saved.vaults) importKnownVaults(saved.vaults, saved.savedAt); // trusted for the normal probe window from when it was saved
      if (saved.rows?.length && saved.rowsAt) {
        for (const r of saved.rows) rowCache.set(r.address, r);
        const rows = [...rowCache.values()];
        current = { rows, summary: summarize(rows), coverage: coverage(), asOf: saved.rowsAt, forkTime: saved.rowsForkTime ?? 0 };
        lastRowsSavedAt = saved.rowsAt;
      }
      persistence.restoredAt = Date.now();
      lastFingerprint = `${registryFingerprint()}:${eventsFingerprint()}:${knownVaultCount()}`;
    } catch (error) {
      persistence.lastError = error instanceof Error ? error.name : "Error"; // never trust or echo a failing store
    }
  })();
  return loaded;
}

async function maybeSave(): Promise<void> {
  if (persistence.backend === "memory" || Date.now() - lastSaveAttempt < SAVE_EVERY_MS) return;
  const fingerprint = `${registryFingerprint()}:${eventsFingerprint()}:${knownVaultCount()}`;
  const rowsDue = !!current && current.asOf - lastRowsSavedAt >= ROWS_SAVE_EVERY_MS;
  if ((fingerprint === lastFingerprint && !rowsDue) || !newestKnownSignature()) return;
  lastSaveAttempt = Date.now();
  try {
    const snap = rowsDue || fingerprint !== lastFingerprint ? current : null;
    await saveState({
      v: SCHEMA, savedAt: Date.now(), program: VANNA_PROGRAM_ID.toBase58(), registry: exportRegistry(), events: exportEvents(1000), hfHistory: Object.fromEntries(hfHistory), vaults: exportKnownVaults(),
      ...(snap ? { rows: snap.rows, rowsAt: snap.asOf, rowsForkTime: snap.forkTime } : {}),
    });
    if (snap) lastRowsSavedAt = snap.asOf;
    lastFingerprint = fingerprint; persistence.lastSavedAt = Date.now(); persistence.lastError = null;
  } catch (error) {
    persistence.lastError = error instanceof Error ? error.name : "Error";
  }
}

async function pass(): Promise<void> {
  await ensureLoaded();
  await tick();
  const ctx = await loadSharedContext();
  const margins = knownMargins();
  const backlog = hasBacklog();
  const full = !backlog && (Date.now() - lastFullAt >= REFRESH_MS || rowCache.size === 0);
  const todo = full ? margins : margins.filter((m) => !rowCache.has(m.address));
  const rows = await readAccountRows(ctx, todo);
  for (const r of rows) rowCache.set(r.address, r);
  if (full) {
    lastFullAt = Date.now();
    for (const r of rows) {
      if (r.healthFactor === null) continue;
      const h = hfHistory.get(r.address) ?? [];
      h.push(r.healthFactor);
      hfHistory.set(r.address, h.slice(-HISTORY_POINTS));
    }
  }
  publish(ctx);
  await maybeSave();
}

/** Starts a refresh if none is running. Resolves when that pass finishes (callers usually don't wait). */
function refresh(): Promise<void> {
  if (running) return running;
  lastAttemptAt = Date.now();
  running = (async () => {
    try {
      for (;;) {
        const before = registryFingerprint();
        await pass(); lastError = null;
        if (!hasBacklog() || registryError()) break;
        // No progress (nothing new inspected or discovered) → stop; the next request after the throttle retries.
        if (registryFingerprint() === before) break;
        await new Promise((r) => setTimeout(r, BACKLOG_PAUSE_MS)); // be gentle with the RPC between bursts
      }
    } catch (error) {
      lastError = error instanceof Error ? error.name : "Error"; // never echo provider URLs
    } finally {
      running = null;
    }
  })();
  return running;
}

export type StoreStatus = "warming" | "ready" | "error";
export interface StoreState {
  status: StoreStatus;
  refreshing: boolean;
  /** ms since the snapshot was published (null while warming). */
  ageMs: number | null;
  error: string | null;
}

/** Resolves once any saved state has been restored (a second or so), so the first request can already be answered from it. */
export const warm = (): Promise<void> => ensureLoaded();

/** Latest snapshot (possibly null while the first pass runs) and a background refresh trigger. */
export function readSnapshot(): { snapshot: Snapshot | null; state: StoreState } {
  const age = current ? Date.now() - current.asOf : null;
  if (!running && Date.now() - lastAttemptAt > 5_000 && (age === null || age >= REFRESH_MS || hasBacklog())) void refresh();
  const error = lastError ?? registryError();
  return {
    snapshot: current,
    state: { status: current ? "ready" : error ? "error" : "warming", refreshing: running !== null, ageMs: age, error },
  };
}

/** Add one margin account on demand and return its row (null = none). Accepts a wallet or the margin account address. */
export async function lookupOwner(address: import("@solana/web3.js").PublicKey): Promise<AccountRow | null> {
  let owner: string | null = (await registerOwner(address)) ? address.toBase58() : null;
  owner ??= await registerMargin(address);
  if (!owner) return null;
  const ctx = await loadSharedContext();
  const entry = knownMargins().find((m) => m.owner === owner);
  if (!entry) return null;
  const [row] = await readAccountRows(ctx, [entry]);
  rowCache.set(row.address, row);
  publish(ctx);
  return row;
}

export const cachedRow = (key: string): AccountRow | null => [...rowCache.values()].find((r) => r.owner === key || r.address === key) ?? null;

/** Adds the server's own measurements to a row for the API. */
export const decorate = (r: AccountRow): AccountView => ({ ...r, hfTrend: hfHistory.get(r.address) ?? [], firstSeenTime: firstSeenTime(r.address) });

// ---- protocol-level reads (pools, prices): small, shared, short-lived ----------------------------
export interface PoolDetail {
  reserveFactor: number;
  /** Raw base units, decimal string. */
  accruedProtocolFees: string;
  lastAccrual: number | null;
  shareMint: string | null;
  liquidityVault: string | null;
  collateralEnabled: boolean;
  borrowEnabled: boolean;
  maxCollateralPerMargin: string | null;
  liquidationBonusBps: number | null;
  /** Borrow APR at 0%…100% utilization, from the contract's own formula (calculated, not sampled history). */
  curve: Array<{ utilization: number; annualRate: number }>;
}
/** One registered asset's on-chain configuration. */
export interface AssetInfo {
  symbol: string;
  name: string;
  kind: "token" | "receipt" | "venue-collateral";
  /** The registry symbol it is priced off (a receipt → its underlying). */
  underlying: string;
  assetIndex: number;
  decimals: number;
  /** In the protocol's allowed-token list: every account holding it has it counted as collateral. */
  allowedAsCollateral: boolean;
  borrowEnabled: boolean;
  /** Raw base units; 0 = no limit set. */
  maxCollateralPerMargin: string;
  liquidationBonusBps: number;
  feed: string;
  maxAgeSecs: number;
}
export interface PriceInfo {
  usd: number | null;
  publishTime: number | null;
  ageSecs: number | null;
  stale: boolean;
  source: string | null;
  maxAgeSecs: number | null;
  maxTwapDivergenceBps: number | null;
  maxConfidenceBps: number | null;
  /** How the protocol prices this asset, e.g. "Kamino Scope → Pyth fallback". */
  feed: string | null;
}
export interface ProtocolOverview {
  pools: Record<string, SerializedPoolState>;
  poolDetail: Record<string, PoolDetail>;
  assets: AssetInfo[];
  prices: Record<string, PriceInfo>;
  forkTime: number;
  asOf: number;
}
let protocol: { value: ProtocolOverview; at: number } | null = null;
let protocolRunning: Promise<ProtocolOverview> | null = null;
/** Fresh enough to serve as-is. */
const PROTOCOL_TTL_MS = 10_000;
/** Older than TTL but younger than this: serve it NOW and refresh in the background. Older: wait for a fresh read. */
const PROTOCOL_MAX_STALE_MS = 60_000;

function refreshProtocol(): Promise<ProtocolOverview> {
  protocolRunning ??= readProtocolFresh()
    .then((value) => { protocol = { value, at: Date.now() }; return value; })
    .finally(() => { protocolRunning = null; });
  return protocolRunning;
}

/**
 * Pools and prices. Served from memory whenever a recent value exists (callers never wait on the RPC);
 * a value past its TTL is returned immediately while one shared background read replaces it. Every
 * value carries its own `asOf` and fork clock, so what the user sees is always labelled with its age.
 */
export async function readProtocol(): Promise<ProtocolOverview> {
  const age = protocol ? Date.now() - protocol.at : Infinity;
  if (protocol && age < PROTOCOL_TTL_MS) return protocol.value;
  if (protocol && age < PROTOCOL_MAX_STALE_MS) {
    void refreshProtocol().catch(() => undefined); // keep the last good value if the refresh fails
    return protocol.value;
  }
  return refreshProtocol();
}

async function readProtocolFresh(): Promise<ProtocolOverview> {
    const connection = getConnection();
    const [pools, prices, now] = await Promise.all([fetchPoolStates(connection), readOnchainPrices(connection), forkUnixTimestamp(connection)]);
    const assets = [...(await fetchAllAssetConfigs(connection)).values()];
    const protocolConfig = await programAccounts().protocolConfig.fetch(protocolConfigPda());
    const allowed = new Set((protocolConfig.allowedTokens as number[]).map(Number).filter((i) => i !== 65535));
    const value: ProtocolOverview = {
      pools: Object.fromEntries(Object.entries(pools).map(([k, p]) => [k, serializePoolState(p)])),
      poolDetail: Object.fromEntries(Object.entries(pools).filter(([, p]) => p.reserve).map(([k, p]) => {
        const r = p.projected ?? p.reserve!;
        const curve = Array.from({ length: 21 }, (_, i) => ({ utilization: i / 20, annualRate: annualBorrowRate(r.rateCurve, (WAD * BigInt(i)) / 20n) }));
        return [k, {
          reserveFactor: p.reserveFactor,
          accruedProtocolFees: p.reserve!.accruedProtocolFees.toString(),
          lastAccrual: Number(p.reserve!.lastUpdateTimestamp),
          shareMint: p.reserve!.shareMint.toBase58(),
          liquidityVault: p.reserve!.liquidityVault.toBase58(),
          collateralEnabled: p.asset?.collateralEnabled ?? false,
          borrowEnabled: p.asset?.borrowEnabled ?? false,
          maxCollateralPerMargin: p.asset ? p.asset.maxCollateralPerMargin.toString() : null,
          liquidationBonusBps: p.asset?.liquidationBonusBps ?? null,
          curve,
        } satisfies PoolDetail];
      })),
      assets: assets.filter((a) => a.kind === "token").map((a): AssetInfo => {
        const token = tokenByMint(a.mint), receipt = receiptByMint(a.mint), vault = vaultByMint(a.mint.toBase58());
        const symbol = token?.symbol ?? receipt?.symbol ?? vault?.symbol ?? (a.mint.equals(PHUSD_MINT) ? "phUSD" : a.mint.toBase58().slice(0, 6));
        return {
          symbol, name: token?.name ?? vault?.name ?? (receipt ? `Kamino ${receipt.underlying} receipt` : a.mint.equals(PHUSD_MINT) ? "Phoenix collateral (phUSD)" : symbol),
          kind: receipt || vault ? "receipt" : a.mint.equals(PHUSD_MINT) ? "venue-collateral" : "token", underlying: receipt?.underlying ?? vault?.asset ?? symbol,
          assetIndex: a.assetIndex, decimals: a.decimals, allowedAsCollateral: allowed.has(a.assetIndex), borrowEnabled: a.borrowEnabled,
          maxCollateralPerMargin: a.maxCollateralPerMargin.toString(), liquidationBonusBps: a.liquidationBonusBps, feed: oracleSourceLabel(a.oracle), maxAgeSecs: a.maxPriceAgeSecs,
        };
      }).sort((a, b) => a.assetIndex - b.assetIndex),
      prices: Object.fromEntries(TOKENS.map((t) => {
        const p = prices[t.symbol];
        const asset = assets.find((a) => a.mint.equals(t.mint));
        return [t.symbol, {
          usd: p?.usd ?? null, publishTime: p ? Number(p.publishTime) : null, ageSecs: p ? Number(now - p.publishTime) : null,
          stale: !p || !p.fresh, source: p?.source ?? null,
          maxAgeSecs: asset?.maxPriceAgeSecs ?? null, maxTwapDivergenceBps: asset?.oracle.maxTwapDivergenceBps ?? null,
          maxConfidenceBps: asset?.oracle.maxConfidenceBps ?? null, feed: asset ? oracleSourceLabel(asset.oracle) : null,
        } satisfies PriceInfo];
      })),
      forkTime: Number(now),
      asOf: Date.now(),
    };
    return value;
}
