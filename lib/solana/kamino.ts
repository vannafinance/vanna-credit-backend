import { Buffer } from "buffer";
import { AccountMeta, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getToken, type TokenInfo } from "./tokens";
import { mulDivFloor } from "./math";

/**
 * Kamino Lend (klend) — the Farm page's single-asset vaults.
 *
 * A margin account supplies an asset to a Kamino main-market reserve through the program's
 * `margin_execute` (KaminoLend adapter, `programs/vanna_lending/src/adapters/kamino.rs`). The cToken
 * it receives stays in the margin account as collateral, valued at the reserve's exchange rate ×
 * the underlying's Pyth price. Each cToken is registered on-chain as a collateral-only asset
 * (`scripts/src/integrations-fork.ts register-receipt`).
 *
 * Kamino Liquidity (multi-asset LP strategies) is NOT supported: that program rejects CPI
 * (`CPINotAllowed`), so a margin account can never hold its shares.
 */
export const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
export const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

const MAIN_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
const MAIN_MARKET_AUTHORITY = new PublicKey("9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo");

/** Every klend cToken mint has 6 decimals, whatever its underlying's. */
export const CTOKEN_DECIMALS = 6;

export interface KaminoReceipt {
  /** Display symbol of the cToken, e.g. "kSOL". */
  symbol: string;
  /** Registry symbol of the underlying. */
  underlying: string;
  market: PublicKey;
  marketAuthority: PublicKey;
  reserve: PublicKey;
  /** Reserve liquidity supply vault. */
  liquidityVault: PublicKey;
  /** cToken mint (the collateral-only Vanna asset). */
  collateralMint: PublicKey;
}

const receipt = (underlying: string, reserve: string, liquidityVault: string, collateralMint: string): KaminoReceipt => ({
  symbol: `k${underlying}`,
  underlying,
  market: MAIN_MARKET,
  marketAuthority: MAIN_MARKET_AUTHORITY,
  reserve: new PublicKey(reserve),
  liquidityVault: new PublicKey(liquidityVault),
  collateralMint: new PublicKey(collateralMint),
});

/** Kamino main-market reserves (verified on-chain: market, liquidity mint, supply vault, cToken mint). */
export const KAMINO_RECEIPTS: readonly KaminoReceipt[] = [
  receipt("SOL", "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q", "GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U", "2UywZrUdyqs5vDchy7fKQJKau2RVyuzBev2XKGPDSiX1"),
  receipt("USDC", "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59", "Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6", "B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D"),
  receipt("USDT", "H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S", "2Eff8Udy2G2gzNcf2619AnTx3xM4renEv4QrHKjS1o9N", "B8zf4kojJbwgCRKA7rLaLhRCZBGhgAJp8wPBVZZHMhSv"),
  receipt("JitoSOL", "EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpV3KYjKsktW", "6sga1yRArgQRqa8Darhm54EBromEpV3z8iDAvMTVYXB3", "9ucQp7thL38MDDTSER5ou24QnVSTZFLevDsZC1cAFkKy"),
  receipt("JupSOL", "DGQZWCY17gGtBUgdaFs1VreJWsodkjFxndPsskwFKGpp", "FbbgvvnwfN25cyX52Zqut2ZTbtvCWZbhKS177gfdUd6K", "8euYpQt56z9hA2ZcFCQuWK6gAptrLcJuMZ5PtMpUwbuY"),
];

export function receiptForUnderlying(symbol: string): KaminoReceipt | undefined {
  return KAMINO_RECEIPTS.find((r) => r.underlying === symbol);
}

export function receiptByMint(mint: PublicKey | string): KaminoReceipt | undefined {
  const key = typeof mint === "string" ? mint : mint.toBase58();
  return KAMINO_RECEIPTS.find((r) => r.collateralMint.toBase58() === key);
}

export function receiptByReserve(reserve: PublicKey | string): KaminoReceipt | undefined {
  const key = typeof reserve === "string" ? reserve : reserve.toBase58();
  return KAMINO_RECEIPTS.find((r) => r.reserve.toBase58() === key);
}

// ---------------------------------------------------------------------------------------------
// cToken valuation — exact port of `adapters/kamino.rs::read_reserve_rate`
// ---------------------------------------------------------------------------------------------

/** sha256("account:Reserve")[0..8] */
const RESERVE_DISCRIMINATOR = Buffer.from([43, 242, 204, 202, 26, 247, 59, 127]);
const RESERVE_LEN = 8624;
const RESERVE_VERSION = 1n;

