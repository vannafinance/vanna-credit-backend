import { afterEach, expect, it, vi } from "vitest";
import { PublicKey, Transaction } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { getActiveSigner, setActiveSolanaWallet } from "./wallet-bridge";
afterEach(() => { setActiveSolanaWallet(null); vi.useRealTimers(); });
const wallet = (signTransaction: ReturnType<typeof vi.fn>, publicKey = PublicKey.default) => ({ publicKey, connected: true, signTransaction, signAllTransactions: vi.fn() }) as unknown as WalletContextState;
it("bounds an extension that never answers", async () => {
  vi.useFakeTimers(); const sign = vi.fn(() => new Promise(() => {})); setActiveSolanaWallet(wallet(sign));
  const result = getActiveSigner().signTransaction(new Transaction());
  const check = expect(result).rejects.toThrow("Wallet approval timed out");
  await vi.advanceTimersByTimeAsync(120_000); await check;
  expect(sign).toHaveBeenCalledTimes(1);
});
it("never sends another signing request after explicit rejection", async () => {
  const sign = vi.fn().mockRejectedValue(new Error("User rejected")); setActiveSolanaWallet(wallet(sign));
  await expect(getActiveSigner().signTransaction(new Transaction())).rejects.toThrow("User rejected");
  expect(sign).toHaveBeenCalledTimes(1);
});
it("does not sign with another wallet during unlock recovery", async () => {
  vi.useFakeTimers(); const sign = vi.fn().mockRejectedValue(new Error("wallet is locked")); setActiveSolanaWallet(wallet(sign));
  const result = getActiveSigner().signTransaction(new Transaction());
  const check = expect(result).rejects.toThrow("Wallet changed");
  await vi.advanceTimersByTimeAsync(1);
  const other = vi.fn(); setActiveSolanaWallet(wallet(other, new PublicKey("So11111111111111111111111111111111111111112")));
  await vi.advanceTimersByTimeAsync(1_500); await check; expect(other).not.toHaveBeenCalled();
});
