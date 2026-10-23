import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type TransactionInstruction,
} from "@solana/web3.js";
import { getConnection } from "./connection";
import { VANNA_PROGRAM_ID } from "./config";
import { blockhashAlongside, broadcastSignedTransaction, PLACEHOLDER_BLOCKHASH } from "./broadcast";
import { decodeProgramError, VannaTxError } from "./errors";
import { healStaleDexPools } from "./fork-heal";
import type { TxSigner } from "./wallet-bridge";

/** Solana packet limit for a serialized transaction. */
const MAX_TX_BYTES = 1232;

export interface SendOptions {
  signer: TxSigner;
  /** Human label used in error messages ("Borrow SOL simulation failed: ..."). */
  label: string;
  /** Prepends a SetComputeUnitLimit instruction (e.g. 600k for batched vanna instructions). */
  computeUnits?: number;
  /** Extra address lookup tables (e.g. Jupiter's). */
  lookupTables?: AddressLookupTableAccount[];
  /** Progress callback for UI step text. */
  onStatus?: (status: "simulating" | "signing" | "sending" | "confirming") => void;
}

/** Wraps a Keypair as a TxSigner (scripts / e2e only — the app always uses the browser wallet). */
export function keypairSigner(keypair: Keypair): TxSigner {
  const sign = <T extends Transaction | VersionedTransaction>(tx: T): T => {
    if (tx instanceof VersionedTransaction) tx.sign([keypair]);
    else tx.partialSign(keypair);
    return tx;
  };
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => sign(tx),
    signAllTransactions: async (txs) => txs.map(sign),
  };
}

function simulationError(label: string, err: unknown, logs: string[] | null | undefined): VannaTxError {
  const logText = (logs ?? []).join("\n");
  const raw = `${label} simulation failed: ${JSON.stringify(err)}\n${logText || "No program logs returned"}`;
  const decoded = decodeProgramError(`${JSON.stringify(err)}\n${logText}`);
  return new VannaTxError(decoded ? `${label}: ${decoded.message}` : raw.split("\n").slice(0, 1).join(""), {
    logs: logs ?? [],
    code: decoded?.name,
    raw,
  });
}

function isTooLarge(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /transaction too large|EncodingOverrun|versioned.?transaction too large|encoding overruns|RangeError/i.test(text);
}

/**
 * Heap frame requested for every transaction that calls the Vanna core. The core's allocator
 * (vanna-credit-layer `src/heap.rs`) grows upward and can use a frame up to 256 KiB; the default
 * 32 KiB runs out on a `margin_execute` into a long Jupiter route (e.g. one xStock into another)
 * next to many position groups. Costs a few dozen compute units.
 */
const VANNA_HEAP_FRAME_BYTES = 256 * 1024;

function withComputeBudget(instructions: TransactionInstruction[], units?: number): TransactionInstruction[] {
  const budget: TransactionInstruction[] = [];
  if (units) budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  if (instructions.some((ix) => ix.programId.equals(VANNA_PROGRAM_ID))) budget.push(ComputeBudgetProgram.requestHeapFrame({ bytes: VANNA_HEAP_FRAME_BYTES }));
  return [...budget, ...instructions];
}

/**
 * Compile → simulate (logs surfaced in the thrown error) → sign → broadcast through the fork
 * connection → confirm by HTTP polling. The blockhash always comes from the fork. On a failed
 * simulation that touches a stale-prone DEX pool the pool is re-cloned and the simulation retried
 * once (no-op for plain vanna instructions).
 */
async function sendV0(
  instructions: TransactionInstruction[],
  opts: SendOptions,
  tables: AddressLookupTableAccount[],
): Promise<string> {
  const connection = getConnection();
  const message = new TransactionMessage({
    payerKey: opts.signer.publicKey,
    recentBlockhash: PLACEHOLDER_BLOCKHASH,
    instructions,
  }).compileToV0Message(tables);
  const tx = new VersionedTransaction(message);
  const size = tx.serialize().length;
  if (size > MAX_TX_BYTES) throw new Error(`Transaction too large: ${size} > ${MAX_TX_BYTES}`);

  opts.onStatus?.("simulating");
  const blockhash = blockhashAlongside(connection);
  const simulate = () => connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  let simulation = await simulate();
  if (simulation.value.err) {
    const healed = await healStaleDexPools(connection, tx);
    if (healed > 0) simulation = await simulate();
  }
  if (simulation.value.err) throw simulationError(opts.label, simulation.value.err, simulation.value.logs);

  const latest = await blockhash.fresh();
  tx.message.recentBlockhash = latest.blockhash;
  opts.onStatus?.("signing");
  const signed = await opts.signer.signTransaction(tx);
  opts.onStatus?.("sending");
  return broadcastSignedTransaction(connection, signed, latest.lastValidBlockHeight, {
    skipPreflight: true, // instructions already simulated; only the lifetime was refreshed
    maxRetries: 3,
  }, () => opts.onStatus?.("confirming"));
}

