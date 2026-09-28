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

/** Reads many accounts, chunked at the RPC's 100-key limit. */
export async function getMultipleAccountsChunked(connection: Connection, keys: PublicKey[]) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")));
  }
  return out;
}
