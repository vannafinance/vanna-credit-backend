import { singleFlight } from "../async";
import { Connection, PublicKey } from "@solana/web3.js";
import { CLOCK_SYSVAR, SOLANA_RPC_URL, SOLANA_WS_URL } from "./config";

/**
 * Shared fork connection. `disableRetryOnRateLimit` stops web3.js multiplying a throttled
 * request into a retry cascade (React Query owns app-level retries), and `wsEndpoint` is
 * explicit because web3.js would otherwise infer it from the HTTP URL.
 */
let shared: Connection | null = null;

/** One retry layer, bounded to 20 seconds total. Writes/cheatcodes are never replayed. */
const RETRY_DELAYS_MS = [300, 900];
const READ_METHOD = /^(get[A-Z]|isBlockhashValid$|simulateTransaction$)/;
const TRANSIENT = /EHOSTUNREACH|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ENOTFOUND|ECONNRESET|EPIPE|UND_ERR|fetch failed|terminated|timeout/i;

function errorText(error: unknown): string {
  const parts: string[] = [];
  let e: unknown = error;
  for (let i = 0; e && i < 4; i++) {
    const x = e as { message?: string; code?: string; cause?: unknown };
    parts.push(String(x.code ?? ""), String(x.message ?? e));
    e = x.cause;
  }
  return parts.join(" ");
}

export const forkFetch: typeof fetch = async (input, init) => {
  let retriable = false;
  try {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "null");
    const calls = Array.isArray(body) ? body : [body];
    retriable = calls.length > 0 && calls.every((call) => typeof call?.method === "string" && READ_METHOD.test(call.method));
  } catch { /* Unknown requests are never retried. */ }
  const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const deadline = AbortSignal.timeout(20_000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) });
      // Read the body inside the timeout/retry boundary. A timed-out clone must never
      // leak a consumed/aborted Response into web3.js's later response.text().
      const text = await response.text();
      const readable = () => new Response(text, {status:response.status,statusText:response.statusText,headers:response.headers});
      if (!retriable || attempt >= RETRY_DELAYS_MS.length) return readable();
      let transient = response.status === 429 || response.status >= 500;
      if (!transient && response.ok) {
        let body;
        try { body = JSON.parse(text); } catch { return readable(); }
        const replies = Array.isArray(body) ? body : [body];
        transient = replies.some((reply) => reply?.error && /Internal error|Too Many Requests/i.test(reply.error.message ?? ""));
      }
      if (!transient) return readable();
    } catch (error) {
      if (signal.aborted || !retriable || attempt >= RETRY_DELAYS_MS.length || !TRANSIENT.test(errorText(error))) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
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
const forkUnixTimestampReads = singleFlight<Connection, bigint>();
export function forkUnixTimestamp(connection: Connection = getConnection()): Promise<bigint> {
  return forkUnixTimestampReads(connection, () => readForkUnixTimestamp(connection));
}

async function readForkUnixTimestamp(connection: Connection = getConnection()): Promise<bigint> {
  const clock = await connection.getAccountInfo(CLOCK_SYSVAR, "confirmed");
  if (!clock) return BigInt(Math.floor(Date.now() / 1000));
  return clock.data.readBigInt64LE(32);
}

/** Read accounts in RPC-sized chunks. The transport owns retries; do not multiply them here. */
export async function getMultipleAccountsChunked(connection: Connection, keys: PublicKey[]) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed"));
  }
  return out;
}
