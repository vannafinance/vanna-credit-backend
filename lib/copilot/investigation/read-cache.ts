/**
 * One shared layer under every read the model asks for (`executeRead`), whatever the question.
 *
 * - Single-flight: a read already running for the same wallet, tool and arguments is joined, never started again.
 *   A read that outlives a caller's time limit keeps running, so asking for it again (the model's retry, the next
 *   turn, the user's next message) waits for that same read instead of starting over from zero.
 * - Short reuse: a successful read is reused for `READ_REUSE_MS`. Failures are never kept.
 * - Fresh after a change: everything kept for a wallet is dropped when one of its transactions is submitted or
 *   confirmed, or the test faucet adds CASH (`forgetWallet`).
 *
 * Only what the model reads to understand a request goes through here. Amounts for a plan are still sized from live
 * reads (`mcp-facts.ts`), and every transaction is built and simulated fresh by the MCP.
 */

import type { ReadOutput } from "./catalog";

export const READ_REUSE_MS = 20_000;
/** Entries kept at most (oldest dropped first); one per wallet + tool + arguments. */
const MAX_ENTRIES = 500;

interface Entry {
  wallet: string;
  /** Set once the read succeeded; until then (or if it fails) only `pending` is shared. */
  at: number | null;
  pending: Promise<ReadOutput>;
}

const entries = new Map<string, Entry>();

export const readCacheDeps = {
  now: () => Date.now(),
  /** Off under the test runner, so tests that mock the MCP never see each other's results; a test turns it on. */
  enabled: () => process.env.NODE_ENV !== "test",
};

export function sharedRead(wallet: string, tool: string, args: Record<string, unknown>, run: () => Promise<ReadOutput>): Promise<ReadOutput> {
  if (!readCacheDeps.enabled()) return run();
  const key = `${wallet}|${tool}|${JSON.stringify(args)}`;
  const now = readCacheDeps.now();
  const hit = entries.get(key);
  if (hit && (hit.at === null || now - hit.at < READ_REUSE_MS)) return hit.pending;

  const entry: Entry = { wallet, at: null, pending: Promise.resolve({ ok: false, result: null }) };
  entry.pending = run().then(
    (out) => {
      // Kept only when it succeeded and nothing dropped it while it ran (a confirmation in between makes it stale).
      if (out.ok && entries.get(key) === entry) entry.at = readCacheDeps.now();
      else if (entries.get(key) === entry) entries.delete(key);
      return out;
    },
    (err) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw err;
    },
  );
  entries.set(key, entry);
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  return entry.pending;
}

/** Drop everything kept for this wallet: its balances, positions or the markets it touched just changed. */
export function forgetWallet(wallet: string): void {
  for (const [key, entry] of entries) if (entry.wallet === wallet) entries.delete(key);
}

export function clearReadCacheForTests(): void {
  entries.clear();
}
