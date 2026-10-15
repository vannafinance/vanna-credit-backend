import { afterEach, describe, expect, it, vi } from "vitest";
import { ttlCache } from "./server-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("ttlCache", () => {
  afterEach(() => vi.useRealTimers());

  it("shares one read between concurrent and repeated callers inside the window", async () => {
    const cache = ttlCache<number>(1_000);
    const read = vi.fn(async () => 7);
    expect(await Promise.all([cache("k", read), cache("k", read)])).toEqual([7, 7]);
    expect(await cache("k", read)).toBe(7);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads again after the window, and immediately when fresh is asked", async () => {
    vi.useFakeTimers();
    const cache = ttlCache<number>(1_000);
    const read = vi.fn(async () => 1);
    await cache("k", read);
    await cache("k", read, { fresh: true });
    expect(read).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 1_001);
    await cache("k", read);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("never caches a failure", async () => {
    const cache = ttlCache<number>(60_000);
    const read = vi.fn().mockRejectedValueOnce(new Error("rpc down")).mockResolvedValue(2);
    await expect(cache("k", read)).rejects.toThrow("rpc down");
    expect(await cache("k", read)).toBe(2);
  });

  it("drops the oldest key beyond its size", async () => {
    const cache = ttlCache<string>(60_000, 2);
    const read = vi.fn(async () => "v");
    await cache("a", read);
    await cache("b", read);
    await cache("c", read);
    await cache("a", read);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("shares a slow pending read and gives its successful result a full TTL", async () => {
    vi.useFakeTimers();
    const cache = ttlCache<number>(1_000);
    const pending = deferred<number>();
    const read = vi.fn(() => pending.promise);
    const first = cache("k", read);
    vi.setSystemTime(Date.now() + 5_000);
    expect(cache("k", read)).toBe(first);
    pending.resolve(7);
    expect(await first).toBe(7);
    vi.setSystemTime(Date.now() + 999);
    expect(await cache("k", read)).toBe(7);
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    expect(await cache("k", async () => 8)).toBe(8);
  });

  it("a forced read bypasses pending work and an older success cannot replace it", async () => {
    const cache = ttlCache<number>(1_000);
    const old = deferred<number>();
    const fresh = deferred<number>();
    const first = cache("k", () => old.promise);
    const forced = cache("k", () => fresh.promise, { fresh: true });
    expect(forced).not.toBe(first);
    expect(cache("k", async () => 99)).toBe(forced);
    fresh.resolve(2);
    await forced;
    old.resolve(1);
    await first;
    expect(await cache("k", async () => 99)).toBe(2);
  });

  it("an older failure cannot evict a newer forced read", async () => {
    const cache = ttlCache<number>(1_000);
    const old = deferred<number>();
    const first = cache("k", () => old.promise);
    const failure = expect(first).rejects.toThrow("old read failed");
    expect(await cache("k", async () => 2, { fresh: true })).toBe(2);
    old.reject(new Error("old read failed"));
    await failure;
    expect(await cache("k", async () => 99)).toBe(2);
  });

  it("an evicted pending read cannot repopulate the cache on completion", async () => {
    const cache = ttlCache<number>(1_000, 1);
    const old = deferred<number>();
    const first = cache("a", () => old.promise);
    await cache("b", async () => 2);
    old.resolve(1);
    await first;
    expect(await cache("b", async () => 99)).toBe(2);
    expect(await cache("a", async () => 3)).toBe(3);
  });

  it("zero TTL still shares pending work but never reuses a settled result", async () => {
    const cache = ttlCache<number>(0);
    const first = cache("k", async () => 1);
    expect(cache("k", async () => 99)).toBe(first);
    await first;
    expect(await cache("k", async () => 2)).toBe(2);
  });

  it("rejects invalid TTLs and capacities", () => {
    for (const ttl of [-1, Infinity, NaN]) expect(() => ttlCache(ttl)).toThrow(RangeError);
    for (const cap of [0, -1, 1.5, Infinity, NaN]) expect(() => ttlCache(1_000, cap)).toThrow(RangeError);
  });
});
