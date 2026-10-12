import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { fetchWalletBalances, spendableLamports } from "@/lib/solana/balances";
import { tokenByMint } from "@/lib/solana/tokens";

/** LIQUIDATOR_KEYPAIR: a JSON byte array (solana-keygen format) or base58; or LIQUIDATOR_KEYPAIR_PATH: a keygen file. */
export function loadKeypair(): Keypair {
  const path = process.env.LIQUIDATOR_KEYPAIR_PATH;
  const raw = (process.env.LIQUIDATOR_KEYPAIR ?? (path ? readFileSync(path, "utf8") : "")).trim();
  if (!raw) throw new Error("Set LIQUIDATOR_KEYPAIR or LIQUIDATOR_KEYPAIR_PATH");
  return Keypair.fromSecretKey(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : utils.bytes.bs58.decode(raw));
}

/** The liquidator's balances at one moment: what each strategy may spend. */
export interface Wallet {
  publicKey: PublicKey;
  /** Raw balance of a token by mint (SOL counts what is spendable after the fee reserve). */
  balance(mint: PublicKey): bigint;
  sol: number;
  bySymbol: Record<string, bigint>;
}

export async function readWallet(publicKey: PublicKey): Promise<Wallet> {
  const balances = await fetchWalletBalances(publicKey);
  return {
    publicKey,
    balance: (mint) => {
      const token = tokenByMint(mint);
      if (!token) return 0n;
      return token.isNative ? spendableLamports(balances.raw.SOL ?? 0n) : (balances.raw[token.symbol] ?? 0n);
    },
    sol: Number(balances.raw.SOL ?? 0n) / 1e9,
    bySymbol: balances.raw,
  };
}
