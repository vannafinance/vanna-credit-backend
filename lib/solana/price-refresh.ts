/**
 * Keeps the fork's Pyth PriceUpdateV2 accounts fresh before risk-checked transactions.
 *
 * Every asset has `max_price_age_secs = 3600` and the fork has no live Pyth pusher, so the app
 * calls the server's price keeper (`POST /api/prices/refresh`, which rewrites each price account
 * via the `surfnet_setAccount` cheatcode with a live Jupiter USD price and the fork clock) on load
 * and before every borrow / withdraw.
 *
 * Browser default: POST to the API route. Scripts inject the server function directly with
 * {@link setPriceRefresher} (there's no Next.js server in a tsx process).
 */
type Refresher = () => Promise<unknown>;

let refresher: Refresher = async () => {
  const res = await fetch("/api/prices/refresh", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `Price refresh failed (${res.status})`);
  }
  return res.json();
};

/** Replace the refresher (e2e scripts pass `refreshForkPrices` from lib/solana/server/fork-prices). */
export function setPriceRefresher(fn: Refresher) {
  refresher = fn;
}

let inflight: Promise<unknown> | null = null;
let lastRefreshAt = 0;
/** Refreshes at most once per this window (prices then have ~an hour of validity left). */
const MIN_INTERVAL_MS = 60_000;

/**
 * Refresh the fork prices unless that was done within the last minute. Concurrent callers share
 * one request. Failures are rethrown so a borrow doesn't proceed into a certain StalePrice error.
 */
export async function ensureFreshPrices(force = false): Promise<void> {
  if (!force && Date.now() - lastRefreshAt < MIN_INTERVAL_MS) return;
  if (!inflight) {
    inflight = refresher()
      .then(() => {
        lastRefreshAt = Date.now();
      })
      .finally(() => {
        inflight = null;
      });
  }
  await inflight;
}
