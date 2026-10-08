import { utils } from "@coral-xyz/anchor";
import { SendTransactionError, Transaction, type Connection, type SendOptions, type VersionedTransaction } from "@solana/web3.js";
import { confirmSignatureHttp } from "./confirmation";

/** A lost send response is ambiguous: recover using the already signed transaction's ID. */
export async function broadcastSignedTransaction(
  connection: Connection,
  signed: Transaction | VersionedTransaction,
  lastValidBlockHeight: number,
  options: SendOptions,
  onConfirming?: () => void,
): Promise<string> {
  const bytes = signed.serialize();
  const signatureBytes = signed instanceof Transaction ? signed.signature : signed.signatures[0];
  if (!signatureBytes || signatureBytes.every((byte) => byte === 0)) throw new Error("Wallet returned an unsigned transaction");
  const expectedSignature = utils.bytes.bs58.encode(signatureBytes);
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(bytes, options);
  } catch (error) {
    // A structured RPC/preflight rejection is definitive. A network timeout isn't.
    if (error instanceof SendTransactionError) throw error;
    signature = expectedSignature;
  }
  onConfirming?.();
  await confirmSignatureHttp(connection, signature, lastValidBlockHeight);
  return signature;
}
