/**
 * In-memory, per-IP attempt limiter for POST /api/access. Per Cloud Run instance only (not shared
 * across instances, reset on restart) — enough to make guessing the access code by brute force
 * impractical without adding a datastore. Server-only.
 */

/** Wrong-or-right attempts allowed per IP per window. */
export const ACCESS_MAX_ATTEMPTS = 10;
/** Window length. */
export const ACCESS_WINDOW_MS = 10 * 60 * 1000;
/**
 * Attempts allowed across ALL clients per window on one instance. X-Forwarded-For can be spoofed to
 * land in a fresh per-IP bucket each time, so this global ceiling is what actually bounds a
 * brute-force run (at the cost of briefly blocking new logins while someone hammers the gate).
 */
export const ACCESS_GLOBAL_MAX_ATTEMPTS = 300;
/** Upper bound on tracked IPs so a spray of spoofed addresses can't grow memory without limit. */
const MAX_TRACKED = 10_000;

type Bucket = { count: number; resetAt: number };

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

/** Creates an isolated limiter (one module-level instance is used by the route; tests make their own). */
export function createRateLimiter(max = ACCESS_MAX_ATTEMPTS, windowMs = ACCESS_WINDOW_MS) {
  const buckets = new Map<string, Bucket>();

  function prune(now: number) {
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
    // Still too many live buckets: drop the oldest-inserted ones.
    while (buckets.size >= MAX_TRACKED) {
      const first = buckets.keys().next().value;
      if (first === undefined) break;
      buckets.delete(first);
    }
  }

  /** Records one attempt for `key` and reports whether it is within the limit. */
  function hit(key: string, now: number = Date.now()): RateLimitResult {
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      if (buckets.size >= MAX_TRACKED) prune(now);
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    return { allowed: b.count <= max, retryAfterSeconds };
  }

  /** Clears the counter for `key` (called after a correct code). */
  function reset(key: string) {
    buckets.delete(key);
  }

  return { hit, reset };
}

/**
 * Best-effort client IP. Cloud Run's front end appends the real client address to
 * X-Forwarded-For, so the left-most entry is the original client (a client can prepend fake
 * entries to pick a fresh bucket, which is why the route also applies a global limiter).
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}
