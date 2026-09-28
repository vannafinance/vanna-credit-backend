/* eslint-disable @typescript-eslint/no-explicit-any */
import { AnchorProvider, BorshCoder, Program, type Idl } from "@coral-xyz/anchor";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import idlJson from "@/idl/vanna_lending.json";
import { VANNA_PROGRAM_ID } from "./config";
import { getConnection } from "./connection";

/**
 * Anchor client for `vanna_lending`, built from the NEW IDL (idl/vanna_lending.json, copied from
 * vanna-credit-layer/target/idl). The IDL's embedded address is overridden with the configured
 * program id so a redeploy only needs NEXT_PUBLIC_VANNA_PROGRAM_ID.
 */
export const VANNA_IDL = { ...(idlJson as Idl), address: VANNA_PROGRAM_ID.toBase58() } as Idl;

export const vannaCoder = new BorshCoder(VANNA_IDL);

/** Read-only wallet: the program client only builds instructions and decodes accounts. */
const readonlyWallet = {
  publicKey: PublicKey.default,
  signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs,
};

let program: Program | null = null;

/**
 * Instruction builder + account decoder. Signing never goes through Anchor's provider — every
 * instruction is sent by `tx.ts`'s simulate-first pipeline.
 */
export function getProgram(): Program {
  if (!program) {
    program = new Program(VANNA_IDL, new AnchorProvider(getConnection(), readonlyWallet as any, { commitment: "confirmed" }));
  }
  return program;
}

/** Typed-enough accessor for `program.account.<name>`. */
export function accounts(): Record<string, any> {
  return getProgram().account as unknown as Record<string, any>;
}

/** Anchor BN / number / bigint → bigint. */
export function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (value && typeof (value as any).toString === "function") return BigInt((value as any).toString());
  return 0n;
}
