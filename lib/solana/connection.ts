import { Connection, PublicKey } from "@solana/web3.js";
import { CLOCK_SYSVAR, SOLANA_RPC_URL, SOLANA_WS_URL } from "./config";

/**
 * Shared fork connection. `disableRetryOnRateLimit` stops web3.js multiplying a throttled
 * request into a retry cascade (React Query owns app-level retries), and `wsEndpoint` is
 * explicit because web3.js would otherwise infer it from the HTTP URL.
 */
let shared: Connection | null = null;

export function getConnection(): Connection {
  if (!shared) {
    shared = new Connection(SOLANA_RPC_URL, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      wsEndpoint: SOLANA_WS_URL,
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
