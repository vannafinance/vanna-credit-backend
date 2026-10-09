/**
 * Margin-account registry: which accounts exist, found WITHOUT scanning every account on every
 * request.
 *
 * Why not `getProgramAccounts`: the hosted fork forwards it to the upstream mainnet RPC, which
 * rate-limits it (HTTP 429), and the accounts we want only exist on the fork anyway. So accounts are
 * found from the program's own transactions (every margin action touches the margin PDA) and each
 * candidate is VERIFIED on-chain (owner = the Vanna program, Margin discriminator, PDA matches its
 * authority) before it is counted.
 *
 * Scan cost is bounded and incremental:
 *  - first scan walks backwards through at most `ANALYTICS_MAX_SIGNATURES` program transactions, a
 *    fixed budget per tick (never one giant blocking scan);
 *  - later ticks only fetch signatures NEWER than the newest one already inspected (`until`);
 *  - a transaction is fetched once, ever; a candidate key is verified once (negative results are
 *    remembered), so repeats cost nothing;
 *  - coverage is reported honestly (`Coverage`): "found in the last N transactions", never "all".
 *
 * State lives in this process. Cloud Run instances each build their own copy; a shared store
 * (Firestore/Redis) is the upgrade path when running more than one instance (see docs).
 */
import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { VANNA_PROGRAM_ID } from "@/lib/solana/config";
import { getConnection, getMultipleAccountsChunked } from "@/lib/solana/connection";
import { marginPda } from "@/lib/solana/pdas";
import { VANNA_IDL } from "@/lib/solana/program";
import { singleFlight } from "@/lib/async";
import type { Coverage } from "../types";
import { recordEvents } from "./events";
import type { PersistedRegistry } from "./persistence";

const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
/** Look-back window (program transactions). Raise to see older accounts; costs one fetch per transaction, once. */
export const MAX_SIGNATURES = num(process.env.ANALYTICS_MAX_SIGNATURES, 5000);
/** Transactions inspected per tick, so one refresh stays short. */
const TICK_BUDGET = num(process.env.ANALYTICS_TICK_BUDGET, 120);
const PAGE = 1000;
/** Parallel getTransaction calls. Kept low on purpose: the fork's upstream RPC rate-limits (HTTP 429). */
const CONCURRENCY = num(process.env.ANALYTICS_TX_CONCURRENCY, 3);
/** A transaction that still will not load after this many tries is skipped (reported), not retried forever. */
const MAX_ATTEMPTS = 3;
const attempts = new Map<string, number>();
const REJECTED_LIMIT = 50_000;

const MARGIN_DISCRIMINATOR = Buffer.from(
  (VANNA_IDL.accounts as Array<{ name: string; discriminator: number[] }>).find((a) => a.name === "MarginAccount")!.discriminator,
);

interface Registry {
  /** margin PDA (base58) → authority (base58) */
  margins: Map<string, string>;
  /** keys already verified as NOT margin accounts */
  rejected: Set<string>;
  /** newest-first signatures waiting to be inspected */
  queue: ConfirmedSignatureInfo[];
  newestSignature: string | null;
  oldestSignature: string | null;
  /** signatures discovered (queued or inspected) — bounds the look-back */
  discovered: number;
  inspected: number;
  oldestInspectedTime: number | null;
  /** Transactions given up on after MAX_ATTEMPTS failed loads (reported in coverage). */
  skipped: number;
  /** margin PDA → unix time of the earliest INSPECTED transaction that touched it (not creation time). */
  firstSeen: Map<string, number>;
  /** Are there program transactions older than the window? null until checked. */
  olderExists: boolean | null;
  backfillExhausted: boolean;
  lastError: string | null;
}

const registry: Registry = {
  margins: new Map(), rejected: new Set(), queue: [],
  newestSignature: null, oldestSignature: null, discovered: 0, inspected: 0,
  oldestInspectedTime: null, skipped: 0, firstSeen: new Map(), olderExists: null, backfillExhausted: false, lastError: null,
};

export function coverage(): Coverage {
  const pending = registry.queue.length;
  return {
    accountsFound: registry.margins.size,
    transactionsScanned: registry.inspected,
    transactionsPending: pending,
    oldestScannedTime: registry.oldestInspectedTime,
    complete: pending === 0 && (registry.backfillExhausted || registry.discovered >= MAX_SIGNATURES),
    olderActivityExists: registry.backfillExhausted ? false : registry.olderExists,
    transactionsSkipped: registry.skipped,
    windowLimit: MAX_SIGNATURES,
  };
}

