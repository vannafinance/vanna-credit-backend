/**
 * Fork market maker and CASH test faucet (server only, Surfpool fork only). Ported from
 * Backend-Solana-v2 `lib/world/fork-maker.server.ts`.
 *
 * On mainnet, World's makers (BisonFI, JanusFI) take the other side of every one-sided trade, but
 * they only accept swaps routed through DFlow with a quote signed for the trader, which a fork
 * cannot obtain. On the fork this server plays that role with its own keypair: it trades at the
 * prices World's makers traded at on mainnet (prices.server.ts) and mints outcome tokens through
 * World's real `prediCt.split`, exactly as World's makers do.
 *
 * The maker's SOL and CASH float, and the faucet, use Surfpool cheatcodes (a real cluster rejects
 * them).
 */
import { PublicKey, Transaction, type Keypair } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getConnection } from "@/lib/solana/connection";
import { confirmSignatureHttp } from "@/lib/solana/confirmation";
import { callCheatcode } from "@/lib/solana/server/cheatcodes";
import { CASH_DECIMALS, CASH_MINT } from "./constants";
import { tokenAmountOf } from "./decode";
import { getForkMaker } from "./keys.server";

const CASH = new PublicKey(CASH_MINT);
const MAKER_MIN_SOL = 5 * 1e9;
const MAKER_TOPUP_SOL = 50 * 1e9;
const MAKER_MIN_CASH = 100_000n * 10n ** BigInt(CASH_DECIMALS);
const MAKER_TOPUP_CASH = 1_000_000n * 10n ** BigInt(CASH_DECIMALS);

export const cashAta = (owner: PublicKey) => getAssociatedTokenAddressSync(CASH, owner, true, TOKEN_2022_PROGRAM_ID);

/** Raises a system account's SOL to `topUp` lamports if it holds less than `min`. */
export async function ensureSol(owner: PublicKey, min: number, topUp: number): Promise<void> {
  const lamports = await getConnection().getBalance(owner, "confirmed");
  if (lamports >= min) return;
  await callCheatcode("surfnet_setAccount", [owner.toBase58(), { lamports: topUp }]);
}

/**
 * Creates `owner`'s CASH account with a real transaction (paid by the maker), so it carries every
 * Token-2022 extension CASH requires, exactly as a wallet-created account would.
 */
export async function ensureCashAccount(owner: PublicKey): Promise<PublicKey> {
  const conn = getConnection();
  const ata = cashAta(owner);
  if (await conn.getAccountInfo(ata, "confirmed")) return ata;
  const maker = getForkMaker();
  await ensureSol(maker.publicKey, MAKER_MIN_SOL, MAKER_TOPUP_SOL);
  const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(maker.publicKey, ata, owner, CASH, TOKEN_2022_PROGRAM_ID));
  const latest = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = maker.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(maker);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await confirmSignatureHttp(conn, sig, latest.lastValidBlockHeight);
  return ata;
}

export async function readTokenAmount(account: PublicKey): Promise<bigint> {
  const info = await getConnection().getAccountInfo(account, "confirmed");
  return tokenAmountOf(info?.data as Buffer | undefined);
}

/** Sets a token account's amount in place (the account keeps its owner, extensions and rent). */
async function setTokenAmount(account: PublicKey, amount: bigint): Promise<void> {
  const info = await getConnection().getAccountInfo(account, "confirmed");
  if (!info) throw new Error(`token account ${account.toBase58()} does not exist`);
  const data = Buffer.from(info.data);
  data.writeBigUInt64LE(amount, 64);
  await callCheatcode("surfnet_setAccount", [
    account.toBase58(),
    { lamports: info.lamports, data: data.toString("hex"), owner: info.owner.toBase58(), executable: false },
  ]);
}

/** Makes sure the maker has SOL for fees / rent and a CASH float for filling trades. */
export async function ensureMakerReady(): Promise<Keypair> {
  const maker = getForkMaker();
  if (Date.now() - makerHealthyAt < MAKER_RECHECK_MS) return maker;
  makerCheck ??= checkMaker(maker).finally(() => (makerCheck = null));
  await makerCheck;
  return maker;
}

/** A maker holding at least twice both minimums is not re-read for this long (a trade uses a sliver). */
const MAKER_RECHECK_MS = 30_000;
let makerHealthyAt = 0;
let makerCheck: Promise<void> | null = null;

/** One read for both floats (was: SOL balance, CASH account exists, CASH amount), then top up. */
async function checkMaker(maker: Keypair): Promise<void> {
  const ata = cashAta(maker.publicKey);
  const [account, cash] = await getConnection().getMultipleAccountsInfo([maker.publicKey, ata], "confirmed");
  const lamports = account?.lamports ?? 0;
  if (lamports < MAKER_MIN_SOL) await callCheatcode("surfnet_setAccount", [maker.publicKey.toBase58(), { lamports: MAKER_TOPUP_SOL }]);
  if (!cash) await ensureCashAccount(maker.publicKey);
  const amount = tokenAmountOf(cash?.data as Buffer | undefined);
  if (amount < MAKER_MIN_CASH) await setTokenAmount(ata, MAKER_TOPUP_CASH);
  if (lamports >= 2 * MAKER_MIN_SOL && amount >= 2n * MAKER_MIN_CASH) makerHealthyAt = Date.now();
}

/** Test faucet: adds `cash` CASH (UI units) and tops SOL up for fees. */
export async function fundCashOnFork(owner: PublicKey, cash: number): Promise<{ cash: number; sol: number }> {
  // Add SOL with an airdrop, never by overwriting the balance: a parallel SOL faucet click would be wiped.
  const conn = getConnection();
  if ((await conn.getBalance(owner, "confirmed")) < 0.2 * 1e9) {
    const sig = await conn.requestAirdrop(owner, 1e9);
    await confirmSignatureHttp(conn, sig);
  }
  const ata = await ensureCashAccount(owner);
  const add = BigInt(Math.round(cash * 10 ** CASH_DECIMALS));
  const next = (await readTokenAmount(ata)) + add;
  await setTokenAmount(ata, next);
  const sol = await conn.getBalance(owner, "confirmed");
  return { cash: Number(next) / 10 ** CASH_DECIMALS, sol: sol / 1e9 };
}
