/**
 * Static address lookup table for Predict transactions (server only, fork only).
 *
 * A buy + pool deposit in one transaction carries ~35 accounts and overflows the 1,232-byte packet
 * without a table. Every market-independent account (programs, CASH, USDC, Vanna's USDC reserve
 * accounts, the pool program's config, the maker's CASH account) goes into one table owned by the
 * fork maker, created once and reused. The address is taken from PREDICT_LUT_ADDRESS, else
 * `.cache/predict-lut.json`; a missing or incomplete table is recreated. Pool PDAs are never put in
 * it (merge / redeem need the pool as a writable seed-signed account, which a table cannot carry
 * through Jupiter's CPI). If creation fails, transactions are packed without it (smaller batches).
 */
import { AddressLookupTableProgram, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getConnection } from "@/lib/solana/connection";
import { confirmSignatureHttp } from "@/lib/solana/confirmation";
import { getForkMaker } from "./keys.server";
import { cashAta, ensureSol } from "./maker.server";
import { staticPoolAccounts } from "./pool.server";

const FILE = path.join(process.cwd(), ".cache", "predict-lut.json");
const g = globalThis as unknown as { __predictLut?: { table: AddressLookupTableAccount | null; at: number; pending: Promise<AddressLookupTableAccount | null> | null } };
const state = (g.__predictLut ??= { table: null, at: 0, pending: null });
const RECHECK_MS = 10 * 60_000;

const wanted = () => [...staticPoolAccounts(), cashAta(getForkMaker().publicKey)];

function savedAddress(): string | null {
  if (process.env.PREDICT_LUT_ADDRESS) return process.env.PREDICT_LUT_ADDRESS;
  try {
    if (existsSync(FILE)) return (JSON.parse(readFileSync(FILE, "utf8")) as { address?: string }).address ?? null;
  } catch {
    /* rebuilt below */
  }
  return null;
}

const covers = (t: AddressLookupTableAccount) => {
  const have = new Set(t.state.addresses.map((a) => a.toBase58()));
  return wanted().every((k) => have.has(k.toBase58()));
};

async function create(): Promise<AddressLookupTableAccount> {
  const conn = getConnection();
  const maker = getForkMaker();
  await ensureSol(maker.publicKey, 5e9, 50e9);
  const slot = await conn.getSlot("finalized");
  const [createIx, address] = AddressLookupTableProgram.createLookupTable({ authority: maker.publicKey, payer: maker.publicKey, recentSlot: Math.max(0, slot - 1) });
  const extendIx = AddressLookupTableProgram.extendLookupTable({ authority: maker.publicKey, payer: maker.publicKey, lookupTable: address, addresses: wanted() });
  const latest = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: maker.publicKey, recentBlockhash: latest.blockhash, instructions: [createIx, extendIx] }).compileToV0Message());
  tx.sign([maker]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  await confirmSignatureHttp(conn, sig, latest.lastValidBlockHeight);
  // A table is usable from the slot after its last extension.
  const extendedAt = await conn.getSlot("confirmed");
  for (let i = 0; i < 40 && (await conn.getSlot("confirmed")) <= extendedAt; i++) await new Promise((r) => setTimeout(r, 350));
  const table = (await conn.getAddressLookupTable(address)).value;
  if (!table) throw new Error("Predict lookup table was not activated");
  try {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify({ address: address.toBase58() }));
  } catch {
    /* read-only filesystem: recreated on the next cold start */
  }
  return table;
}

async function resolve(): Promise<AddressLookupTableAccount | null> {
  const conn = getConnection();
  const saved = savedAddress();
  if (saved) {
    const table = (await conn.getAddressLookupTable(new PublicKey(saved)).catch(() => ({ value: null }))).value;
    if (table && covers(table)) return table;
  }
  return create();
}

/** The shared Predict lookup table, or null if it cannot be created (callers pack without it). */
export async function getPredictLookupTable(): Promise<AddressLookupTableAccount | null> {
  if (state.table && Date.now() - state.at < RECHECK_MS) return state.table;
  if (!state.pending) {
    state.pending = resolve()
      .then((t) => {
        state.table = t;
        state.at = Date.now();
        return t;
      })
      .catch((error) => {
        console.warn("Predict lookup table unavailable:", error instanceof Error ? error.message : error);
        return null;
      })
      .finally(() => (state.pending = null));
  }
  return state.pending;
}
