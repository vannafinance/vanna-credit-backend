import { singleFlight } from "../async";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { getConnection, getMultipleAccountsChunked } from "./connection";
import { lenderShareAccount, walletAta } from "./pdas";
import { tokenAccountAmount } from "./protocol-state";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { TOKENS } from "./tokens";
import { fromRaw } from "./math";

/**
 * SOL kept back from "max" wallet actions so the user can still pay fees and ATA/margin
 * account rent (margin vault ATAs and debt positions are paid by the user).
 */
export const SOL_FEE_RESERVE_LAMPORTS = 50_000_000n; // 0.05 SOL

export interface WalletBalances {
  owner: string;
  /** Spendable wallet balance per symbol, raw units. SOL = native lamports (not wSOL). */
  raw: Record<string, bigint>;
  /** Same, as exact decimal strings. */
  ui: Record<string, string>;
  /** Stray wSOL sitting in the wallet's wSOL ATA (not counted in SOL above). */
  wsolRaw: bigint;
  /** Lender share balance per symbol (raw share units; shares use the underlying's decimals). */
  sharesRaw: Record<string, bigint>;
}

/**
 * One batched read of the wallet's native SOL, every registry token ATA and every lender
 * share ATA.
 */
const balanceReads = new WeakMap<Connection, ReturnType<typeof singleFlight<string, WalletBalances>>>();
export function fetchWalletBalances(owner: PublicKey, connection: Connection = getConnection()): Promise<WalletBalances> {
  let read = balanceReads.get(connection);
  if (!read) { read = singleFlight<string, WalletBalances>(); balanceReads.set(connection, read); }
  return read(owner.toBase58(), () => readWalletBalances(owner, connection));
}

async function readWalletBalances(owner: PublicKey, connection: Connection = getConnection()): Promise<WalletBalances> {
  const keys: PublicKey[] = [owner];
  for (const t of TOKENS) keys.push(walletAta(owner, t.mint, t.tokenProgram), lenderShareAccount(owner, t.mint));
  const infos = await getMultipleAccountsChunked(connection, keys);
  const lamports = BigInt(infos[0]?.lamports ?? 0);
  const raw: Record<string, bigint> = {};
  const ui: Record<string, string> = {};
  const sharesRaw: Record<string, bigint> = {};
  let wsolRaw = 0n;
  TOKENS.forEach((t, i) => {
    const ataAmount = tokenAccountAmount(infos[1 + i * 2] as AccountInfo<Buffer> | null, t.tokenProgram);
    const shares = tokenAccountAmount(infos[2 + i * 2] as AccountInfo<Buffer> | null, TOKEN_PROGRAM_ID);
    if (t.isNative) {
      wsolRaw = ataAmount;
      raw[t.symbol] = lamports;
    } else {
      raw[t.symbol] = ataAmount;
    }
    ui[t.symbol] = fromRaw(raw[t.symbol], t.decimals);
    sharesRaw[t.symbol] = shares;
  });
  return { owner: owner.toBase58(), raw, ui, wsolRaw, sharesRaw };
}

/** Max SOL a wallet action may spend (lamports), keeping {@link SOL_FEE_RESERVE_LAMPORTS} back. */
export function spendableLamports(lamports: bigint): bigint {
  const v = lamports - SOL_FEE_RESERVE_LAMPORTS;
  return v > 0n ? v : 0n;
}
