import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ORACLE_PROGRAM_ID, PYTH_PUSH_ORACLE_PROGRAM_ID, PYTH_SHARD_ID, VANNA_PROGRAM_ID } from "./config";

/** Mirrors programs/vanna_credit_layer/src/constants.rs (and the oracle agent's) seeds exactly. */
const seed = (value: string) => Buffer.from(value, "utf8");

export const protocolConfigPda = (): PublicKey =>
  PublicKey.findProgramAddressSync([seed("protocol")], VANNA_PROGRAM_ID)[0];

export const assetConfigPda = (mint: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([seed("asset"), mint.toBuffer()], VANNA_PROGRAM_ID)[0];

export const reservePda = (mint: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([seed("reserve"), mint.toBuffer()], VANNA_PROGRAM_ID)[0];

export const shareMintPda = (mint: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([seed("share_mint"), mint.toBuffer()], VANNA_PROGRAM_ID)[0];

/** One margin account per wallet — seeded only by the authority, no subaccount id. */
export const marginPda = (authority: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([seed("margin"), authority.toBuffer()], VANNA_PROGRAM_ID)[0];

export const debtPositionPda = (margin: PublicKey, reserve: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([seed("debt"), margin.toBuffer(), reserve.toBuffer()], VANNA_PROGRAM_ID)[0];

/** Whitelist entry for an external program `margin_execute` may call (Jupiter, Titan, Kamino Lend, Ember, Phoenix). */
export const integrationPda = (programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([seed("integration"), programId.toBuffer()], VANNA_PROGRAM_ID)[0];

/** The oracle agent's price book: every token's OracleConfig, keyed by mint. */
export const priceBookPda = (): PublicKey => PublicKey.findProgramAddressSync([seed("price_book")], ORACLE_PROGRAM_ID)[0];

/** The oracle agent's market book for a venue: its listed markets (legs), leverage caps, index prices. */
export const marketBookPda = (venue: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([seed("market_book"), venue.toBuffer()], ORACLE_PROGRAM_ID)[0];

/** Reserve liquidity vault = ATA(mint, owner = reserve PDA). */
export const reserveVault = (mint: PublicKey, tokenProgram: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, reservePda(mint), true, tokenProgram);

/** Margin vault = ATA(mint, owner = margin PDA). Its live balance IS the collateral. */
export const marginVault = (margin: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, margin, true, tokenProgram);

/** Lender share account = ATA(share mint, lender) under classic SPL Token. */
export const lenderShareAccount = (lender: PublicKey, underlyingMint: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(shareMintPda(underlyingMint), lender, false, TOKEN_PROGRAM_ID);

/** Wallet ATA for a mint under the asset's own token program. */
export const walletAta = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);

function hexToBytes(hex: string): Buffer {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex");
}

/**
 * Pyth push-oracle price feed account: PDA([u16 shard LE, feedIdBytes], push-oracle program).
 * Owned by the Pyth receiver program; holds a PriceUpdateV2.
 */
export function priceFeedAccount(feedIdHex: string): PublicKey {
  const shard = Buffer.alloc(2);
  shard.writeUInt16LE(PYTH_SHARD_ID, 0);
  return PublicKey.findProgramAddressSync([shard, hexToBytes(feedIdHex)], PYTH_PUSH_ORACLE_PROGRAM_ID)[0];
}

/** Feed id bytes (as stored in AssetConfig.price_feed_id) → hex. */
export function feedIdToHex(bytes: number[] | Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
