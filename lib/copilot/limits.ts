/**
 * Per-user spending limits: request rate, daily LLM tokens, and USD value per action / per day.
 *
 * Counters live in the durable limit store and move by compare-and-set, so the ceilings hold across
 * instances and restarts instead of resetting per process. The store is fail-closed: if it is
 * unreachable the error propagates and the caller must refuse the request.
 */

import { createHash } from "node:crypto";

import { copilotConfig } from "./config";
import { limitStore, type RecordStore } from "./store";
import type { CopilotUser } from "./types";

export type LimitKind = "rate" | "daily_tokens" | "spend";
export type LimitDenied = { ok: false; kind: LimitKind; retry_after_s: number; message: string };
export type LimitResult = { ok: true } | LimitDenied;

interface Counter {
  n: number;
}

/** Test seam. */
export const limitsClock = { now: () => Date.now() };
let storeOverride: RecordStore<Counter> | null = null;
/** Test seam: inject a store (the default resolves lazily so importing this module never touches disk). */
export function setLimitStoreForTests(store: RecordStore<Counter> | null): void {
  storeOverride = store;
}
const store = () => storeOverride ?? limitStore<Counter>();

const MAX_CAS_ATTEMPTS = 24;
/** Upper bound of the randomised pause between compare-and-set retries (grows with the attempt, then caps). */
const MAX_BACKOFF_MS = 60;
/** What a caller is told to wait when the counter stayed contended after every retry. */
export const CONTENTION_RETRY_AFTER_S = 1;

/** The counter could not be updated after bounded retries. The caller must refuse (fail closed) with a 429, never a 500. */
export class LimitContentionError extends Error {
  readonly retry_after_s = CONTENTION_RETRY_AFTER_S;
  constructor() {
    super("limit_store_contention");
    this.name = "LimitContentionError";
  }
}

/** Test seam: the pause between retries. */
export const limitsBackoff = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  random: () => Math.random(),
};
const docId = (key: string) => createHash("sha256").update(key).digest("hex");

async function read(key: string): Promise<number> {
  return (await store().read(docId(key)))?.value.n ?? 0;
}

/**
 * Atomically adds `delta` to a counter, refusing when it would pass `limit` (when given).
 * Returns the new total, or null when the limit would be exceeded (nothing written).
 */
async function add(key: string, delta: number, limit?: number): Promise<number | null> {
  const s = store();
  const id = docId(key);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const current = await s.read(id);
    const next = (current?.value.n ?? 0) + delta;
    if (limit !== undefined && next > limit) return null;
    if (await s.write(id, current?.version ?? null, { n: next })) return next;
    // Lost the race: wait a random, growing moment so the contenders stop colliding in lockstep.
    await limitsBackoff.sleep(Math.floor(limitsBackoff.random() * Math.min(MAX_BACKOFF_MS, 2 ** (attempt + 1))));
  }
  // Sustained contention: refuse rather than allow an uncounted request.
  throw new LimitContentionError();
}

const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const secondsToUtcMidnight = (t: number) => {
  const d = new Date(t);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - t) / 1000));
};

/**
 * Fixed-window counter for arbitrary keys (used by SIWS nonce issuance too).
 * `retry_after_s` is the time to the end of the current window.
 */
export async function consumeWindow(key: string, limit: number, windowMs: number, cost = 1): Promise<LimitResult> {
  const now = limitsClock.now();
  const bucket = Math.floor(now / windowMs);
  let total: number | null;
  try {
    total = await add(`win:${key}:${bucket}`, cost, limit);
  } catch (e) {
    if (e instanceof LimitContentionError) {
      return { ok: false, kind: "rate", retry_after_s: e.retry_after_s, message: `The service is busy. Try again in ${e.retry_after_s}s.` };
    }
    throw e;
  }
  if (total !== null) return { ok: true };
  const retry = Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000));
  return { ok: false, kind: "rate", retry_after_s: retry, message: `Too many requests. Try again in ${retry}s.` };
}

export async function checkAndConsume(
  user: CopilotUser,
  kind: "chat" | "write" | "research",
  cost = 1,
): Promise<LimitResult> {
  if (!Number.isFinite(cost) || cost <= 0) cost = 1;

  const used = await read(`tokens:${user.subject}:${utcDay(limitsClock.now())}`);
  if (used >= copilotConfig.dailyTokenCap) {
    return {
      ok: false,
      kind: "daily_tokens",
      retry_after_s: secondsToUtcMidnight(limitsClock.now()),
      message: "This wallet has used today's Copilot token budget. Nothing will be executed; try again tomorrow.",
    };
  }

  const perMin = kind === "write" ? copilotConfig.rateWritePerMin : copilotConfig.rateChatPerMin;
  const windowed = await consumeWindow(`${kind}:${user.subject}`, perMin, 60_000, cost);
  if (windowed.ok) return windowed;
  return {
    ...windowed,
    message:
      kind === "write"
        ? `Too many transaction builds (limit ${perMin} per minute). Try again in ${windowed.retry_after_s}s.`
        : `Too many requests (limit ${perMin} per minute). Try again in ${windowed.retry_after_s}s.`,
  };
}

export async function recordTokens(user: CopilotUser, n: number): Promise<void> {
  if (!Number.isFinite(n) || n <= 0) return;
  await add(`tokens:${user.subject}:${utcDay(limitsClock.now())}`, Math.ceil(n));
}

export async function tokensUsedToday(user: CopilotUser): Promise<number> {
  return read(`tokens:${user.subject}:${utcDay(limitsClock.now())}`);
}

/** Checks one action's USD value against the per-action and per-day caps; does not record it. */
export async function checkSpend(user: CopilotUser, usd: number): Promise<LimitResult> {
  if (!Number.isFinite(usd) || usd < 0) {
    return { ok: false, kind: "spend", retry_after_s: 0, message: "The action's USD value could not be determined, so it is not allowed." };
  }
  const perAction = copilotConfig.maxActionUsd;
  if (usd > perAction) {
    return {
      ok: false,
      kind: "spend",
      retry_after_s: 0,
      message: `This action is worth about $${usd.toFixed(2)}, above the per-action limit of $${perAction.toLocaleString("en-US")}. Try a smaller amount.`,
    };
  }
  const spent = (await read(`spend:${user.subject}:${utcDay(limitsClock.now())}`)) / 1e6;
  const daily = copilotConfig.maxDailyUsd;
  if (spent + usd > daily) {
    return {
      ok: false,
      kind: "spend",
      retry_after_s: secondsToUtcMidnight(limitsClock.now()),
      message: `This would bring today's total to about $${(spent + usd).toFixed(2)}, above the daily limit of $${daily.toLocaleString("en-US")}.`,
    };
  }
  return { ok: true };
}

/** Counts USD value toward today's cap (micro-dollars, so the counter stays an integer). */
export async function recordSpend(user: CopilotUser, usd: number): Promise<void> {
  if (!Number.isFinite(usd) || usd <= 0) return;
  await add(`spend:${user.subject}:${utcDay(limitsClock.now())}`, Math.round(usd * 1e6));
}
