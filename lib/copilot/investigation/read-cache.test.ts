import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReadOutput } from "./catalog";
import { READ_REUSE_MS, clearReadCacheForTests, forgetWallet, readCacheDeps, sharedRead } from "./read-cache";

let t = 1_000_000;
beforeEach(() => {
  clearReadCacheForTests();
  readCacheDeps.enabled = () => true;
  readCacheDeps.now = () => t;
});
afterEach(() => {
  clearReadCacheForTests();
  readCacheDeps.enabled = () => process.env.NODE_ENV !== "test";
  readCacheDeps.now = () => Date.now();
});

function deferred() {
  let resolve!: (o: ReadOutput) => void;
  const promise = new Promise<ReadOutput>((r) => (resolve = r));
  return { promise, resolve };
}

describe("shared read layer", () => {
  it("joins a read that is still running instead of starting it again (a retry after a timeout)", async () => {
    const d = deferred();
    let runs = 0;
    const run = () => (runs++, d.promise);
    const first = sharedRead("w1", "get_vaults", {}, run);
    const again = sharedRead("w1", "get_vaults", {}, run);
    expect(runs).toBe(1);
    d.resolve({ ok: true, result: { vaults: [] } });
    expect(await first).toEqual(await again);
  });

  it("reuses a success for a short while, then reads again; never across wallets or arguments", async () => {
    let runs = 0;
    const run = async (): Promise<ReadOutput> => ({ ok: true, result: { n: ++runs } });
    await sharedRead("w1", "get_prices", { assets: ["SOL"] }, run);
    expect((await sharedRead("w1", "get_prices", { assets: ["SOL"] }, run)).result).toEqual({ n: 1 });
    expect((await sharedRead("w1", "get_prices", { assets: ["USDC"] }, run)).result).toEqual({ n: 2 });
    expect((await sharedRead("w2", "get_prices", { assets: ["SOL"] }, run)).result).toEqual({ n: 3 });
    t += READ_REUSE_MS + 1;
    expect((await sharedRead("w1", "get_prices", { assets: ["SOL"] }, run)).result).toEqual({ n: 4 });
  });

  it("never keeps a failure", async () => {
    let runs = 0;
    const fails = async (): Promise<ReadOutput> => (runs++, { ok: false, result: { error: "unavailable" } });
    await sharedRead("w1", "get_history", {}, fails);
    await sharedRead("w1", "get_history", {}, fails);
    expect(runs).toBe(2);
    const throws = () => (runs++, Promise.reject(new Error("down")));
    await expect(sharedRead("w1", "get_history", {}, throws)).rejects.toThrow("down");
    await expect(sharedRead("w1", "get_history", {}, throws)).rejects.toThrow("down");
    expect(runs).toBe(4);
  });

  it("a confirmed transaction drops the wallet's reads, including one still running", async () => {
    let runs = 0;
    const run = async (): Promise<ReadOutput> => ({ ok: true, result: { n: ++runs } });
    await sharedRead("w1", "get_positions", {}, run);
    await sharedRead("w2", "get_positions", {}, run);
    forgetWallet("w1");
    expect((await sharedRead("w1", "get_positions", {}, run)).result).toEqual({ n: 3 });
    expect((await sharedRead("w2", "get_positions", {}, run)).result).toEqual({ n: 2 });

    const d = deferred();
    const pending = sharedRead("w1", "get_wallet_balances", {}, () => d.promise);
    forgetWallet("w1");
    d.resolve({ ok: true, result: { stale: true } });
    await pending;
    expect((await sharedRead("w1", "get_wallet_balances", {}, run)).result).toEqual({ n: 4 });
  });
});
