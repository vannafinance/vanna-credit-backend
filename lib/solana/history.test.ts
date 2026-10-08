import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
const rpc = vi.hoisted(() => ({ getSignaturesForAddress: vi.fn(), getTransaction: vi.fn() }));
vi.mock("./connection", async (original) => ({ ...await original<typeof import("./connection")>(), getConnection: () => rpc }));
const wallet = PublicKey.default;
let fetchEarnHistory: typeof import("./history").fetchEarnHistory;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  ({ fetchEarnHistory } = await import("./history"));
});
afterEach(() => vi.useRealTimers());

describe("history RPC work", () => {
  it("reads 200 finalized transactions only once across repeated refreshes", async () => {
    rpc.getSignaturesForAddress.mockResolvedValue(Array.from({ length: 200 }, (_, i) => ({ signature: `sig${i}`, confirmationStatus: "finalized", err: null, blockTime: 1 })));
    rpc.getTransaction.mockResolvedValue({ blockTime: 1, meta: { logMessages: [] } });
    await fetchEarnHistory(wallet); await fetchEarnHistory(wallet);
    expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(2);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(200);
  });
  it("deduplicates concurrent history scans", async () => {
    rpc.getSignaturesForAddress.mockResolvedValue([{ signature: "sig", confirmationStatus: "finalized", err: null }]);
    rpc.getTransaction.mockResolvedValue({ meta: { logMessages: [] } });
    await Promise.all([fetchEarnHistory(wallet), fetchEarnHistory(wallet)]);
    expect(rpc.getSignaturesForAddress).toHaveBeenCalledTimes(1);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(1);
  });
  it("never caches missing transactions and marks their cost basis incomplete", async () => {
    rpc.getSignaturesForAddress.mockResolvedValue([{ signature: "sig", confirmationStatus: "finalized", err: null }]);
    rpc.getTransaction.mockResolvedValueOnce(null).mockResolvedValue({ meta: { logMessages: [] } });
    expect((await fetchEarnHistory(wallet)).complete).toBe(false);
    expect((await fetchEarnHistory(wallet)).complete).toBe(true);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(2);
  });
  it("re-reads transactions not finalized yet", async () => {
    rpc.getSignaturesForAddress.mockResolvedValue([{ signature: "sig", confirmationStatus: "confirmed", err: null }]);
    rpc.getTransaction.mockResolvedValue({ meta: { logMessages: [] } });
    await fetchEarnHistory(wallet); await fetchEarnHistory(wallet);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(2);
  });
  it("expires finalized cache entries to tolerate fork resets", async () => {
    vi.useFakeTimers();
    rpc.getSignaturesForAddress.mockResolvedValue([{ signature: "sig", confirmationStatus: "finalized", err: null }]);
    rpc.getTransaction.mockResolvedValue({ meta: { logMessages: [] } });
    await fetchEarnHistory(wallet);
    vi.setSystemTime(Date.now() + 300_001);
    await fetchEarnHistory(wallet);
    expect(rpc.getTransaction).toHaveBeenCalledTimes(2);
  });
});
