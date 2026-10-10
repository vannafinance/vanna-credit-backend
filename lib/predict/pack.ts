/**
 * Packs ordered instruction groups into as few v0 transactions as fit (pure; tested in
 * pack.test.ts). A group is atomic (never split) and groups keep their order, so a pool deposit
 * always lands after the buy that minted its tokens.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";

/** Solana packet limit for a serialized transaction. */
export const MAX_TX_BYTES = 1232;
/** Account locks per transaction (runtime limit). */
export const MAX_TX_ACCOUNTS = 64;
export const MAX_COMPUTE_UNITS = 1_400_000;

export interface IxGroup {
  label: string;
  legIndex: number | null;
  instructions: TransactionInstruction[];
  /** Compute units the group needs. */
  computeUnits: number;
  /** Needs the 256 KiB heap frame (CPIs into the Vanna core). */
  heap?: boolean;
  /** Group-specific lookup tables (Jupiter's). */
  lookupTables?: AddressLookupTableAccount[];
  /** Must be packed alone (e.g. a Jupiter route that must not share a tx with other pool writes). */
  alone?: boolean;
}

export interface PackedTx {
  groups: number[];
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  size: number;
}

function budget(groups: IxGroup[]): TransactionInstruction[] {
  const units = Math.min(MAX_COMPUTE_UNITS, groups.reduce((t, g) => t + g.computeUnits, 0) + 20_000);
  const out = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (groups.some((g) => g.heap)) out.push(ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }));
  return out;
}

const uniqTables = (tables: AddressLookupTableAccount[]) => [...new Map(tables.map((t) => [t.key.toBase58(), t])).values()];

/** Serialized size of the groups as one v0 transaction, or null if it cannot compile / fit. */
export function measure(groups: IxGroup[], payer: PublicKey, shared: AddressLookupTableAccount[]): PackedTx | null {
  const instructions = [...budget(groups), ...groups.flatMap((g) => g.instructions)];
  const lookupTables = uniqTables([...shared, ...groups.flatMap((g) => g.lookupTables ?? [])]);
  try {
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions }).compileToV0Message(lookupTables);
    const accounts = message.staticAccountKeys.length + message.addressTableLookups.reduce((t, l) => t + l.writableIndexes.length + l.readonlyIndexes.length, 0);
    const size = new VersionedTransaction(message).serialize().length;
    if (size > MAX_TX_BYTES || accounts > MAX_TX_ACCOUNTS) return null;
    // Only keep the tables the message actually references.
    const used = new Set(message.addressTableLookups.map((l) => l.accountKey.toBase58()));
    return { groups: [], instructions, lookupTables: lookupTables.filter((t) => used.has(t.key.toBase58())), size };
  } catch {
    return null;
  }
}

/** Greedy in-order packing. Throws if a single group cannot fit on its own. */
export function packGroups(groups: IxGroup[], payer: PublicKey, shared: AddressLookupTableAccount[]): PackedTx[] {
  const out: PackedTx[] = [];
  let current: number[] = [];
  let currentTx: PackedTx | null = null;
  const flush = () => {
    if (currentTx) out.push({ ...currentTx, groups: current });
    current = [];
    currentTx = null;
  };
  groups.forEach((g, i) => {
    if (current.length && !g.alone && !groups[current[0]].alone) {
      const tried = measure([...current, i].map((j) => groups[j]), payer, shared);
      if (tried) {
        current.push(i);
        currentTx = tried;
        return;
      }
    }
    flush();
    const alone = measure([g], payer, shared);
    if (!alone) throw new Error(`${g.label}: transaction too large even on its own`);
    current = [i];
    currentTx = alone;
  });
  flush();
  return out;
}