export const knownMargins = (): Array<{ address: string; owner: string }> =>
  [...registry.margins].map(([address, owner]) => ({ address, owner }));
export const registryError = () => registry.lastError;
export const firstSeenTime = (address: string): number | null => registry.firstSeen.get(address) ?? null;

/** Verified margin account → authority, or null. */
function marginAuthority(key: PublicKey, info: { owner: PublicKey; data: Buffer } | null): PublicKey | null {
  if (!info || !info.owner.equals(VANNA_PROGRAM_ID) || info.data.length < 40) return null;
  if (!Buffer.from(info.data.subarray(0, 8)).equals(MARGIN_DISCRIMINATOR)) return null;
  const authority = new PublicKey(info.data.subarray(8, 40));
  return marginPda(authority).equals(key) ? authority : null; // a real margin PDA, not a lookalike
}

async function verify(keys: PublicKey[]) {
  const fresh = keys.filter((k) => !registry.margins.has(k.toBase58()) && !registry.rejected.has(k.toBase58()));
  if (!fresh.length) return;
  const infos = await getMultipleAccountsChunked(getConnection(), fresh);
  fresh.forEach((key, i) => {
    const authority = marginAuthority(key, infos[i]);
    if (authority) registry.margins.set(key.toBase58(), authority.toBase58());
    else registry.rejected.add(key.toBase58());
  });
  if (registry.rejected.size > REJECTED_LIMIT) {
    // Bound memory; forgetting a rejection only costs one re-read.
    const keep = [...registry.rejected].slice(-REJECTED_LIMIT / 2);
    registry.rejected = new Set(keep);
  }
}

/** Account keys a transaction touches (static + address-table loaded). */
async function candidateKeys(signature: string, blockTime: number | null): Promise<PublicKey[] | null> {
  const tx = await getConnection().getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) return null; // indexing may lag; retried next tick
  const message = tx.transaction.message;
  const keys = [...message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses ?? undefined }).keySegments().flat()];
  // The same transaction body also carries the program's events in its logs: decode them for free.
  recordEvents(signature, blockTime ?? tx.blockTime ?? null, tx.meta?.logMessages ?? []);
  return keys;
}

async function discoverSignatures() {
  const connection = getConnection();
  // 1) anything newer than what we have seen
  if (registry.newestSignature) {
    const fresh: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await connection.getSignaturesForAddress(VANNA_PROGRAM_ID, { until: registry.newestSignature, before, limit: PAGE }, "confirmed");
      fresh.push(...page);
      if (page.length < PAGE) break;
      before = page[page.length - 1].signature;
    }
    if (fresh.length) {
      registry.queue.unshift(...fresh.filter((s) => !s.err));
      registry.newestSignature = fresh[0].signature;
      registry.discovered += fresh.length;
    }
  }
  // 2) older ones, until the look-back window is full
  if (!registry.backfillExhausted && registry.discovered < MAX_SIGNATURES) {
    const limit = Math.min(PAGE, MAX_SIGNATURES - registry.discovered);
    const page = await connection.getSignaturesForAddress(
      VANNA_PROGRAM_ID,
      { before: registry.oldestSignature ?? undefined, limit },
      "confirmed",
    );
    if (page.length) {
      registry.queue.push(...page.filter((s) => !s.err));
      registry.newestSignature ??= page[0].signature;
      registry.oldestSignature = page[page.length - 1].signature;
      registry.discovered += page.length;
    }
    if (page.length < limit) registry.backfillExhausted = true;
  }
  // Window full: is there anything older we are NOT covering? (one signature is enough to tell)
  if (!registry.backfillExhausted && registry.discovered >= MAX_SIGNATURES && registry.olderExists === null && registry.oldestSignature) {
    const older = await connection.getSignaturesForAddress(VANNA_PROGRAM_ID, { before: registry.oldestSignature, limit: 1 }, "confirmed");
    registry.olderExists = older.length > 0;
  }
}

