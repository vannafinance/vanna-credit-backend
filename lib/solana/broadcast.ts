import { utils } from "@coral-xyz/anchor";
import { PublicKey, SendTransactionError, Transaction, type BlockhashWithExpiryBlockHeight, type Connection, type SendOptions, type VersionedTransaction } from "@solana/web3.js";
import { confirmSignatureHttp } from "./confirmation";

/** Simulation replaces the blockhash (`replaceRecentBlockhash`), so transactions are compiled with this. */
export const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58();

/** A blockhash fetched this recently still leaves the wallet most of its ~60 s lifetime. */
const BLOCKHASH_REUSE_MS = 10_000;

/**
 * Starts fetching the signing blockhash now, alongside simulation, instead of before and after it
 * (one round trip less before the wallet opens). `fresh()` returns it, or a new one when simulation
 * and healing took long enough to eat into its lifetime.
 */
export function blockhashAlongside(connection: Connection): { fresh: () => Promise<BlockhashWithExpiryBlockHeight> } {
  const started = Date.now();
  const pending = connection.getLatestBlockhash("confirmed");
  pending.catch(() => undefined); // awaited (and rethrown) by fresh()
  return { fresh: () => (Date.now() - started > BLOCKHASH_REUSE_MS ? connection.getLatestBlockhash("confirmed") : pending) };
}

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
