"use client";

// App-wide price context. Prices come from the fork's on-chain Pyth accounts (GET /api/prices).
// On mount — and every 20 minutes while the tab is open — it runs the fork price keeper
// (POST /api/prices/refresh) so the accounts stay inside every asset's 3600s max age.

import React, { createContext, useContext, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PRICES_QUERY_KEY, usePriceEntries } from "@/hooks/use-token-prices";
import { ensureFreshPrices } from "@/lib/solana/price-refresh";
import { findToken } from "@/lib/solana/tokens";

interface PriceContextValue {
  /** symbol → USD (0 when unknown). */
  prices: Record<string, number>;
  isLoading: boolean;
  lastUpdated: number | null;
  refresh: () => Promise<void>;
  getPrice: (asset: string) => number;
}

const PriceContext = createContext<PriceContextValue | undefined>(undefined);

const KEEPER_INTERVAL_MS = 20 * 60_000;

export const PriceProvider = ({ children }: { children: React.ReactNode }) => {
  const qc = useQueryClient();
  const query = usePriceEntries();

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (document.visibilityState === "hidden") return;
      return ensureFreshPrices()
        .then(() => {
          if (!cancelled) qc.invalidateQueries({ queryKey: PRICES_QUERY_KEY });
        })
        .catch((e) => console.warn("fork price refresh failed", e));
    };
    void run();
    const id = window.setInterval(run, KEEPER_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [qc]);

  const value = useMemo<PriceContextValue>(() => {
    const prices: Record<string, number> = {};
    for (const [symbol, entry] of Object.entries(query.data ?? {})) prices[symbol] = entry.usd ?? 0;
    return {
      prices,
      isLoading: query.isLoading,
      lastUpdated: query.dataUpdatedAt || null,
      refresh: async () => {
        await ensureFreshPrices(true);
        await qc.invalidateQueries({ queryKey: PRICES_QUERY_KEY });
      },
      getPrice: (asset: string) => {
        const t = findToken(asset);
        return t ? (prices[t.symbol] ?? 0) : 0;
      },
    };
  }, [query.data, query.isLoading, query.dataUpdatedAt, qc]);

  return <PriceContext.Provider value={value}>{children}</PriceContext.Provider>;
};

export const useTokenPrices = (): PriceContextValue => {
  const ctx = useContext(PriceContext);
  if (!ctx) throw new Error("useTokenPrices must be used within a PriceProvider");
  return ctx;
};

export const useTokenPrice = (asset: string): number => useTokenPrices().getPrice(asset);
