'use client';

import { fetchWithTimeout } from "../lib/async";

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TOKENS, findToken } from '@/lib/solana/tokens';

export interface PriceEntry {
  usd: number | null;
  publishTime: number | null;
  ageSecs: number | null;
  stale: boolean;
  account: string;
  /** Where the oracle reads the price (e.g. "pyth", "scope"), as /api/prices reports it. */
  source?: string | null;
}

export const PRICES_QUERY_KEY = ['oracle', 'prices'] as const;

/** Fetches every registry token's on-chain (fork Pyth) price from GET /api/prices. */
export async function fetchPrices(): Promise<Record<string, PriceEntry>> {
  const res = await fetchWithTimeout('/api/prices', { cache: 'no-store' });
  if (!res.ok) throw new Error(`prices failed (${res.status})`);
  const body = (await res.json()) as { prices: Record<string, PriceEntry> };
  return body.prices;
}

/** Raw price entries (with staleness) for every registry token. Refreshed on each slot tick (components/tick-refresh.tsx). */
export function usePriceEntries() {
  return useQuery({ queryKey: PRICES_QUERY_KEY, queryFn: fetchPrices, staleTime: 5_000 });
}

/**
 * USD price map for the requested symbols (keys: the symbol as given, its registry symbol and
 * its UPPERCASE form). Unknown / not-yet-loaded prices are 0 — never a made-up fallback.
 */
export function useTokenPrices(tokens: string[] = TOKENS.map((t) => t.symbol)): Record<string, number> {
  const { data } = usePriceEntries();
  const key = tokens.join(',');
  return useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of key ? key.split(',') : []) {
      const token = findToken(t);
      const usd = token ? (data?.[token.symbol]?.usd ?? 0) : 0;
      out[t] = usd;
      if (token) {
        out[token.symbol] = usd;
        out[token.symbol.toUpperCase()] = usd;
      }
    }
    return out;
  }, [data, key]);
}

/** Single-symbol convenience wrapper. */
export function useTokenPrice(token: string): number {
  return useTokenPrices([token])[token] ?? 0;
}
