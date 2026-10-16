"use client";

import { fetchWithTimeout } from "../lib/async";
import { freshParam } from "@/lib/fresh-reads";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLedgerTick } from "@/contexts/ledger-subscriber";
import { useLiveTick } from "@/lib/tick-scope";
import type { SerializedMarginSnapshot } from "@/lib/solana/margin";
import type { LenderPosition } from "@/lib/solana/lend";
import { marginFieldsFromSnapshot, type MarginAccountInfoStateType } from "@/store/margin-account-info-store";

/** GET /api/account/:wallet payload. */
export interface AccountApiResponse {
  margin: SerializedMarginSnapshot;
  lender: Record<string, Omit<LenderPosition, "sharesRaw" | "assetsRaw"> & { sharesRaw: string; assetsRaw: string }>;
  wallet: { ui: Record<string, string>; wsol: string };
}

/**
 * Stellar-compatible account snapshot: the margin store's fields (hasMarginAccount,
 * collateralBalances, borrowedBalances, avgHealthFactor, …) plus the raw API payload.
 */
export type AccountSnapshot = Partial<MarginAccountInfoStateType> & {
  hasMarginAccount: boolean;
  marginAccountAddress?: string;
  api: AccountApiResponse;
};

// Nested under `margin` so every post-transaction invalidateQueries({ queryKey: ['margin'] })
// also refreshes this snapshot.
export const ACCOUNT_SNAPSHOT_KEY = ["margin", "account-snapshot"] as const;

async function fetchSnapshot(userAddress: string): Promise<AccountSnapshot> {
  const res = await fetchWithTimeout(`/api/account/${userAddress}${freshParam()}`, { cache: "no-store" });
  // 401 = the site access cookie expired or the code was rotated: reload so the access gate shows,
  // instead of the page sitting there with every read failing.
  if (res.status === 401 && typeof window !== "undefined") window.location.reload();
  if (!res.ok) throw new Error(`account snapshot failed (${res.status})`);
  const api = (await res.json()) as AccountApiResponse;
  const fields = marginFieldsFromSnapshot(api.margin);
  return { ...fields, hasMarginAccount: api.margin.exists, marginAccountAddress: api.margin.exists ? api.margin.address : undefined, api };
}

/**
 * Per-wallet account snapshot from GET /api/account/:wallet (always a live chain read — never
 * persisted client-side). Revalidated on slot ticks; mutations invalidate ['margin'].
 */
export function useAccountSnapshot(userAddress: string | null) {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const live = useLiveTick();
  const lastTickRef = useRef(tick);
  const query = useQuery<AccountSnapshot>({
    queryKey: [...ACCOUNT_SNAPSHOT_KEY, userAddress ?? "none"],
    queryFn: () => fetchSnapshot(userAddress!),
    enabled: Boolean(userAddress),
    staleTime: 5_000,
  });
  useEffect(() => {
    if (tick === lastTickRef.current) return;
    lastTickRef.current = tick;
    if (!live) return; // this page shows no account data (lib/tick-scope.ts)
    qc.invalidateQueries({ queryKey: ACCOUNT_SNAPSHOT_KEY }, { cancelRefetch: false });
  }, [tick, qc, live]);
  return {
    snapshot: query.data,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refresh: () => query.refetch(),
  };
}
