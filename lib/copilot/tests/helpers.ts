import { createHash } from "node:crypto";
import type { RecordStore, Stored } from "../store";
import type { CopilotUser } from "../types";

/** In-memory RecordStore with real compare-and-set semantics (same contract as the Firestore/local stores). */
export class MemoryStore<T> implements RecordStore<T> {
  readonly docs = new Map<string, { value: T; version: number }>();
  /** Yield between read and write so concurrent callers genuinely interleave. */
  async read(id: string): Promise<Stored<T> | null> {
    await Promise.resolve();
    const d = this.docs.get(id);
    return d ? { value: structuredClone(d.value), version: String(d.version) } : null;
  }
  async write(id: string, expected: string | null, value: T): Promise<boolean> {
    await Promise.resolve();
    const d = this.docs.get(id);
    if ((d ? String(d.version) : null) !== expected) return false;
    this.docs.set(id, { value: structuredClone(value), version: (d?.version ?? 0) + 1 });
    return true;
  }
}

export const WALLET_A = "B7rDiCsL9DAWcd144RxPAiryc6AfVMHmq5n6KtiRmU8R";
export const WALLET_B = "GCL2pGFBKnBhkGEPZ3BhC4FuqHnfpJJnr8i9nnLKkTgD";

export const userFor = (wallet: string): CopilotUser => ({
  wallet,
  subject: createHash("sha256").update(wallet).digest("hex"),
  expiresAt: Date.now() + 3_600_000,
});
