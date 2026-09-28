"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLedgerTick } from "@/contexts/ledger-subscriber";
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
  const res = await fetch(`/api/account/${userAddress}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`account snapshot failed (${res.status})`);
  const api = (await res.json()) as AccountApiResponse;
  const fields = marginFieldsFromSnapshot(api.margin);
  return { ...fields, hasMarginAccount: api.margin.exists, marginAccountAddress: api.margin.exists ? api.margin.address : undefined, api };
}

/** Warm the snapshot as soon as the wallet connects (best effort). */
export async function prefetchAccountSnapshot(qc: QueryClient, userAddress: string | null): Promise<void> {
  if (!userAddress) return;
  await qc
    .prefetchQuery({ queryKey: [...ACCOUNT_SNAPSHOT_KEY, userAddress], queryFn: () => fetchSnapshot(userAddress), staleTime: 5_000 })
    .catch(() => {});
}

/**
 * Per-wallet account snapshot from GET /api/account/:wallet (always a live chain read — never
 * persisted client-side). Revalidated on slot ticks; mutations invalidate ['margin'].
 */
export function useAccountSnapshot(userAddress: string | null) {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
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
    qc.invalidateQueries({ queryKey: ACCOUNT_SNAPSHOT_KEY });
  }, [tick, qc]);
  return {
    snapshot: query.data,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refresh: () => query.refetch(),
  };
}