/**
 * When a transaction exceeds the packet limit (batched deposit + borrow with many open
 * positions' remaining accounts), create a temporary Address Lookup Table holding every key,
 * wait one slot, then send a v0 transaction that references it. Prep transactions are signed
 * in one `signAllTransactions` approval.
 */
export async function prepareTransactionTables(instructions: TransactionInstruction[], opts: SendOptions): Promise<AddressLookupTableAccount[]> {
  const tables = [...(opts.lookupTables ?? [])];
  const connection = getConnection();
  const payer = opts.signer.publicKey;
  const cacheKey = `vanna:lookup:${connection.rpcEndpoint}:${payer.toBase58()}`;
  const fits = () => {
    try {
      const tx = new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:PublicKey.default.toBase58(),instructions}).compileToV0Message(tables));
      return tx.serialize().length <= MAX_TX_BYTES;
    } catch (error) { if (isTooLarge(error)) return false; throw error; }
  };
  if (fits()) return tables;
  // In-memory only: no browser storage (a lost table is simply recreated on the next large transaction).
  const saved = personalTables.get(cacheKey);
  if (saved) {
    const table = (await connection.getAddressLookupTable(new PublicKey(saved))).value;
    if (table) { tables.push(table); if (fits()) return tables; }
  }
  return createPersonalLookupTable(instructions, opts, tables, cacheKey);
}

const personalTables = new Map<string, string>();
async function createPersonalLookupTable(instructions: TransactionInstruction[], opts: SendOptions, tables: AddressLookupTableAccount[], cacheKey:string): Promise<AddressLookupTableAccount[]> {
  const connection = getConnection();
  const payer = opts.signer.publicKey;
  const seen = new Set(tables.flatMap(t => t.state.addresses.map(k => k.toBase58())));
  const addresses: PublicKey[] = [];
  for (const ix of instructions) {
    for (const key of [ix.programId, ...ix.keys.map((k) => k.pubkey)]) {
      const id = key.toBase58();
      if (seen.has(id) || key.equals(payer)) continue;
      seen.add(id);
      addresses.push(key);
    }
  }
  if (!addresses.length || addresses.length > 256) throw new Error(`${opts.label}: transaction cannot fit in a lookup table`);
  const slot = await connection.getSlot("finalized");
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer,
    payer,
    recentSlot: Math.max(0, slot - 1),
  });
  const extendIxs = [];
  for (let i = 0; i < addresses.length; i += 20) {
    extendIxs.push(
      AddressLookupTableProgram.extendLookupTable({ payer, authority: payer, lookupTable: lutAddress, addresses: addresses.slice(i, i + 20) }),
    );
  }
  const groups = [[createIx, extendIxs[0]!], ...extendIxs.slice(1).map((ix) => [ix])];
  const latest = await connection.getLatestBlockhash("confirmed");
  const prep = groups.map((group) => {
    const tx = new Transaction({ feePayer: payer, recentBlockhash: latest.blockhash });
    tx.add(...group);
    return tx;
  });
  opts.onStatus?.("signing");
  const signedPrep = await opts.signer.signAllTransactions(prep);
  for (const signed of signedPrep) {
    opts.onStatus?.("sending");
    await broadcastSignedTransaction(connection, signed, latest.lastValidBlockHeight,
      { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }, () => opts.onStatus?.("confirming"));
  }
  // A lookup table is only usable from the slot after its last extension.
  const extendedAt = await connection.getSlot("confirmed");
  let activated = false;
  for (let i = 0; i < 40; i++) {
    if ((await connection.getSlot("confirmed")) > extendedAt) { activated = true; break; }
    await new Promise((r) => setTimeout(r, 350));
  }
  if (!activated) throw new Error(`${opts.label}: lookup table activation timed out`);
  const table = (await connection.getAddressLookupTable(lutAddress)).value;
  if (!table) throw new Error(`${opts.label}: lookup table was not activated`);
  personalTables.set(cacheKey, lutAddress.toBase58());
  return [...tables, table];
}

/**
 * THE send pipeline every service function uses. Returns the confirmed signature; throws a
 * {@link VannaTxError} (with simulation logs) on failure.
 */
export async function sendInstructions(instructions: TransactionInstruction[], opts: SendOptions): Promise<string> {
  const ixs = withComputeBudget(instructions, opts.computeUnits);
  try {
    return await sendV0(ixs, opts, opts.lookupTables ?? []);
  } catch (error) {
    if (!isTooLarge(error)) throw error;
    return sendV0(ixs, opts, await prepareTransactionTables(ixs, opts));
  }
}
