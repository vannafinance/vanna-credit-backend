/**
 * Browser-side "read fresh" window. Server routes cache per-wallet reads for a few seconds
 * (lib/server-cache.ts); right after the user's own transaction the app must see the new state at
 * once, so post-transaction refreshes call `markFreshReads()` and the fetchers add `fresh=1` to
 * their requests for the next few seconds, which skips the server cache.
 */
const FRESH_WINDOW_MS = 10_000;
let freshUntil = 0;

export function markFreshReads(ms = FRESH_WINDOW_MS): void {
  freshUntil = Math.max(freshUntil, Date.now() + ms);
}

/** `"?fresh=1"` (or `"&fresh=1"` when the URL already has a query) inside the window, else `""`. */
export function freshParam(hasQuery = false): string {
  return Date.now() < freshUntil ? `${hasQuery ? "&" : "?"}fresh=1` : "";
}

/** Server side: whether a request asked to skip the cache. */
export function wantsFresh(request: Request): boolean {
  return new URL(request.url).searchParams.get("fresh") === "1";
}
