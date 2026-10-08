import { beforeEach, expect, it, vi } from "vitest";
import { utils } from "@coral-xyz/anchor";
import { Keypair, SendTransactionError, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { broadcastSignedTransaction } from "./broadcast";
import { confirmSignatureHttp } from "./confirmation";
vi.mock("./confirmation", () => ({ confirmSignatureHttp: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => vi.clearAllMocks());
const makeTx = () => {
  const payer = Keypair.generate();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: SystemProgram.programId.toBase58(), instructions: [] }).compileToV0Message());
  tx.sign([payer]); return tx;
};
it("recovers a dropped send response without sending twice", async () => {
  const tx = makeTx(); const sendRawTransaction = vi.fn().mockRejectedValue(new Error("fetch failed"));
  const c = { sendRawTransaction } as unknown as Connection;
  const expected = utils.bytes.bs58.encode(tx.signatures[0]);
  expect(await broadcastSignedTransaction(c, tx, 100, {})).toBe(expected);
  expect(confirmSignatureHttp).toHaveBeenCalledWith(c, expected, 100);
  expect(sendRawTransaction).toHaveBeenCalledTimes(1);
});
it("surfaces definitive preflight rejection immediately", async () => {
  const error = new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "insufficient funds" });
  const c = { sendRawTransaction: vi.fn().mockRejectedValue(error) } as unknown as Connection;
  await expect(broadcastSignedTransaction(c, makeTx(), 100, {})).rejects.toBe(error);
  expect(confirmSignatureHttp).not.toHaveBeenCalled();
});
it("rejects an unsigned wallet result before broadcasting", async () => {
  const tx = makeTx(); tx.signatures[0].fill(0);
  const sendRawTransaction = vi.fn();
  await expect(broadcastSignedTransaction({ sendRawTransaction } as unknown as Connection, tx, 100, {})).rejects.toThrow("unsigned");
  expect(sendRawTransaction).not.toHaveBeenCalled();
});
