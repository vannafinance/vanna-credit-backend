import { Connection, PublicKey } from "@solana/web3.js";
import { CLOCK_SYSVAR, SOLANA_RPC_URL, SOLANA_WS_URL } from "./config";

/**
 * Shared fork connection. `disableRetryOnRateLimit` stops web3.js multiplying a throttled
 * request into a retry cascade (React Query owns app-level retries), and `wsEndpoint` is
 * explicit because web3.js would otherwise infer it from the HTTP URL.
 */
let shared: Connection | null = null;

/**
 * The hosted fork answers a read of an account it doesn't hold by asking its upstream mainnet RPC,
 * and that upstream rate-limits bursts: the fork then returns HTTP 429/5xx or a JSON-RPC
 * `"Internal error"` for a request that is otherwise fine. This fetch retries those (reads and
 * simulations only — a `sendTransaction` is never re-sent) with a short backoff, so one throttled
 * upstream call doesn't fail a whole page load.
 */
const RETRY_DELAYS_MS = [250, 600, 1200, 2400];

export const forkFetch: typeof fetch = async (input, init) => {
  const body = typeof init?.body === "string" ? init.body : "";
  const retriable = !body.includes('"sendTransaction"');
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(input, init);
    if (!retriable || attempt >= RETRY_DELAYS_MS.length) return response;
    let transient = response.status === 429 || response.status >= 500;
    if (!transient && response.ok) {
      const text = await response.clone().text();
      transient = /"Internal error"|Too Many Requests/i.test(text);
    }
    if (!transient) return response;
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
};

export function getConnection(): Connection {
  if (!shared) {
    shared = new Connection(SOLANA_RPC_URL, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      wsEndpoint: SOLANA_WS_URL,
      fetch: forkFetch,
    });
  }
  return shared;
}

/**
 * The fork's own Clock sysvar `unix_timestamp` (bytes 32..40). A fork's clock can drift from
 * wall time and the program checks price age / accrues interest against THIS clock, so every
 * client-side projection uses it too — never Date.now().
 */
export async function forkUnixTimestamp(connection: Connection = getConnection()): Promise<bigint> {
  const clock = await connection.getAccountInfo(CLOCK_SYSVAR, "confirmed");
  if (!clock) return BigInt(Math.floor(Date.now() / 1000));
  return clock.data.readBigInt64LE(32);
}

/**
 * The hosted fork answers a read of an account it doesn't hold by asking its upstream mainnet RPC,
 * and that upstream rate-limits bursts — the fork then returns a bare "Internal error" (or 429). The
 * request itself is fine, so retry it a few times with backoff before failing.
 */
const TRANSIENT_RPC_ERROR = /Internal error|429|Too Many Requests|fetch failed|ECONNRESET|timed out/i;

async function withRetry<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= attempts || !TRANSIENT_RPC_ERROR.test(message)) throw error;
      await new Promise((r) => setTimeout(r, 300 * 2 ** (attempt - 1)));
    }
  }
}

/** Reads many accounts, chunked at the RPC's 100-key limit, retrying the fork's transient errors. */
export async function getMultipleAccountsChunked(connection: Connection, keys: PublicKey[]) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    out.push(...(await withRetry(() => connection.getMultipleAccountsInfo(chunk, "confirmed"))));
  }
  return out;
}
