import type { Connection, TransactionSignature } from "@solana/web3.js";
import { withTimeout } from "../async";

/** A broadcast can still land after an RPC outage. Preserve its signature for reconciliation. */
export class ConfirmationPendingError extends Error {
  constructor(public readonly signature: string) {
    super(`Confirmation is still unknown for ${signature}. Check transaction status before retrying.`);
    this.name = "ConfirmationPendingError";
  }
}

/** HTTP confirmation with a deadline that also covers stalled RPC calls. Never re-sign/re-send. */
export async function confirmSignatureHttp(
  connection: Connection,
  signature: TransactionSignature,
  lastValidBlockHeight?: number,
  timeoutMs = 60_000,
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let nextHeightCheck = 0;
  let observed = false;
  const pause = () => Date.now() >= deadline ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, Math.min(700, deadline - Date.now())));
  const read = <T>(promise: Promise<T>) => withTimeout(promise, deadline - Date.now(), "Confirmation RPC timed out");
  while (Date.now() < deadline) {
    let status;
    try {
      const response = await read(connection.getSignatureStatuses([signature], {
        // Recent submissions use the status cache; only search history during recovery.
        searchTransactionHistory: Date.now() - startedAt >= 10_000,
      }));
      status = response.value[0];
    } catch {
      // A transport failure says nothing about transaction success. Keep observing to the deadline.
      await pause();
      continue;
    }
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    if (status) observed = true;
    // A processed transaction can confirm after its blockhash expires. Expiry only proves a
    // transaction cannot newly land; it does not prove an observed transaction failed.
    if (!observed && lastValidBlockHeight !== undefined && Date.now() >= nextHeightCheck) {
      nextHeightCheck = Date.now() + 3_000;
      let height: number | undefined;
      try { height = await read(connection.getBlockHeight("confirmed")); } catch { /* retry status */ }
      if (height !== undefined && height > lastValidBlockHeight) {
        // Recheck after height to avoid racing a transaction that just landed.
        try {
          const final = (await read(connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0];
          if (final?.err) throw new Error(`Transaction failed: ${JSON.stringify(final.err)}`);
          if (final?.confirmationStatus === "confirmed" || final?.confirmationStatus === "finalized") return;
          if (!final) throw new Error("Transaction expired: block height exceeded");
          observed = true;
        } catch (error) {
          if (error instanceof Error && /^(Transaction failed:|Transaction expired:)/.test(error.message)) throw error;
        }
      }
    }
    await pause();
  }
  throw new ConfirmationPendingError(signature);
}
