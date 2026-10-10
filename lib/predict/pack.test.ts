import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { MAX_TX_BYTES, measure, packGroups, type IxGroup } from "./pack";

const payer = Keypair.generate().publicKey;
/** An instruction touching `n` fresh accounts. */
const ix = (n: number) =>
  new TransactionInstruction({ programId: SystemProgram.programId, keys: Array.from({ length: n }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true })), data: Buffer.alloc(8) });
const group = (label: string, accounts: number, extra: Partial<IxGroup> = {}): IxGroup => ({ label, legIndex: 0, instructions: [ix(accounts)], computeUnits: 100_000, ...extra });

describe("packGroups", () => {
  it("packs small groups together, in order", () => {
    const packed = packGroups([group("a", 5), group("b", 5), group("c", 5)], payer, []);
    expect(packed).toHaveLength(1);
    expect(packed[0].groups).toEqual([0, 1, 2]);
    expect(packed[0].size).toBeLessThanOrEqual(MAX_TX_BYTES);
  });
  it("starts a new transaction when the next group does not fit", () => {
    const packed = packGroups([group("a", 20), group("b", 20), group("c", 5)], payer, []);
    expect(packed.map((p) => p.groups)).toEqual([[0], [1, 2]]);
  });
  it("keeps `alone` groups by themselves", () => {
    const packed = packGroups([group("a", 2), group("swap", 2, { alone: true }), group("c", 2)], payer, []);
    expect(packed.map((p) => p.groups)).toEqual([[0], [1], [2]]);
  });
  it("throws when one group cannot fit at all", () => {
    expect(() => packGroups([group("huge", 60)], payer, [])).toThrow(/too large/);
  });
  it("adds a heap frame request only when a group needs it", () => {
    const plain = measure([group("a", 1)], payer, [])!;
    const heap = measure([group("a", 1, { heap: true })], payer, [])!;
    expect(heap.instructions.length).toBe(plain.instructions.length + 1);
  });
});
