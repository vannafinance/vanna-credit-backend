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

/** Default signer: the connected wallet-adapter wallet (with the unlock-retry the app already has). */
export function walletSignTransaction(): SignTransaction {
  const signer = getActiveSigner();
  return (tx) => signer.signTransaction(tx);
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
