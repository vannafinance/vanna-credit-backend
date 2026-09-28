import { TOKENS, tokenByMint, type TokenInfo } from "@/lib/solana/tokens";
import type { Token } from "./types";

/**
 * The swap UI's token list, built from THE token registry (lib/solana/tokens.ts) — never a
 * hardcoded pair. `id` is the mint (base58), which is what Jupiter quotes/routes key on.
 */
export function toSwapToken(t: TokenInfo): Token {
  return {
    id: t.mint.toBase58(),
    symbol: t.symbol,
    name: t.name,
    logo: t.icon,
    decimals: t.decimals,
    chain: "solana",
    isNative: t.isNative,
    isVerified: true,
  };
}

export const SWAP_TOKENS: Token[] = TOKENS.map(toSwapToken);

/**
 * Display token for a mint that appears inside a Jupiter route. Registry mints map to their
 * registry token; an intermediate hop through a non-registry mint shows its shortened address
 * (honest — we don't know its symbol without a token-list lookup).
 */
export function routeTokenForMint(mint: string | undefined): Token {
  const known = mint ? tokenByMint(mint) : undefined;
  if (known) return toSwapToken(known);
  const short = mint ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : "?";
  return { id: mint ?? "unknown", symbol: short, name: mint ?? "Unknown mint", logo: null, decimals: 0, chain: "solana" };
}
