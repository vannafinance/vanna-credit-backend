"use client";

/**
 * Data hooks for the Risk Analytics screens. UI components never call fetch themselves and never
 * compute financial figures: they read these hooks. The server owns scanning and refreshing; the
 * browser only polls its already-computed snapshots, at a calm pace.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchWithTimeout } from "@/lib/async";
import type { AccountFilter, AccountSortKey, AccountsSummary, AccountView, Coverage } from "@/lib/analytics/types";
import type { Standing } from "@/lib/analytics/risk";
import type { ActivityResponse } from "@/app/api/analytics/accounts/[owner]/activity/route";
import type { ProtocolOverview, StoreState } from "@/lib/analytics/server/store";
import type { ProgramEvent } from "@/lib/analytics/server/events";

const POLL_MS = 15_000;
const WARM_POLL_MS = 3_000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithTimeout(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`analytics request failed (${res.status})`);
  return (await res.json()) as T;
}

export interface SummaryResponse {
  state: StoreState;
  asOf: number | null;
  forkTime: number | null;
  coverage: Coverage | null;
  summary: AccountsSummary | null;
}

/** Aggregates over every account found. Polls fast while the server is still warming up. */
export function useAnalyticsSummary() {
  return useQuery({
    queryKey: ["analytics", "summary"],
    queryFn: () => getJson<SummaryResponse>("/api/analytics/summary"),
    refetchInterval: (q) => (q.state.data?.state.status === "ready" && q.state.data.coverage?.complete ? POLL_MS : WARM_POLL_MS),
    staleTime: 2_000,
  });
}

export interface AccountsQuery {
  filter: AccountFilter;
  sort: AccountSortKey;
  dir: "asc" | "desc";
  q: string;
  page: number;
  per: number;
  band: string | null;
  /** Connected wallet, so the server can return its row and rank. */
  you: string | null;
}

export interface AccountsResponse {
  state: StoreState;
  asOf: number | null;
  forkTime?: number;
  rows: AccountView[];
  /** The connected wallet's own account (pinned by the UI) and its real rank in the current list. */
  you: { row: AccountView; rank: number | null } | null;
  total: number;
  filteredTotal: number;
  page: number;
  per: number;
  pages: number;
  filterCounts: Record<AccountFilter, number> | null;
}

/** One page of accounts; the server filters, sorts and pages (the list can grow to thousands). */
export function useAnalyticsAccounts(query: AccountsQuery) {
  const p = new URLSearchParams({ filter: query.filter, sort: query.sort, dir: query.dir, q: query.q, page: String(query.page), per: String(query.per) });
  if (query.band) p.set("band", query.band);
  if (query.you) p.set("you", query.you);
  return useQuery({
    queryKey: ["analytics", "accounts", p.toString()],
    queryFn: () => getJson<AccountsResponse>(`/api/analytics/accounts?${p}`),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.state.status === "ready" ? POLL_MS : WARM_POLL_MS),
    staleTime: 2_000,
  });
}

export function useAnalyticsProtocol() {
  return useQuery({
    queryKey: ["analytics", "protocol"],
    queryFn: () => getJson<ProtocolOverview>("/api/analytics/protocol"),
    refetchInterval: POLL_MS,
    staleTime: 5_000,
  });
}

/** Look a wallet up on demand (adds it to the server's snapshot). */
export async function lookupWallet(owner: string): Promise<AccountView> {
  const res = await fetchWithTimeout(`/api/analytics/accounts/${encodeURIComponent(owner)}`, { cache: "no-store" });
  const body = (await res.json()) as { row?: AccountView; error?: string };
  if (!res.ok || !body.row) throw new Error(body.error ?? "Lookup failed");
  return body.row;
}

export interface EventsResponse {
  state: StoreState;
  coverage: Coverage | null;
  forkTime: number | null;
  counts: Record<string, number>;
  events: ProgramEvent[];
}

/** Program events (liquidations, borrows, repayments, deposits…) from the transactions the server has scanned. */
export function useAnalyticsEvents(names: string[], limit = 50) {
  const p = new URLSearchParams({ names: names.join(","), limit: String(limit) });
  return useQuery({
    queryKey: ["analytics", "events", p.toString()],
    queryFn: () => getJson<EventsResponse>(`/api/analytics/events?${p}`),
    refetchInterval: (q) => (q.state.data?.state.status === "ready" ? POLL_MS : WARM_POLL_MS),
    staleTime: 2_000,
  });
}

/** The connected wallet's own margin account (null when it has none or no wallet is connected). */
export function useMyAccount(owner: string | null) {
  return useQuery({
    queryKey: ["analytics", "me", owner],
    enabled: !!owner,
    queryFn: async () => { try { return await lookupWallet(owner!); } catch { return null; } },
    refetchInterval: POLL_MS,
    staleTime: 5_000,
  });
}

export interface ScenarioBaseline {
  asOf: number;
  forkTime: number;
  coverage: Coverage;
  covered: Array<{ owner: string; address: string; collateral: AccountView["collateral"]; debts: AccountView["debts"]; collateralUsd: number | null; debtUsd: number | null }>;
  excluded: Array<{ owner: string; address: string; reasons: AccountView["reasons"]; venueHeld: boolean }>;
}

/** The saved baseline the What-if Calculator runs on. Fetched only when that page is open; fixed once loaded until refreshed by hand. */
export function useScenarioBaseline() {
  return useQuery({
    queryKey: ["analytics", "scenario-input"],
    queryFn: () => getJson<{ state: StoreState; baseline: ScenarioBaseline | null }>("/api/analytics/scenario-input"),
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

export interface AccountResponse { row: AccountView; standing: Standing }

/** One account for its own page (`address` is the margin account address or the wallet). A missing account is an error with the server's message. */
export function useAccountPage(address: string) {
  return useQuery({
    queryKey: ["analytics", "account", address],
    queryFn: async (): Promise<AccountResponse> => {
      const res = await fetchWithTimeout(`/api/analytics/accounts/${encodeURIComponent(address)}`, { cache: "no-store" });
      const body = (await res.json()) as Partial<AccountResponse> & { error?: string };
      if (!res.ok || !body.row || !body.standing) throw new Error(body.error ?? "Account could not be read");
      return { row: body.row, standing: body.standing };
    },
    retry: false,
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS,
    staleTime: 5_000,
  });
}

/** The account's real transactions (decoded program events), newest first. Read once and refreshed slowly. */
export function useAccountActivity(address: string) {
  return useQuery({
    queryKey: ["analytics", "account-activity", address],
    queryFn: () => getJson<ActivityResponse>(`/api/analytics/accounts/${encodeURIComponent(address)}/activity`),
    retry: false,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
