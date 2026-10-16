import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { RawMarket } from "./types";

const rpc = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./rpc.server", () => ({ withMainnet: (read: (connection: { getMultipleAccountsInfo: typeof rpc.read }) => unknown) => read({ getMultipleAccountsInfo: rpc.read }), scanUrls: vi.fn(), withFallback: vi.fn() }));
vi.mock("./prices.server", () => ({ sweepUnpricedMarkets: vi.fn() }));
vi.mock("@/lib/solana/connection", () => ({ getConnection: vi.fn() }));

const ids = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
let refresh: typeof import("./catalog.server").refreshOpenInterest;
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers();
  const markets: RawMarket[] = ids.map((id) => ({ id, yesMint: id, noMint: id, vault: id, resolutionKind: 0, startMs: null, endMs: null }));
  vi.stubGlobal("__predictCatalog", {
    all: new Map(markets.map((market) => [market.id, market])), openInterest: new Map(),
    listed: [], groups: new Map(), groupOf: new Map(), marketByMint: new Map(), mintMeta: new Map(), jsonMeta: new Map(),
    loadedAt: Date.now(), loading: null, jsonQueue: new Set(), jsonWorker: null,
  });
  rpc.read.mockImplementation(async (keys: unknown[]) => keys.map(() => ({ data: Buffer.alloc(72) })));
  ({ refreshOpenInterest: refresh } = await import("./catalog.server"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shares concurrent and repeated event reads even when ID order differs", async () => {
  await Promise.all([refresh(ids), refresh([...ids].reverse())]);
  await refresh([...ids, ids[0]]);
  expect(rpc.read).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 15_001);
  await refresh(ids);
  expect(rpc.read).toHaveBeenCalledTimes(2);
});

it("does not cache failures or read unknown markets", async () => {
  await refresh(["unknown"]);
  expect(rpc.read).not.toHaveBeenCalled();
  rpc.read.mockRejectedValueOnce(new Error("upstream unavailable"));
  await expect(refresh(ids)).rejects.toThrow("upstream unavailable");
  await refresh(ids);
  expect(rpc.read).toHaveBeenCalledTimes(2);
});
