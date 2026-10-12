import { DECLINE_SYSTEM } from "./decline";
import type { RecordStore, Stored } from "./store";

/** In-memory CAS store for tests: same contract as the durable stores, no disk or network. */
export class MemoryRecordStore<T> implements RecordStore<T> {
  private readonly docs = new Map<string, { version: number; value: T }>();

  async read(id: string): Promise<Stored<T> | null> {
    const d = this.docs.get(id);
    return d ? { version: String(d.version), value: structuredClone(d.value) } : null;
  }

  async write(id: string, expected: string | null, value: T): Promise<boolean> {
    const d = this.docs.get(id);
    if ((d ? String(d.version) : null) !== expected) return false;
    this.docs.set(id, { version: (d?.version ?? -1) + 1, value: structuredClone(value) });
    return true;
  }
}

/**
 * True when a refused turn reached the model only to word the refusal: at most one request, the decline prompt, and no
 * tools, so the model cannot act or change the decision.
 */
export function onlyDeclineWording(requests: Array<{ system: string; tools?: unknown[] }>): boolean {
  return requests.length <= 1 && requests.every((r) => r.system === DECLINE_SYSTEM && !r.tools?.length);
}
