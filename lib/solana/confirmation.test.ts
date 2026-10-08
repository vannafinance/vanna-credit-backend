import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import { ConfirmationPendingError, confirmSignatureHttp } from "./confirmation";

const status = (confirmationStatus: string, err: unknown = null) => ({ value: [{ confirmationStatus, err }] });
const connection = () => ({ getSignatureStatuses: vi.fn(), getBlockHeight: vi.fn().mockResolvedValue(10) });
const asConnection = (c: ReturnType<typeof connection>) => c as unknown as Connection;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("HTTP transaction confirmation", () => {
  it("uses recent status for a new submission and returns without a block-height call", async () => {
    const c = connection(); c.getSignatureStatuses.mockResolvedValue(status("confirmed"));
    await confirmSignatureHttp(asConnection(c), "sig", 100);
    expect(c.getSignatureStatuses).toHaveBeenCalledWith(["sig"], { searchTransactionHistory: false });
    expect(c.getBlockHeight).not.toHaveBeenCalled();
  });
  it("fails immediately on an on-chain error", async () => {
    const c = connection(); c.getSignatureStatuses.mockResolvedValue(status("processed", { InstructionError: [0, "failure"] }));
    await expect(confirmSignatureHttp(asConnection(c), "sig")).rejects.toThrow("Transaction failed:");
  });
  it("recovers from a transient status failure", async () => {
    const c = connection(); c.getSignatureStatuses.mockRejectedValueOnce(new Error("429")).mockResolvedValue(status("confirmed"));
    const result = confirmSignatureHttp(asConnection(c), "sig", 100);
    await vi.advanceTimersByTimeAsync(700);
    await result;
    expect(c.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });
  it("does not call a processed transaction expired", async () => {
    const c = connection(); c.getSignatureStatuses.mockResolvedValueOnce(status("processed")).mockResolvedValue(status("finalized"));
    c.getBlockHeight.mockResolvedValue(999);
    const result = confirmSignatureHttp(asConnection(c), "sig", 100);
    await vi.advanceTimersByTimeAsync(700); await result;
    expect(c.getBlockHeight).not.toHaveBeenCalled();
  });
  it("rechecks status when height expires, avoiding a landing race", async () => {
    const c = connection(); c.getSignatureStatuses.mockResolvedValueOnce({ value: [null] }).mockResolvedValue(status("confirmed"));
    c.getBlockHeight.mockResolvedValue(101);
    await confirmSignatureHttp(asConnection(c), "sig", 100);
    expect(c.getSignatureStatuses).toHaveBeenLastCalledWith(["sig"], { searchTransactionHistory: true });
  });
  it("reports absent expired transactions only after the second read", async () => {
    const c = connection(); c.getSignatureStatuses.mockResolvedValue({ value: [null] }); c.getBlockHeight.mockResolvedValue(101);
    await expect(confirmSignatureHttp(asConnection(c), "sig", 100)).rejects.toThrow("Transaction expired:");
    expect(c.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });
  it("bounds a stalled RPC and preserves the signature as unknown, not failed", async () => {
    const c = connection(); c.getSignatureStatuses.mockImplementation(() => new Promise(() => {}));
    const result = confirmSignatureHttp(asConnection(c), "recover-this-signature", 100, 1_000);
    const check = expect(result).rejects.toMatchObject({ name: "ConfirmationPendingError", signature: "recover-this-signature" });
    await vi.advanceTimersByTimeAsync(1_000); await check;
  });
  it("bounds a stalled height check too", async () => {
    const c = connection(); c.getSignatureStatuses.mockResolvedValue({ value: [null] }); c.getBlockHeight.mockImplementation(() => new Promise(() => {}));
    const result = confirmSignatureHttp(asConnection(c), "sig", 100, 1_000);
    const check = expect(result).rejects.toBeInstanceOf(ConfirmationPendingError);
    await vi.advanceTimersByTimeAsync(1_000); await check;
  });
});