async function inspect(batch: ConfirmedSignatureInfo[]) {
  const found: PublicKey[] = [];
  const done: ConfirmedSignatureInfo[] = [];
  const touched: Array<{ time: number | null; keys: PublicKey[] }> = [];
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map((s) => candidateKeys(s.signature, s.blockTime ?? null).catch(() => null)));
    results.forEach((keys, j) => {
      if (!keys) {
        // Not indexed yet, or the call failed: retry next tick, but only a few times.
        const n = (attempts.get(slice[j].signature) ?? 0) + 1;
        attempts.set(slice[j].signature, n);
        if (n >= MAX_ATTEMPTS) { done.push(slice[j]); registry.skipped += 1; attempts.delete(slice[j].signature); }
        return;
      }
      attempts.delete(slice[j].signature);
      done.push(slice[j]);
      found.push(...keys);
      touched.push({ time: slice[j].blockTime ?? null, keys });
    });
  }
  await verify([...new Map(found.map((k) => [k.toBase58(), k])).values()]);
  for (const t of touched) {
    if (t.time === null) continue;
    for (const k of t.keys) {
      const a = k.toBase58();
      if (!registry.margins.has(a)) continue;
      const prev = registry.firstSeen.get(a);
      if (prev === undefined || t.time < prev) registry.firstSeen.set(a, t.time);
    }
  }
  for (const s of done) {
    registry.inspected += 1;
    if (s.blockTime && (registry.oldestInspectedTime === null || s.blockTime < registry.oldestInspectedTime)) registry.oldestInspectedTime = s.blockTime;
  }
  const doneSet = new Set(done.map((s) => s.signature));
  registry.queue = registry.queue.filter((s) => !doneSet.has(s.signature));
}

const tickReads = singleFlight<string, void>();
/** One bounded unit of discovery work. Safe to call concurrently (shared). */
export function tick(): Promise<void> {
  return tickReads("tick", async () => {
    try {
      await discoverSignatures();
      await inspect(registry.queue.slice(0, TICK_BUDGET));
      registry.lastError = null;
    } catch (error) {
      // Provider messages can embed keyed URLs: keep only a safe summary.
      registry.lastError = error instanceof Error ? error.name : "Error";
    }
  });
}

/** True while there is more look-back work to do (the store keeps ticking back-to-back). */
export const hasBacklog = () => registry.queue.length > 0 || (!registry.backfillExhausted && registry.discovered < MAX_SIGNATURES);

/** Add a wallet's margin account on demand (the "look up a wallet" box). Verified like the rest. */
export async function registerOwner(owner: PublicKey): Promise<boolean> {
  const key = marginPda(owner);
  await verify([key]);
  return registry.margins.has(key.toBase58());
}

/** Cheap change detector so the store only saves when something moved. */
export const registryFingerprint = () => `${registry.margins.size}:${registry.inspected}:${registry.discovered}:${registry.queue.length}:${registry.firstSeen.size}`;
/** The newest signature inspected or queued — used to check a saved state still matches the network. */
export const newestKnownSignature = () => registry.newestSignature;

export function exportRegistry(): PersistedRegistry {
  return {
    margins: [...registry.margins], firstSeen: [...registry.firstSeen],
    queue: registry.queue.map((s) => ({ signature: s.signature, blockTime: s.blockTime ?? null })),
    newestSignature: registry.newestSignature, oldestSignature: registry.oldestSignature,
    discovered: registry.discovered, inspected: registry.inspected, oldestInspectedTime: registry.oldestInspectedTime,
    backfillExhausted: registry.backfillExhausted,
  };
}

/** Resume from a saved state. Only call on an empty registry, before the first tick. */
export function importRegistry(p: PersistedRegistry): void {
  registry.margins = new Map(p.margins);
  registry.firstSeen = new Map(p.firstSeen);
  registry.queue = p.queue.map((s) => ({ signature: s.signature, slot: 0, err: null, memo: null, blockTime: s.blockTime }));
  registry.newestSignature = p.newestSignature; registry.oldestSignature = p.oldestSignature;
  registry.discovered = p.discovered; registry.inspected = p.inspected; registry.oldestInspectedTime = p.oldestInspectedTime;
  registry.backfillExhausted = p.backfillExhausted;
}

/** Test hook. */
export function resetRegistryForTests() {
  registry.margins.clear(); registry.rejected.clear(); registry.queue = [];
  registry.newestSignature = null; registry.oldestSignature = null; registry.discovered = 0; registry.inspected = 0;
  registry.oldestInspectedTime = null; registry.firstSeen.clear(); registry.skipped = 0; attempts.clear(); registry.olderExists = null; registry.backfillExhausted = false; registry.lastError = null;
}
