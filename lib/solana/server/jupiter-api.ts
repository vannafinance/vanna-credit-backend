// Shared Jupiter API base URL + auth header for the server-side routes (quote, swap, price).
// Keyless requests to lite-api.jup.ag are capped at 0.5 req/s shared across every caller;
// setting JUPITER_API_KEY (https://portal.jup.ag) switches to the keyed api.jup.ag endpoint
// with its own quota. Falls back to keyless when unset.
const JUPITER_KEYLESS_BASE = "https://lite-api.jup.ag";
const JUPITER_KEYED_BASE = "https://api.jup.ag";

export function jupiterBaseUrl(): string {
  return process.env.JUPITER_API_KEY ? JUPITER_KEYED_BASE : JUPITER_KEYLESS_BASE;
}

export function jupiterHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const key = process.env.JUPITER_API_KEY;
  return key ? { ...extra, "x-api-key": key } : extra;
}
