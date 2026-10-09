import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, SystemProgram, type VersionedTransaction } from "@solana/web3.js";
const rpc = vi.hoisted(() => ({ getLatestBlockhash: vi.fn(), simulateTransaction: vi.fn() }));
vi.mock("./connection", () => ({ getConnection: () => rpc }));
vi.mock("./fork-heal", () => ({ healStaleDexPools: vi.fn().mockResolvedValue(0) }));
vi.mock("./broadcast", () => ({ broadcastSignedTransaction: vi.fn().mockResolvedValue("sig") }));
import { sendInstructions, prepareTransactionTables } from "./tx";
import { broadcastSignedTransaction } from "./broadcast";
const key = Keypair.generate();
beforeEach(() => {
  vi.clearAllMocks();
  rpc.getLatestBlockhash.mockReset();
  rpc.getLatestBlockhash.mockResolvedValueOnce({ blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 100 })
    .mockResolvedValue({ blockhash: key.publicKey.toBase58(), lastValidBlockHeight: 200 });
});
describe("transaction lifetime", () => {
  it("does not request wallet approval or RPC setup for transactions that already fit", async () => {
    const sign = vi.fn();
    expect(await prepareTransactionTables([], {signer:{publicKey:key.publicKey,signTransaction:sign,signAllTransactions:sign},label:'Preview'})).toEqual([]);
    expect(sign).not.toHaveBeenCalled();
    expect(rpc.getLatestBlockhash).not.toHaveBeenCalled();
  });
  it("refreshes the blockhash after simulation and confirms against the new lifetime", async () => {
    rpc.simulateTransaction.mockResolvedValue({ value: { err: null } });
    const sign = vi.fn(async (tx: VersionedTransaction) => {
      expect(tx.message.recentBlockhash).toBe(key.publicKey.toBase58()); return tx;
    });
    await sendInstructions([], { signer: { publicKey: key.publicKey, signTransaction: sign as never, signAllTransactions: vi.fn() }, label: "test" });
    expect(rpc.simulateTransaction.mock.calls[0][1]).toMatchObject({ replaceRecentBlockhash: true, sigVerify: false });
    expect(rpc.getLatestBlockhash).toHaveBeenCalledTimes(2);
    expect(vi.mocked(broadcastSignedTransaction).mock.calls[0][2]).toBe(200);
  });
  it("never opens the wallet or sends a transaction after simulation fails", async () => {
    rpc.simulateTransaction.mockResolvedValue({ value: { err: "invalid instruction", logs: [] } });
    const sign = vi.fn();
    await expect(sendInstructions([], { signer: { publicKey: key.publicKey, signTransaction: sign, signAllTransactions: vi.fn() }, label: "test" })).rejects.toThrow("simulation failed");
    expect(sign).not.toHaveBeenCalled(); expect(broadcastSignedTransaction).not.toHaveBeenCalled();
  });
});
