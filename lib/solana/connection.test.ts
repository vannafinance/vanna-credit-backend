import { afterEach, describe, expect, it, vi } from "vitest";
import { forkFetch, getMultipleAccountsChunked } from "./connection";
import { PublicKey, type Connection } from "@solana/web3.js";
const request = (method: string) => ({ method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("fork RPC transport", () => {
  it.each(["sendTransaction", "surfnet_setAccount", "requestAirdrop", "surfnet_resetAccount"])("never automatically retries %s", async (method) => {
    const fetch = vi.fn().mockResolvedValue(new Response("busy", { status: 503 })); vi.stubGlobal("fetch", fetch);
    expect((await forkFetch("https://rpc.test", request(method))).status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("never replays a write after an ambiguous network failure", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("fetch failed ECONNRESET")); vi.stubGlobal("fetch", fetch);
    await expect(forkFetch("https://rpc.test", request("sendTransaction"))).rejects.toThrow("ECONNRESET");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retries a transient read at most twice", async () => {
    vi.useFakeTimers(); const fetch = vi.fn().mockImplementation(async () => new Response("busy", { status: 429 })); vi.stubGlobal("fetch", fetch);
    const result = forkFetch("https://rpc.test", request("getAccountInfo"));
    await vi.advanceTimersByTimeAsync(1_200);
    expect((await result).status).toBe(429); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("does not mistake text inside account data for an RPC error", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ result: "Internal error" })); vi.stubGlobal("fetch", fetch);
    await forkFetch("https://rpc.test", request("getAccountInfo")); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("returns a readable response after inspecting the RPC body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({result:{value:42}})));
    const response = await forkFetch("https://rpc.test", request("getAccountInfo"));
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toEqual({result:{value:42}});
  });
  it("retries a read when the response body fails after headers arrive", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce({status:200,ok:true,text:()=>Promise.reject(new Error("terminated"))})
      .mockResolvedValueOnce(Response.json({result:42}));
    vi.stubGlobal("fetch", fetch);
    const pending = forkFetch("https://rpc.test", request("getAccountInfo"));
    await vi.advanceTimersByTimeAsync(300);
    expect(await (await pending).json()).toEqual({result:42});
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("honors an already aborted caller without making a request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController(); controller.abort();
    await expect(forkFetch("https://rpc.test", { ...request("getAccountInfo"), signal: controller.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("chunks at 100 without an additional retry layer", async () => {
    const read = vi.fn().mockResolvedValueOnce(Array(100).fill(null)).mockResolvedValueOnce([null]);
    expect(await getMultipleAccountsChunked({ getMultipleAccountsInfo: read } as unknown as Connection, Array(101).fill(PublicKey.default))).toHaveLength(101);
    expect(read.mock.calls.map(([keys]) => keys.length)).toEqual([100, 1]);
    read.mockRejectedValue(new Error("Internal error"));
    await expect(getMultipleAccountsChunked({ getMultipleAccountsInfo: read } as unknown as Connection, [PublicKey.default])).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(3);
  });
});
