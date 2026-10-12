/**
 * Which accounts to re-read from chain this loop, so the cost of a loop grows with how many
 * accounts are near the line, not with how many exist.
 *
 * An account cannot make itself liquidatable: borrow, withdraw and margin_execute are all
 * health-checked by the program above the line. Its HF only falls below 1.10 through prices
 * (and slowly through interest). So every loop:
 *  - prices are read once (the shared context);
 *  - every tracked account is re-valued in memory at those prices from its last read (each line
 *    scaled by its asset's price change);
 *  - only accounts that are due are read from chain: by tier (closer to the line = more often),
 *    immediately when the in-memory estimate nears the line, and new accounts on first sight.
 */
import type { SharedContext } from "@/lib/analytics/server/accounts";
import type { AccountRow } from "@/lib/analytics/types";

/** Re-read every loop at or below this (estimated or last-read) HF. */
export const HOT_HF = 1.15;
const TIERS: Array<{ upTo: number; everyMs: number }> = [
  { upTo: HOT_HF, everyMs: 0 },
  { upTo: 1.3, everyMs: 30_000 },
  { upTo: 1.6, everyMs: 120_000 },
  { upTo: 3, everyMs: 300_000 },
];
const IDLE_MS = 900_000;
/** A Phoenix position moves with prices the in-memory estimate doesn't see (the venue is one lump). */
const VENUE_MAX_MS = 60_000;

interface Tracked {
  row: AccountRow;
  readAt: number;
  /** USD price per asset index at the read (null when the context had none, e.g. Basis shares). */
  prices: Map<number, number | null>;
}

const tracked = new Map<string, Tracked>();

/** USD price of an asset in the shared context, or null. */
export function usdPrice(ctx: Pick<SharedContext, "prices">, assetIndex: number): number | null {
  const p = ctx.prices.get(assetIndex);
  return p && p.price > 0n ? Number(p.price) * 10 ** p.exponent : null;
}

/** The row's HF re-valued at the context's prices: each line scaled by its asset's price change. */
export function estimateHealth(t: Tracked, ctx: Pick<SharedContext, "prices">): number | null {
  const r = t.row;
  if (!r.valued || r.debtUsd === null || r.debtUsd <= 0) return r.healthFactor;
  const scale = (assetIndex: number, usd: number) => {
    const then = t.prices.get(assetIndex) ?? null;
    const now = usdPrice(ctx, assetIndex);
    return then && now ? (usd * now) / then : usd;
  };
  const collateral = r.collateral.reduce((s, l) => s + (l.kind === "venue" && l.symbol === "Phoenix" ? l.usd : scale(l.assetIndex, l.usd)), 0);
  const debt = r.debts.reduce((s, l) => s + scale(l.assetIndex, l.usd), 0);
  return debt > 0 ? collateral / debt : null;
}

/** How long an account may go unread, from its health. */
export function intervalFor(healthFactor: number | null, liquidatable: boolean, venueHeld: boolean, hasDebt: boolean): number {
  if (liquidatable) return 0;
  let every = IDLE_MS;
  if (hasDebt && healthFactor !== null) every = TIERS.find((t) => healthFactor <= t.upTo)?.everyMs ?? IDLE_MS;
  return venueHeld ? Math.min(every, VENUE_MAX_MS) : every;
}

/** The margins to read this loop. */
export function dueMargins<M extends { address: string }>(margins: M[], ctx: Pick<SharedContext, "prices">, now = Date.now()): M[] {
  return margins.filter((m) => {
    const t = tracked.get(m.address);
    if (!t) return true;
    const estimate = estimateHealth(t, ctx);
    const health = Math.min(t.row.healthFactor ?? Infinity, estimate ?? Infinity);
    const hasDebt = (t.row.debtUsd ?? 0) > 0;
    if (!t.row.valued) return now - t.readAt >= TIERS[1].everyMs; // unreadable: retry, not every loop
    return now - t.readAt >= intervalFor(Number.isFinite(health) ? health : null, t.row.liquidatable || health <= 1.1, t.row.venueHeld, hasDebt);
  });
}

/** Remembers freshly read rows with the prices they were valued at. */
export function record(rows: AccountRow[], ctx: Pick<SharedContext, "prices">, now = Date.now()) {
  for (const row of rows) {
    const indexes = [...row.collateral.map((l) => l.assetIndex), ...row.debts.map((l) => l.assetIndex)];
    tracked.set(row.address, { row, readAt: now, prices: new Map(indexes.map((i) => [i, usdPrice(ctx, i)])) });
  }
}

/** Forgets accounts that are no longer known (closed margins). */
export function prune(known: Set<string>) {
  for (const key of tracked.keys()) if (!known.has(key)) tracked.delete(key);
}

/** Every tracked account's last read (what /stats and the other commands show). */
export const trackedRows = (): AccountRow[] => [...tracked.values()].map((t) => t.row);

/** For tests. */
export const resetScheduler = () => tracked.clear();
