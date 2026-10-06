import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

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
  /** Token program that owns the mint: classic SPL, or Token-2022 for the xStocks. */
  tokenProgram: PublicKey;
  /**
   * Pyth price feed id (hex, no 0x). Reference only: the program now prices each asset from its
   * on-chain `OracleConfig` (see oracle.ts / prices.ts), not from this id. Empty for the xStocks,
   * which are priced from Kamino's Scope only.
   */
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
  /**
   * True = offered in the Margin page's collateral deposit pickers (Leverage "Deposit" and Transfer
   * Collateral "MB"). USDT stays lendable / borrowable and withdrawable, it just isn't offered as a
   * deposit. Every registered token can still be held, swapped and withdrawn.
   */
  depositable: boolean;
}

/**
 * xStocks (Backed Finance tokenized equities): Token-2022 mints, 8 decimals, collateral only, priced
 * per raw token by Kamino's Scope (Chainlink xStocks, which already applies the mint's Scaled-UI
 * multiplier). Amounts shown are raw token amounts, which differ from wallets that apply that
 * multiplier by well under 1%.
 */
const xStock = (symbol: string, name: string, mint: string): TokenInfo => ({
  symbol,
  name,
  mint: new PublicKey(mint),
  decimals: 8,
  tokenProgram: TOKEN_2022_PROGRAM_ID,
  pythFeedId: "",
  icon: `/coins/${symbol.toLowerCase()}.png`,
  isNative: false,
  faucetAmount: 10,
  lendable: false,
  depositable: true,
});

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
    depositable: true,
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
    depositable: true,
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
    depositable: false,
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
    depositable: true,
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
    depositable: true,
  },
  {
    symbol: "JupUSD",
    name: "Jupiter USD",
    mint: new PublicKey("JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD"),
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
    pythFeedId: "8ed858a2214e892c9371694fb6c8a9037b6ed4052c4edf209f8cb988484e81d9",
    icon: "/coins/jupusd.png",
    isNative: false,
    faucetAmount: 1000,
    lendable: false,
    depositable: true,
  },
  xStock("NVDAx", "NVIDIA xStock", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"),
  xStock("GOOGLx", "Alphabet xStock", "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN"),
  xStock("AAPLx", "Apple xStock", "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"),
  xStock("TSLAx", "Tesla xStock", "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB"),
] as const;

/** Every registered UI symbol, in registry order. */
export const TOKEN_SYMBOLS: readonly string[] = TOKENS.map((t) => t.symbol);

/** Tokens with an Earn pool the app offers — also the only tokens the Margin page lets you borrow. */
export const LENDING_TOKENS: readonly TokenInfo[] = TOKENS.filter((t) => t.lendable);
export const LENDING_SYMBOLS: readonly string[] = LENDING_TOKENS.map((t) => t.symbol);

/** Tokens offered as a Margin collateral deposit (see `TokenInfo.depositable`). */
export const DEPOSIT_SYMBOLS: readonly string[] = TOKENS.filter((t) => t.depositable).map((t) => t.symbol);

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
