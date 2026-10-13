/**
 * Prediction Vaults analytics (server only): every outcome pool the program has created, with where
 * its money sits after users buy YES / NO on Predict:
 *
 * - YES / NO shares held by the pool, and the matched pairs (min of the two) still to be merged;
 * - USDC the pool has supplied to Vanna's USDC lending pool (idle USDC included, valued at the
 *   reserve's exchange rate, as on chain);
 * - whether the market can merge at all: World's market-level merge only works when the market owns
 *   its CASH vault; outcome markets of a World Group share one Group-owned vault and merge through
 *   the pool's `merge_and_deposit_in_group`, which needs that Group account to still exist. Once World
 *   closes an ended event's Group, its matched pairs can't merge any more (`mergeable: false`).
 *
 * Names come from the Predict listing (event title + outcome) or, for a market no longer listed,
 * from its on-chain mint name. Cached briefly; everything is a live chain read, nothing is stored.
 */
import { PublicKey } from "@solana/web3.js";
import { getConnection, getMultipleAccountsChunked } from "@/lib/solana/connection";
import { CASH_DECIMALS, GROUP_DISCRIMINATOR_HEX, WORLD_PROGRAM_ID } from "./constants";
import { allCatalogMarketIds, getMarketInfo } from "./catalog.server";
import { FEATURED_MARKET_IDS } from "./featured";
import { listEvents } from "./events.server";
import { listPoolMarketIds, readPoolStates } from "./pool.server";

export type PredictPoolStatus = "earning" | "merge-pending" | "cannot-merge" | "one-sided" | "empty";

export interface PredictPoolRow {
  marketId: string;
  pool: string;
  /** Event title on Predict (the market's own question when it isn't listed). */
  event: string;
  /** Outcome name within the event. */
  outcome: string;
  /** Predict page for the event (or market). */
  href: string;
  listed: boolean;
  allowlisted: boolean;
  /** Outcome shares held by the pool (1 share pays $1 if right). */
  yes: number;
  no: number;
  /** Matched YES + NO sets not merged yet (each worth $1 of CASH). */
  pairs: number;
  /** USDC in Vanna's USDC lending pool for this pool. */
  usdcInVanna: number;
  /** Its matched pairs can merge: the market owns its CASH vault, or the vault's World Group is still live. */
  mergeable: boolean;
  status: PredictPoolStatus;
}

export interface PredictPoolsResponse {
  updatedAt: number;
  pools: PredictPoolRow[];
  totals: {
    pools: number;
    withFunds: number;
    yes: number;
    no: number;
    pairs: number;
    /** Matched pairs that can't merge (their event's World Group is closed). */
    pairsBlocked: number;
    usdcInVanna: number;
    mergeablePools: number;
    groupPools: number;
  };
}

const TTL_MS = 20_000;
const g = globalThis as unknown as { __predictPoolAnalytics?: { at: number; data: PredictPoolsResponse | null; pending: Promise<PredictPoolsResponse> | null } };
const cache = (g.__predictPoolAnalytics ??= { at: 0, data: null, pending: null });

const STATUS_ORDER: Record<PredictPoolStatus, number> = { earning: 0, "merge-pending": 1, "cannot-merge": 2, "one-sided": 3, empty: 4 };

const ui = (raw: bigint) => Number(raw) / 10 ** CASH_DECIMALS;

function statusOf(r: Pick<PredictPoolRow, "yes" | "no" | "pairs" | "usdcInVanna" | "mergeable">): PredictPoolStatus {
  if (r.pairs > 0) return r.mergeable ? "merge-pending" : "cannot-merge";
  if (r.usdcInVanna > 0) return "earning";
  if (r.yes > 0 || r.no > 0) return "one-sided";
  return "empty";
}

/**
 * Markets to check for a pool. getProgramAccounts over the pool program finds every pool directly, but
 * the hosted fork forwards that query upstream and it can fail there; then every catalog market (plus
 * the featured list) is checked instead: pool addresses are derived, so that is only batched reads.
 */
async function poolCandidates(): Promise<string[]> {
  try {
    return await listPoolMarketIds();
  } catch {
    const catalog = await allCatalogMarketIds().catch(() => [] as string[]);
    return [...new Set([...FEATURED_MARKET_IDS, ...catalog])];
  }
}

