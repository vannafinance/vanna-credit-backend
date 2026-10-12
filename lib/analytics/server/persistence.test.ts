import { describe, expect, it } from "vitest";
import { encodeState, SCHEMA, type PersistedState } from "./persistence";
import type { AccountRow } from "../types";

const base = (over: Partial<PersistedState> = {}): PersistedState => ({
  v: SCHEMA, savedAt: 1, program: "p", events: [], hfHistory: {},
  registry: { margins: [], firstSeen: [], queue: [], newestSignature: "s", oldestSignature: null, discovered: 0, inspected: 0, oldestInspectedTime: null, backfillExhausted: false },
  ...over,
});
const rows = (n: number): AccountRow[] => Array.from({ length: n }, (_, i) => ({ owner: `o${i}`, address: `a${i}`, pad: "x".repeat(1800) }) as unknown as AccountRow);

describe("encodeState", () => {
  it("keeps everything, in pieces under the document limit, when it fits", () => {
    const { parts, rowsDropped } = encodeState(base({ rows: rows(400), rowsAt: 5 }));
    expect(rowsDropped).toBe(false);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 400_000)).toBe(true);
    expect(JSON.parse(parts.join("")).rows).toHaveLength(400);
  });
  it("drops the cached rows, not the scan state, when the whole thing would not fit", () => {
    const { parts, rowsDropped } = encodeState(base({ rows: rows(4000), rowsAt: 5 }));
    expect(rowsDropped).toBe(true);
    const back = JSON.parse(parts.join("")) as PersistedState;
    expect(back.rows).toBeUndefined();
    expect(back.registry.newestSignature).toBe("s");
  });
  it("fails only when the scan state alone is too large", () => {
    const big = base({ registry: { ...base().registry, margins: Array.from({ length: 60_000 }, (_, i) => [`m${"x".repeat(40)}${i}`, `o${"y".repeat(40)}${i}`] as [string, string]) } });
    expect(() => encodeState(big)).toThrow("state_too_large");
  });
});
