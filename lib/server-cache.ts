/**
 * Short-lived server-side read cache with single flight: concurrent and repeated reads of the same
 * key share pending work, then reuse the result for `ttlMs` after success, so N tabs cost one read per
 * window instead of N. Bounded (oldest entry dropped first); failures are never cached.
 *
 * Per server instance, in memory: correct for data that is safe to serve a few seconds old
 * (prices, pools, an account between the user's own transactions). Pass `fresh: true` to bypass
 * it right after the user's own transaction (see lib/fresh-reads.ts); the fresh result then
 * replaces the cached one. Older completions cannot overwrite or delete a newer read.
 * Expected O(1) lookup/insertion/eviction; O(maxEntries) retained entries. Under capacity pressure,
 * even pending entries may be evicted; their callers still receive their results.
 */
export function ttlCache<V>(ttlMs: number, maxEntries = 500) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError("ttlMs must be finite and nonnegative");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive safe integer");
  const entries = new Map<string, { expiresAt: number | null; value: Promise<V> }>();
  return (key: string, read: () => Promise<V>, opts: { fresh?: boolean } = {}): Promise<V> => {
    const hit = entries.get(key);
    if (hit && !opts.fresh && (hit.expiresAt === null || Date.now() < hit.expiresAt)) return hit.value;
    const entry = { expiresAt: null as number | null, value: Promise.resolve().then(read) };
    entry.value = entry.value.then(
      (result) => {
        entry.expiresAt = Date.now() + ttlMs;
        return result;
      },
      (error) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      },
    );
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    return entry.value;
  };
}
