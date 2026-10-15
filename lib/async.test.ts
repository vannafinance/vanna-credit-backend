import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout, singleFlight, withTimeout } from "./async";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded async reads", () => {
  it("shares concurrent work but re-reads after settlement", async () => {
    const read = singleFlight<string, number>();
    const run = vi.fn().mockResolvedValue(42);
    const first = read("wallet-a", run);
    expect(read("wallet-a", run)).toBe(first);
    expect(await first).toBe(42);
    await read("wallet-a", run);
    await read("wallet-b", run);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("evicts failed reads so a recovered RPC can be retried", async () => {
    const read = singleFlight<string, number>();
    await expect(read("a", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(await read("a", async () => 1)).toBe(1);
  });
  it("isolates fresh request scopes while sharing sibling reads within one scope", async () => {
    const read = singleFlight<string, number>();
    let finishOld!: (value: number) => void;
    const old = read("wallet", () => new Promise<number>((resolve) => { finishOld = resolve; }));
    await Promise.resolve();
    const scope = {};
    const run = vi.fn(async () => 2);
    const fresh = read("wallet", run, scope);
    expect(fresh).not.toBe(old);
    expect(read("wallet", run, scope)).toBe(fresh);
    const other = read("wallet", async () => 3, {});
    expect(other).not.toBe(fresh);
    expect(await fresh).toBe(2);
    expect(await other).toBe(3);
    finishOld(1);
    expect(await old).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("keeps fresh request scopes after settlement usable and retries their failures", async () => {
    const read = singleFlight<string, number>();
    const scope = {};
    await expect(read("wallet", async () => { throw new Error("offline"); }, scope)).rejects.toThrow("offline");
    expect(await read("wallet", async () => 2, scope)).toBe(2);
    expect(await read("wallet", async () => 3, scope)).toBe(3);
  });
  it("settles a hung operation at its deadline", async () => {
    vi.useFakeTimers();
    const promise = withTimeout(new Promise(() => {}), 100, "deadline");
    const check = expect(promise).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves caller cancellation in the bounded fetch", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_input, init) => {
      expect(init.signal.aborted).toBe(true);
      throw init.signal.reason;
    });
    vi.stubGlobal("fetch", fetch);
    controller.abort(new Error("cancelled"));
    await expect(fetchWithTimeout("https://example.test", { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