export interface ReserveRate {
  liquidityMint: PublicKey;
  /** Decimals of the underlying (cTokens are always 6). */
  liquidityDecimals: number;
  /** Liquidity owed to cToken holders, underlying base units. */
  totalLiquidity: bigint;
  collateralSupply: bigint;
}

const u128At = (d: Buffer, i: number) => d.readBigUInt64LE(i) + (d.readBigUInt64LE(i + 8) << 64n);

/**
 * Reads a klend Reserve the same way the program does (fails closed on an unexpected layout):
 * total_liquidity = available + borrowed − protocol fees − referrer fees − pending referrer fees
 * (`_sf` fields carry 60 fractional bits).
 */
export function readReserveRate(data: Buffer, collateralMint: PublicKey): ReserveRate {
  if (data.length !== RESERVE_LEN || !data.subarray(0, 8).equals(RESERVE_DISCRIMINATOR)) {
    throw new Error("Unexpected Kamino reserve layout");
  }
  if (!data.subarray(2560, 2592).equals(collateralMint.toBuffer())) throw new Error("Kamino reserve / cToken mint mismatch");
  if (data.readBigUInt64LE(8) !== RESERVE_VERSION) throw new Error("Unsupported Kamino reserve version");
  const totalSf = (data.readBigUInt64LE(224) << 60n) + u128At(data, 232) - u128At(data, 344) - u128At(data, 360) - u128At(data, 376);
  return {
    liquidityMint: new PublicKey(data.subarray(128, 160)),
    liquidityDecimals: Number(data.readBigUInt64LE(272)),
    totalLiquidity: totalSf >> 60n,
    collateralSupply: data.readBigUInt64LE(2592),
  };
}

/** underlying = floor(receipts × total_liquidity / collateral_supply) — same rounding as on-chain. */
export function underlyingForReceipts(rate: ReserveRate, receipts: bigint): bigint {
  if (receipts === 0n || rate.collateralSupply === 0n) return 0n;
  return mulDivFloor(receipts, rate.totalLiquidity, rate.collateralSupply);
}

/** receipts = floor(underlying × collateral_supply / total_liquidity). */
export function receiptsForUnderlying(rate: ReserveRate, underlying: bigint): bigint {
  if (underlying === 0n || rate.totalLiquidity === 0n) return 0n;
  return mulDivFloor(underlying, rate.collateralSupply, rate.totalLiquidity);
}

// ---------------------------------------------------------------------------------------------
// margin_execute call data / accounts (KaminoLend adapter: exactly 12 accounts, 16 data bytes)
// ---------------------------------------------------------------------------------------------

/** sha256("global:deposit_reserve_liquidity")[0..8] */
const DEPOSIT_RESERVE_LIQUIDITY = Buffer.from([169, 201, 30, 126, 6, 205, 102, 68]);
/** sha256("global:redeem_reserve_collateral")[0..8] */
const REDEEM_RESERVE_COLLATERAL = Buffer.from([234, 117, 181, 125, 185, 142, 220, 29]);

export type KaminoAction = "deposit" | "redeem";

export function kaminoCallData(action: KaminoAction, amount: bigint): Buffer {
  const data = Buffer.alloc(16);
  (action === "deposit" ? DEPOSIT_RESERVE_LIQUIDITY : REDEEM_RESERVE_COLLATERAL).copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  return data;
}

/**
 * klend's account order for the two allowed calls. The margin PDA is the `owner` (signed by the
 * program via invoke_signed, so it is NOT a signer here); `underlyingVault` / `receiptVault` are the
 * margin account's ATAs.
 */
export function kaminoCallAccounts(
  action: KaminoAction,
  r: KaminoReceipt,
  margin: PublicKey,
  underlyingVault: PublicKey,
  receiptVault: PublicKey,
): AccountMeta[] {
  const underlying: TokenInfo = getToken(r.underlying);
  const m = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({ pubkey, isSigner: false, isWritable });
  const tail = [m(TOKEN_PROGRAM_ID, false), m(underlying.tokenProgram, false), m(INSTRUCTIONS_SYSVAR, false)];
  if (action === "deposit") {
    return [
      m(margin, true),
      m(r.reserve, true),
      m(r.market, false),
      m(r.marketAuthority, false),
      m(underlying.mint, false),
      m(r.liquidityVault, true),
      m(r.collateralMint, true),
      m(underlyingVault, true),
      m(receiptVault, true),
      ...tail,
    ];
  }
  return [
    m(margin, true),
    m(r.market, false),
    m(r.reserve, true),
    m(r.marketAuthority, false),
    m(underlying.mint, false),
    m(r.collateralMint, true),
    m(r.liquidityVault, true),
    m(receiptVault, true),
    m(underlyingVault, true),
    ...tail,
  ];
}
