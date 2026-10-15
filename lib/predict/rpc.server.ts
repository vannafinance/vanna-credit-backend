/**
 * RPC endpoints for Predict (server only).
 *
 * - Mainnet (read only): market discovery (getProgramAccounts), mint metadata, vault balances and
 *   maker-fill history for prices. `MAINNET_RPC_URL` (e.g. Alchemy) first; public endpoints as a
 *   fallback, since provider plans often refuse the program scan with a compute-units 429.
 * - Fork: every transaction and balance read goes through the app's own fork connection
 *   (`lib/solana/connection.ts`, FORK_RPC_URL on the server), cheatcodes through
 *   `lib/solana/server/cheatcodes.ts`.
 */
import { Connection } from "@solana/web3.js";

const PUBLIC_MAINNET_RPC_URL = "https://api.mainnet-beta.solana.com";
/** Serves getTransaction / getSignaturesForAddress generously (refuses getProgramAccounts). */
const PUBLIC_HISTORY_RPC_URL = "https://solana-rpc.publicnode.com";

const g = globalThis as unknown as { __predictRpc?: Map<string, Connection> };
const pool = (g.__predictRpc ??= new Map());

function conn(url: string): Connection {
  let c = pool.get(url);
  if (!c) {
    c = new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: timedFetch });
    pool.set(url, c);
  }
  return c;
}

/**
 * Every mainnet request is bounded: a stalled public endpoint would otherwise hold the call (and the
 * shared single flights waiting on it) for the runtime's ~5 min default, and withFallback would never
 * reach the next endpoint.
 */
const MAINNET_TIMEOUT_MS = 10_000;
const timedFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(MAINNET_TIMEOUT_MS);
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
};

const unique = (urls: (string | undefined)[]) => [...new Set(urls.filter((u): u is string => Boolean(u)))];

/** Mainnet endpoints in preference order for account reads. */
export const mainnetUrls = () => unique([process.env.PREDICT_MAINNET_RPC_URL, process.env.MAINNET_RPC_URL, PUBLIC_MAINNET_RPC_URL]);
/** Mainnet endpoints in preference order for signature / transaction history. */
export const historyUrls = () => unique([process.env.PREDICT_MAINNET_HISTORY_RPC_URL, PUBLIC_HISTORY_RPC_URL, process.env.MAINNET_RPC_URL]);
/** The program scan: public mainnet serves it; most provider plans throttle it. */
export const scanUrls = () => unique([process.env.PREDICT_MAINNET_SCAN_RPC_URL, PUBLIC_MAINNET_RPC_URL, process.env.MAINNET_RPC_URL]);

/** Runs a read on each endpoint in turn until one succeeds; rethrows the last error. */
export async function withFallback<T>(urls: string[], read: (c: Connection) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const url of urls) {
    try {
      return await read(conn(url));
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error("All mainnet RPC endpoints failed");
}

export const withMainnet = <T>(read: (c: Connection) => Promise<T>) => withFallback(mainnetUrls(), read);
export const withMainnetHistory = <T>(read: (c: Connection) => Promise<T>) => withFallback(historyUrls(), read);
