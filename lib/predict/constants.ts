/**
 * Predict (World.xyz prediction markets) on-chain constants. Client-safe: no secrets, no Node APIs.
 *
 * World's market program `prediCt` holds each market's CASH in a vault and mints / burns the
 * market's YES and NO outcome tokens (Token-2022). `split` and `merge` are permissionless: any
 * wallet can turn N CASH into N YES + N NO and back. Every address below is a MAINNET address;
 * the hosted Surfpool fork clones each account lazily the first time a transaction touches it.
 *
 * Ported from Backend-Solana-v2 `lib/world/constants.ts` (verified there against mainnet on
 * 2026-09-27) plus the `Group` account layout decoded for event grouping (2026-10-10).
 */

export const WORLD_PROGRAM_ID = "prediCtPZCttYMvm2W3PtxmMxLmT1dtN7riU6Cxh6tM";

/** CASH: the Token-2022 stablecoin every World market is collateralised in. */
export const CASH_MINT = "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH";
export const CASH_DECIMALS = 6;
/** YES / NO outcome tokens use the same 6 decimals as CASH (1 winning token redeems 1 CASH). */
export const OUTCOME_DECIMALS = 6;
/** outcome_yield_pool share mints use 9 decimals (extra precision for the share / asset rate). */
export const POOL_SHARE_DECIMALS = 9;

export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** World's market makers. Their mainnet fills are the source of the prices shown in the app. */
export const JANUS_MAKER_PROGRAM = "JanusXpm3gsW3c9ErNoUgHppL8dGLvZKB7uekkJEYFP";
export const BISON_MAKER_PROGRAM = "2DNbzPochEcyCcWMbL4d9S3u9QqQEj5bbe6cSZFvKsbh";
/** BisonFI's treasury appears in every BisonFI fill, so its signatures list only trades. */
export const BISON_TREASURY = "7ZqA8dqjSE95wa6Nr2hSigwJ4bYLALjzjSjcSBFo7TCR";

/** World `Market` account: 320 bytes, fixed offsets (verified on mainnet 2026-09-27). */
export const MARKET_ACCOUNT_SIZE = 320;
/** Anchor discriminator sha256("account:Market")[..8]. */
export const MARKET_DISCRIMINATOR_HEX = "dbbed53700e3c69a";
export const MARKET_OFFSETS = {
  cashMint: 40,
  yesMint: 72,
  noMint: 104,
  vault: 136,
  /** Resolution kind byte: 1 = Pyth price window (Up / Down), 4 = F1 data feed, 2/3 = World Cup feed, 5 = World resolver. */
  resolutionKind: 224,
  /** Up / Down windows only: the 32-byte Pyth feed id the window resolves against. */
  feedId: 226,
  /** Crypto "Up or Down" windows store start / end in milliseconds; other markets leave 0. */
  startMs: 258,
  endMs: 266,
} as const;

/**
 * World `Group` account (Anchor discriminator sha256("account:Group")[..8]): World's own set of
 * mutually exclusive markets, e.g. a soccer match's home / draw / away or every candidate of a
 * nomination. Layout decoded from all 385 groups on mainnet (2026-10-10):
 *   0  discriminator (8)
 *   8  authority (32)          — same authority as the markets
 *   40 collateral mint (32)    — CASH
 *   72 group CASH vault (32)   — a Token-2022 account
 *   104 u64 seed, 112 u8 bump, 113 u16 (0 or 10_000), 115..119 padding
 *   119 u32 member count, then members of 36 bytes: market pubkey (32) + u32 (always 0 so far)
 * No market account points back at its group, so groups are read separately and inverted.
 */
export const GROUP_DISCRIMINATOR_HEX = "d1f9d03fb659bafe";
export const GROUP_OFFSETS = { collateralMint: 40, memberCount: 119, members: 123 } as const;
export const GROUP_MEMBER_SIZE = 36;

/** Anchor discriminators sha256("global:<name>")[..8] of prediCt's complete-set instructions. */
export const SPLIT_DISCRIMINATOR = [0x7c, 0xbd, 0x1b, 0x2b, 0xd8, 0x28, 0x93, 0x42];
export const MERGE_DISCRIMINATOR = [0x94, 0x8d, 0xec, 0x2f, 0xae, 0x7e, 0x45, 0x6f];

/**
 * outcome_yield_pool (source: vannafinance-vanna_prediction_earn_vault), deployed on the hosted
 * fork. Deposited YES/NO tokens are merged into CASH by a keeper, swapped to USDC (Jupiter,
 * Manifest only) and lent into Vanna's USDC reserve on the core lending program (H37…).
 * Only markets the program admin allowlisted (`allow_market`) can have a pool; the allowlist is
 * read from chain (AllowedMarket PDAs), never hardcoded.
 */
export const OUTCOME_POOL_PROGRAM_ID = "4kFzca1u9TUAVK7BjJZ5vVtfJ2QRATs38vN8Bq6qZwG3";
export const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** Same VIRTUAL_ASSETS / VIRTUAL_SHARES offsets as programs/outcome_yield_pool/src/math.rs. */
export const POOL_VIRTUAL_ASSETS = 1n;
export const POOL_VIRTUAL_SHARES = 1_000n;

/** Trade limits (CASH, UI units) for one leg. */
export const MAX_TRADE_CASH = 5_000;
export const MIN_TRADE_CASH = 0.1;
/** Most legs one trade request may carry (one wallet approval for all of them). */
export const MAX_TRADE_LEGS = 8;
