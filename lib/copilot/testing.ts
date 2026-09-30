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
