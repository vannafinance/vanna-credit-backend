import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

/**
 * THE token registry — the single source of truth for every asset the app knows about.
 * Every page, store, hook and service iterates this list; nothing may hardcode a pair
 * of assets (past bugs came from hardcoded "XLM + USDC" assumptions).
 *
 * `symbol` is the UI symbol (SOL, not wSOL). The on-chain asset for SOL is the wSOL mint;
 * the app wraps/unwraps native SOL around every wallet-side SOL transfer.
 */
export interface TokenInfo {
  /** UI symbol, also the key used in stores/balances maps. */
  symbol: string;
  name: string;
  mint: PublicKey;
  decimals: number;
  /** SPL Token program that owns the mint (classic SPL for all five today). */
  tokenProgram: PublicKey;
  /** Pyth price feed id (hex, no 0x). JupSOL's is a synthetic sentinel with no Hermes feed. */
  pythFeedId: string;
  /** Path under /public. */
  icon: string;
  /** True for SOL: wallet balance is native lamports, on-chain asset is wSOL. */
  isNative: boolean;
  /** Faucet top-up per click, in UI units. */
  faucetAmount: number;
  /**
   * True = has an Earn lending pool the app offers and can be BORROWED on the Margin page.
   * False = collateral-only in the app (deposit into the margin account, swap, farm on Kamino),
   * e.g. the liquid-staking tokens.
   */
  lendable: boolean;
}

export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export const TOKENS: readonly TokenInfo[] = [
  {
    symbol: "SOL",
    name: "Solana",
    mint: WSOL_MINT,
    decimals: 9,
    tokenProgram: TOKEN_PROGRAM_ID,
    pythFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    icon: "/coins/sol.png",
    isNative: true,
    faucetAmount: 1000,
    lendable: true,
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
    pythFeedId: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
    icon: "/coins/usdc.png",
    isNative: false,
    faucetAmount: 1000,
    lendable: true,
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    mint: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
    pythFeedId: "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
    icon: "/coins/usdt.svg",
    isNative: false,
    faucetAmount: 1000,
    lendable: true,
  },
  {
    symbol: "JitoSOL",
    name: "Jito Staked SOL",
    mint: new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
    decimals: 9,
    tokenProgram: TOKEN_PROGRAM_ID,
    pythFeedId: "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb",
    icon: "/coins/jitosol.png",
    isNative: false,
    faucetAmount: 1000,
    lendable: false,
  },
  {
    symbol: "JupSOL",
    name: "Jupiter Staked SOL",
    mint: new PublicKey("jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v"),
    decimals: 9,
    tokenProgram: TOKEN_PROGRAM_ID,
    pythFeedId: "6cf9d0108cc803dded4edde0a18ad3b01cfca1a3f89c1f3a65f9c5a2a6ccc0c1",
    icon: "/coins/jupsol.png",
    isNative: false,
    faucetAmount: 1000,
    lendable: false,
  },
] as const;

/** Every registered UI symbol, in registry order. */
export const TOKEN_SYMBOLS: readonly string[] = TOKENS.map((t) => t.symbol);

/** Tokens with an Earn pool the app offers — also the only tokens the Margin page lets you borrow. */
export const LENDING_TOKENS: readonly TokenInfo[] = TOKENS.filter((t) => t.lendable);
export const LENDING_SYMBOLS: readonly string[] = LENDING_TOKENS.map((t) => t.symbol);

const BY_UPPER_SYMBOL = new Map(TOKENS.map((t) => [t.symbol.toUpperCase(), t]));
const BY_MINT = new Map(TOKENS.map((t) => [t.mint.toBase58(), t]));

/** Case-insensitive symbol lookup; also accepts "WSOL" for SOL. Returns undefined when unknown. */
export function findToken(symbol: string | null | undefined): TokenInfo | undefined {
  if (!symbol) return undefined;
  const upper = symbol.trim().toUpperCase();
  return BY_UPPER_SYMBOL.get(upper === "WSOL" ? "SOL" : upper);
}

/** Like {@link findToken} but throws for an unknown symbol. */
export function getToken(symbol: string): TokenInfo {
  const token = findToken(symbol);
  if (!token) throw new Error(`Unknown token "${symbol}". Supported: ${TOKEN_SYMBOLS.join(", ")}`);
  return token;
}

export function tokenByMint(mint: PublicKey | string): TokenInfo | undefined {
  return BY_MINT.get(typeof mint === "string" ? mint : mint.toBase58());
}

/** Canonical UI symbol for any accepted spelling ("sol", "wSOL", "jitosol" → "SOL", "JitoSOL"). */
export function canonicalSymbol(symbol: string): string {
  return findToken(symbol)?.symbol ?? symbol;
}

export function tokenIcon(symbol: string): string {
  return findToken(symbol)?.icon ?? "/coins/default.svg";
}

/** A zero-filled `{ SYMBOL: "0" }` map over the whole registry. */
export function emptyBalanceMap(): Record<string, string> {
  return Object.fromEntries(TOKENS.map((t) => [t.symbol, "0"]));
}