async function build(): Promise<PredictPoolsResponse> {
  const [ids, events] = await Promise.all([poolCandidates(), listEvents().catch(() => [])]);
  const named = new Map<string, { event: string; outcome: string; href: string }>();
  for (const e of events) for (const o of e.outs) named.set(o.marketId, { event: e.title, outcome: o.name, href: `/predict/${e.id}` });

  const states = await readPoolStates(ids);
  // Who owns each market's CASH vault (token account owner, bytes 32..64): the market, or its World Group.
  const vaults = ids.map((id) => states.get(id)?.account?.marketCashVault ?? PublicKey.default);
  const vaultInfos = ids.length ? await getMultipleAccountsChunked(getConnection(), vaults) : [];
  const owners = vaultInfos.map((v) => (v && v.data.length >= 64 ? new PublicKey(v.data.subarray(32, 64)) : null));
  // Group-owned vaults merge through the live Group account; a closed (ended) Group can't sign any more.
  const groupKeys = [...new Set(owners.filter((o, i): o is PublicKey => Boolean(o) && !o!.equals(new PublicKey(ids[i]))).map((o) => o.toBase58()))];
  const groupInfos = groupKeys.length ? await getMultipleAccountsChunked(getConnection(), groupKeys.map((k) => new PublicKey(k))) : [];
  const liveGroups = new Set(
    groupKeys.filter((_, i) => {
      const g = groupInfos[i];
      return Boolean(g && g.owner.toBase58() === WORLD_PROGRAM_ID && g.data.subarray(0, 8).toString("hex") === GROUP_DISCRIMINATOR_HEX);
    }),
  );

  const pools: PredictPoolRow[] = [];
  for (const [i, id] of ids.entries()) {
    const s = states.get(id);
    if (!s?.exists) continue;
    const owner = owners[i];
    // A vault the fork hasn't loaded yet (nothing deposited) isn't known to be closed, so it isn't counted as ended.
    const mergeable = !owner || owner.equals(new PublicKey(id)) || liveGroups.has(owner.toBase58());
    let name = named.get(id);
    if (!name) {
      const info = await getMarketInfo(id).catch(() => null);
      name = { event: info?.question || info?.name || id, outcome: info?.name ?? "", href: `/predict/${id}` };
    }
    const yes = ui(s.yesDangling);
    const no = ui(s.noDangling);
    const row = {
      marketId: id,
      pool: s.pool.toBase58(),
      ...name,
      listed: named.has(id),
      allowlisted: s.allowlisted,
      yes,
      no,
      pairs: Math.min(yes, no),
      usdcInVanna: ui(s.invested),
      mergeable,
    };
    pools.push({ ...row, status: statusOf(row) });
  }
  // Earning pools first, then pairs waiting (merge pending, then can't merge yet), then one-sided and
  // empty pools; within a status, the most money first.
  const size = (r: PredictPoolRow) => r.usdcInVanna + r.pairs + (r.yes + r.no) / 1e6;
  pools.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || size(b) - size(a));

  const sum = (f: (r: PredictPoolRow) => number) => pools.reduce((t, r) => t + f(r), 0);
  return {
    updatedAt: Date.now(),
    pools,
    totals: {
      pools: pools.length,
      withFunds: pools.filter((r) => r.status !== "empty").length,
      yes: sum((r) => r.yes),
      no: sum((r) => r.no),
      pairs: sum((r) => r.pairs),
      pairsBlocked: sum((r) => (r.mergeable ? 0 : r.pairs)),
      usdcInVanna: sum((r) => r.usdcInVanna),
      mergeablePools: pools.filter((r) => r.mergeable).length,
      groupPools: pools.filter((r) => !r.mergeable).length,
    },
  };
}

/** Every outcome pool and its totals (cached ~20 s; concurrent callers share one read). */
export async function readPredictPools(): Promise<PredictPoolsResponse> {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  cache.pending ??= build()
    .then((d) => {
      cache.data = d;
      cache.at = Date.now();
      return d;
    })
    .finally(() => (cache.pending = null));
  return cache.pending;
}
