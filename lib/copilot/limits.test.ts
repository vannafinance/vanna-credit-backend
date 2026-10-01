import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkAndConsume, checkSpend, limitsBackoff, limitsClock, recordSpend, recordTokens, setLimitStoreForTests } from "./limits";
import { MemoryRecordStore } from "./testing";
import type { CopilotUser } from "./types";

const user = (n: string): CopilotUser => ({ wallet: `W${n}`, subject: `subject-${n}`, expiresAt: Date.now() + 1e6 });

beforeEach(() => {
  setLimitStoreForTests(new MemoryRecordStore());
  limitsClock.now = () => Date.UTC(2026, 8, 30, 12, 0, 10);
});
afterEach(() => {
  setLimitStoreForTests(null);
  limitsClock.now = () => Date.now();
  vi.unstubAllEnvs();
});

describe("request rate", () => {
  it("allows the configured number per minute, then refuses with retry-after", async () => {
    vi.stubEnv("COPILOT_RATE_CHAT_PER_MIN", "3");
    const u = user("a");
    for (let i = 0; i < 3; i++) expect(await checkAndConsume(u, "chat")).toEqual({ ok: true });
    expect(await checkAndConsume(u, "chat")).toMatchObject({ ok: false, kind: "rate", retry_after_s: 50 });
  });

  it("resets in the next window and isolates users and kinds", async () => {
    vi.stubEnv("COPILOT_RATE_CHAT_PER_MIN", "1");
    vi.stubEnv("COPILOT_RATE_WRITE_PER_MIN", "1");
    const a = user("a");
    expect((await checkAndConsume(a, "chat")).ok).toBe(true);
    expect((await checkAndConsume(a, "chat")).ok).toBe(false);
    expect((await checkAndConsume(a, "write")).ok).toBe(true);
    expect((await checkAndConsume(user("b"), "chat")).ok).toBe(true);
    limitsClock.now = () => Date.UTC(2026, 8, 30, 12, 1, 1);
    expect((await checkAndConsume(a, "chat")).ok).toBe(true);
  });

  it("counts concurrent requests exactly (CAS): never lets more than the limit through", async () => {
    vi.stubEnv("COPILOT_RATE_CHAT_PER_MIN", "5");
    const u = user("c");
    const results = await Promise.all(Array.from({ length: 12 }, () => checkAndConsume(u, "chat")));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });

  it("has the documented defaults (20 chat, 6 write per minute)", async () => {
    const u = user("d");
    let chats = 0;
    for (let i = 0; i < 25; i++) if ((await checkAndConsume(u, "chat")).ok) chats++;
    expect(chats).toBe(20);
    let writes = 0;
    for (let i = 0; i < 10; i++) if ((await checkAndConsume(u, "write")).ok) writes++;
    expect(writes).toBe(6);
  });
});

describe("daily tokens", () => {
  it("blocks once the day's cap is reached, until UTC midnight", async () => {
    vi.stubEnv("COPILOT_DAILY_TOKEN_CAP", "1000");
    const u = user("t");
    expect((await checkAndConsume(u, "chat")).ok).toBe(true);
    await recordTokens(u, 1000);
    expect(await checkAndConsume(u, "chat")).toMatchObject({ ok: false, kind: "daily_tokens", retry_after_s: 12 * 3600 - 10 });
    limitsClock.now = () => Date.UTC(2026, 9, 1, 0, 0, 1);
    expect((await checkAndConsume(u, "chat")).ok).toBe(true);
  });
});

describe("spend caps", () => {
  it("refuses an action above the per-action cap", async () => {
    vi.stubEnv("COPILOT_MAX_ACTION_USD", "100");
    expect(await checkSpend(user("s"), 100.01)).toMatchObject({ ok: false, kind: "spend" });
    expect((await checkSpend(user("s"), 100)).ok).toBe(true);
  });

  it("refuses when the day's total would pass the daily cap", async () => {
    vi.stubEnv("COPILOT_MAX_ACTION_USD", "100");
    vi.stubEnv("COPILOT_MAX_DAILY_USD", "150");
    const u = user("s2");
    await recordSpend(u, 100);
    expect((await checkSpend(u, 50)).ok).toBe(true);
    expect(await checkSpend(u, 50.01)).toMatchObject({ ok: false, kind: "spend" });
  });

  it("fails closed on an unknown or negative USD value", async () => {
    expect((await checkSpend(user("s3"), NaN)).ok).toBe(false);
    expect((await checkSpend(user("s3"), -1)).ok).toBe(false);
  });
});

describe("store contention (api-014)", () => {
  it("34 simultaneous requests on one key never throw: each gets a clean allow or a 429-style denial", async () => {
    vi.stubEnv("COPILOT_RATE_CHAT_PER_MIN", "20");
    const u = user("burst");
    const results = await Promise.all(Array.from({ length: 34 }, () => checkAndConsume(u, "chat")));
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(20);
    for (const r of results) if (!r.ok) expect(r.retry_after_s).toBeGreaterThan(0);
  });

  it("retries with a jittered pause and succeeds when contention clears", async () => {
    const inner = new MemoryRecordStore<{ n: number }>();
    let failures = 3;
    setLimitStoreForTests({
      read: (id) => inner.read(id),
      write: async (id, expected, value) => (failures-- > 0 ? false : inner.write(id, expected, value)),
    });
    const pauses: number[] = [];
    const orig = { sleep: limitsBackoff.sleep, random: limitsBackoff.random };
    limitsBackoff.sleep = async (ms) => void pauses.push(ms);
    limitsBackoff.random = () => 0.5;
    try {
      expect(await checkAndConsume(user("j"), "chat")).toEqual({ ok: true });
    } finally {
      Object.assign(limitsBackoff, orig);
    }
    expect(pauses).toHaveLength(3);
    expect(pauses.every((p) => p > 0)).toBe(true);
    expect(pauses[2]).toBeGreaterThan(pauses[0]);
  });

  it("when every retry loses the race it fails closed with a clean retry-after, bounded attempts, never a throw", async () => {
    let writes = 0;
    const inner = new MemoryRecordStore<{ n: number }>();
    setLimitStoreForTests({ read: (id) => inner.read(id), write: async () => (writes++, false) });
    const orig = limitsBackoff.sleep;
    limitsBackoff.sleep = async () => undefined;
    try {
      const r = await checkAndConsume(user("always"), "chat");
      expect(r).toMatchObject({ ok: false, kind: "rate", retry_after_s: 1 });
    } finally {
      limitsBackoff.sleep = orig;
    }
    expect(writes).toBeGreaterThan(1);
    expect(writes).toBeLessThanOrEqual(30);
  });
});
