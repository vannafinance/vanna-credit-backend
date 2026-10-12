/**
 * Wallet signing for one server-built transaction.
 *
 * The server built and simulated it; the wallet only adds a signature. The signed bytes go
 * back to the server, which checks they match what it built before sending anything.
 */

import { VersionedTransaction } from "@solana/web3.js";
import { getActiveSigner } from "@/lib/solana/wallet-bridge";
import { base64ToBytes, bytesToBase64, isWalletRejection } from "./siws";

export class WalletRejectedError extends Error {
  constructor() {
    super("The signature was declined in your wallet. Nothing was sent.");
    this.name = "WalletRejectedError";
  }
}

export type SignTransaction = (tx: VersionedTransaction) => Promise<VersionedTransaction>;
export type SignAllTransactions = (txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>;

/** Default signer: the connected wallet-adapter wallet (with the unlock-retry the app already has). */
export function walletSignTransaction(): SignTransaction {
  const signer = getActiveSigner();
  return (tx) => signer.signTransaction(tx);
}

/**
 * A Predict trade: every transaction in ONE wallet approval (each keeps the app maker's signature already in it). A
 * wallet without signAllTransactions signs them one by one; a decline at any point sends nothing.
 */
export async function signUnsignedTxs(base64Txs: string[], signAll?: SignAllTransactions, sign: SignTransaction = walletSignTransaction()): Promise<string[]> {
  const txs = base64Txs.map((b) => VersionedTransaction.deserialize(base64ToBytes(b)));
  let signed: VersionedTransaction[];
  try {
    if (signAll) signed = await signAll(txs);
    else {
      signed = [];
      for (const tx of txs) signed.push(await sign(tx));
    }
  } catch (error) {
    if (isWalletRejection(error)) throw new WalletRejectedError();
    throw error;
  }
  if (signed.length !== txs.length) throw new Error("The wallet returned a different number of transactions than it was asked to sign.");
  return signed.map((t) => bytesToBase64(t.serialize()));
}

/** base64 unsigned v0 tx -> base64 signed tx. Throws WalletRejectedError when the user declines. */
export async function signUnsignedTx(base64Tx: string, sign: SignTransaction = walletSignTransaction()): Promise<string> {
  const tx = VersionedTransaction.deserialize(base64ToBytes(base64Tx));
  let signed: VersionedTransaction;
  try {
    signed = await sign(tx);
  } catch (error) {
    if (isWalletRejection(error)) throw new WalletRejectedError();
    throw error;
  }
  return bytesToBase64(signed.serialize());
}
