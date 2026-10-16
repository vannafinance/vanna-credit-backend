import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MarketInfo, PredictEvent } from "./types";

const reads = vi.hoisted(() => ({ info: vi.fn(), quotes: vi.fn(), scan: vi.fn() }));
vi.mock("./catalog.server", () => ({ getMarketInfo: reads.info, listMarketInfos: vi.fn(), openInterestOf: () => 0, refreshOpenInterest: vi.fn() }));
vi.mock("./pool.server", () => ({ readPoolStates: vi.fn() }));
vi.mock("./prices.server", () => ({ refreshQuotes: reads.quotes, scanMarketMints: reads.scan, getMarketVolume: () => 0, getMarketPrices: () => ({ yesAsk: 0.5, noAsk: 0.5, yesBid: 0.49, noBid: 0.49, source: "quote", lastTradeAt: null }) }));

let get: typeof import("./events.server").getEvent;
let event: PredictEvent;
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers();
  const info: MarketInfo = { id: "market", yesMint: "yes", noMint: "no", vault: "vault", resolutionKind: 0, startMs: null, endMs: null, name: "Test", symbol: "TEST", question: "Test?", description: null, image: null, category: "other", league: null, groupId: null };
  event = { id: "event", type: "binary", cat: "other", tag: "", title: "Test?", ic: "", last: "", ends: "", opened: "", vol: 0, v24: 0, oi: 0, source: "World.xyz", rules: "", image: null, league: null, groupedBy: "single", startMs: null, endMs: null,
    outs: [{ k: "market", name: "Test", y: 50, n: 50, vol: 0, pool: { yes: 0, no: 0 }, uid: "event/market", marketId: "market", yesMint: "yes", noMint: "no", symbol: "TEST", image: null, yBid: 49, nBid: 49, oi: 0, lastTradeAt: null, priceSource: "quote", tradable: true, poolDetail: { allowlisted: false, exists: false, yesDangling: 0, noDangling: 0, invested: 0, pendingMerge: 0 } }] };
  vi.stubGlobal("__predictEvents", { at: Date.now(), events: [event], byMarket: new Map([["market", "event"]]), pools: new Map(), pending: null });
  reads.info.mockResolvedValue(info);
  reads.quotes.mockResolvedValue(undefined);
  reads.scan.mockResolvedValue(undefined);
  ({ getEvent: get } = await import("./events.server"));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("priced events do not wait for an unrelated global backfill but still refresh their quotes", async () => {
  const result = await get("event", { pricesReady: new Promise(() => {}) });
  expect(result?.outs[0].y).toBe(50);
  expect(reads.quotes).toHaveBeenCalledTimes(1);
  expect(reads.scan).not.toHaveBeenCalled();
});

it("unpriced events keep waiting for the bounded global price backfill", async () => {
  event.outs[0].y = null;
  let release!: () => void;
  let settled = false;
  const result = get("event", { pricesReady: new Promise<void>((resolve) => { release = resolve; }) }).then((value) => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false);
  expect(reads.scan).toHaveBeenCalledTimes(1);
  release();
  expect((await result)?.outs[0].y).toBe(50);
});
