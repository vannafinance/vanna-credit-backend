"use client";

/**
 * One read model for the Earn V3 screens: live pools (GET /api/pools), the wallet's lender
 * positions, its supply / withdraw history and earned interest (decoded on-chain events), oracle
 * prices, and the chart series built from them (./earn-series). Everything comes from the existing
 * hooks in hooks/use-earn.ts — nothing is stored in the browser.
 */
import { useMemo } from "react";
import { useUserStore } from "@/store/user";
import { usePoolData, useUserPositions, useEarnTransactions } from "@/hooks/use-earn";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { TOKENS, TOKEN_SYMBOLS } from "@/lib/solana/tokens";
import { POSITION_DUST, sumEarnedUsd } from "@/components/earn/earn-utils";
import { buildSeries, flatSeries, type SeriesInput, type SeriesPoint, type Tf } from "./earn-series";

/** Live Earn data for the connected wallet (or the public pool data when disconnected). */
export function useEarnV3() {
  const address = useUserStore((s) => s.address);
  const { pools, isLoading: poolsLoading } = usePoolData();
  const { positions } = useUserPositions();
  const { transactions, history, earned, isLoading: historyLoading } = useEarnTransactions();
  const prices = useTokenPrices([...TOKEN_SYMBOLS]);

  /** Supplied value per symbol (UI units, interest included), dust filtered. */
  const supplied = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of TOKENS) {
      const a = positions[t.symbol]?.assets ?? 0;
      out[t.symbol] = a > POSITION_DUST ? a : 0;
    }
    return out;
  }, [positions]);

  /** Overall Deposit headline: Σ supplied × oracle price (assets without a price can't be valued). */
  const depositUsd = useMemo(() => TOKENS.reduce((s, t) => s + supplied[t.symbol] * (prices[t.symbol] ?? 0), 0), [supplied, prices]);
  const depositMissingPrice = TOKENS.filter((t) => supplied[t.symbol] > 0 && !(prices[t.symbol] > 0)).map((t) => t.symbol);

  /** Net Earnings headline (null = can't be proven from history; never shown as $0). */
  const earnedSummary = useMemo(() => sumEarnedUsd(earned, prices), [earned, prices]);

  const seriesInput = useMemo<SeriesInput>(
    () => ({
      rows: transactions,
      earned,
      positions,
      xr: Object.fromEntries(Object.entries(pools).map(([k, p]) => [k, p.exchangeRate])),
      prices,
      decimals: Object.fromEntries(TOKENS.map((t) => [t.symbol, t.decimals])),
    }),
    [transactions, earned, positions, pools, prices],
  );

  /**
   * Chart clock: the fork's clock (the pools' projection time, which also stamps the events), or
   * the newest event if that is later. Using the chain clock keeps "now" consistent with the
   * event timestamps even when the fork runs ahead of / behind this browser.
   */
  const now = useMemo(() => {
    const fork = Math.max(0, ...Object.values(pools).map((p) => (p.forkTimestamp ?? 0) * 1000));
    return Math.max(fork, ...transactions.map((r) => r.timestamp), 1);
  }, [pools, transactions]);

  return { address, pools, poolsLoading, positions, supplied, transactions, history, historyLoading, earned, prices, depositUsd, depositMissingPrice, earnedSummary, seriesInput, now };
}

/**
 * Value ("dep" / "my") or earned ("net") series over `tf` for `syms`. Falls back to a flat line at
 * the live value when the history can't reconstruct the past for some asset (`partial` lists them).
 */
export function seriesFor(
  kind: "dep" | "net",
  tf: Tf,
  syms: readonly string[],
  inp: SeriesInput,
  now: number,
  liveValue: number | null,
): { pts: SeriesPoint[]; excluded: string[] } {
  // Pools not loaded yet: no clock / exchange rates to build from.
  if (now < 1e12) return { pts: [], excluded: [] };
  const r = buildSeries(kind, tf, syms, inp, now);
  if (kind === "dep" && !r.complete) return { pts: liveValue && liveValue > 0 ? flatSeries(tf, liveValue, now) : [], excluded: r.excluded };
  return { pts: r.pts, excluded: r.excluded };
}
