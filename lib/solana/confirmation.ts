import type { Connection, TransactionSignature } from "@solana/web3.js";

/**
 * Confirm through HTTP polling without requiring a WebSocket endpoint (Surfpool's WS is
 * optional and a misconfigured one makes web3.js retry `signatureSubscribe` forever).
 */
export async function confirmSignatureHttp(
  connection: Connection,
  signature: TransactionSignature,
  lastValidBlockHeight?: number,
  timeoutMs = 60_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = response.value[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    if (lastValidBlockHeight !== undefined) {
      const currentBlockHeight = await connection.getBlockHeight("confirmed");
      if (currentBlockHeight > lastValidBlockHeight) throw new Error("Transaction expired: block height exceeded");
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error("Transaction confirmation timed out");
}
