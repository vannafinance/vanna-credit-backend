import {
  ACCOUNT_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeAccount3Instruction,
  createSyncNativeInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { getConnection } from "./connection";
import { walletAta } from "./pdas";
import { WSOL_MINT } from "./tokens";

/**
 * Wrap `lamports` native SOL into the owner's wSOL ATA (creating it idempotently). Returns the
 * ATA and whether it existed before, so callers can close a freshly created one afterwards.
 */
export async function wrapSolInstructions(owner: PublicKey, lamports: bigint) {
  const ata = walletAta(owner, WSOL_MINT, TOKEN_PROGRAM_ID);
  const existed = Boolean(await getConnection().getAccountInfo(ata, "confirmed"));
  const instructions: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, WSOL_MINT, TOKEN_PROGRAM_ID),
  ];
  if (lamports > 0n) {
    instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }), createSyncNativeInstruction(ata));
  }
  return { ata, existed, instructions };
}

/**
 * An isolated, freshly seeded native token account to RECEIVE wSOL (redeem / withdraw), closed
 * in the same transaction so the SOL lands in the wallet as native SOL. The user's own wSOL ATA
 * (and any balance in it) is never touched.
 */
export async function temporaryWsolReceiver(owner: PublicKey) {
  const seed = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  const account = await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID);
  const rent = await getConnection().getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  return {
    account,
    setup: [
      SystemProgram.createAccountWithSeed({
        fromPubkey: owner,
        basePubkey: owner,
        seed,
        newAccountPubkey: account,
        lamports: rent,
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccount3Instruction(account, WSOL_MINT, owner),
    ] as TransactionInstruction[],
    cleanup: [createCloseAccountInstruction(account, owner, owner)] as TransactionInstruction[],
  };
}
