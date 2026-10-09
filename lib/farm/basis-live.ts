"use client";

/**
 * Live adapters for the V3 Farm vault pages (Basis /farm/basis/:id and Perena /farm/perena/:id).
 *
 * Sources — nothing here is sampled or invented:
 * - vault state: GET /api/farm/vaults (fork reads, `useVaults`): NAV, share price, cap, legs, Phoenix margin;
 * - share-price history: GET /api/farm/vaults/history (hourly observations recorded by the server);
 * - funding: GET /api/farm/funding (Phoenix mainnet hourly rates, 90 days) and, for "now", Phoenix's
 *   public WebSocket `market` channel (the same feed the Perps terminal uses);
 * - the wallet's position: its margin account's receipt balance and its on-chain vault history.
 *
 * Figures that need more history than exists come back as null; the pages render those as the zero
 * form ("0.00%"), per the app-wide no-placeholder rule.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchWithTimeout } from "../async";
import { useMarginHistory } from "@/hooks/use-margin";
import { VAULTS, type VaultDefinition } from "@/lib/solana/vault-catalogue";
import type { LiveVault } from "@/lib/solana/vault-state";
import type { MarginHistoryRow } from "@/lib/solana/history";
import { useVaults, useVaultAccount } from "./use-vaults";
import {
  HOURS_PER_YEAR,
  dailyApy,
  dailySamples,
  fundingStats,
  navStats,
  shortLiquidationRise,
  type DayPoint,
  type FundingDay,
  type FundingResponse,
  type FundingStats,
  type NavPoint,
  type NavStats,
} from "./nav-math";

/** /farm/basis/sol → "basis-sol"; the route segment of a catalogue id. */
export const vaultHref = (id: string) => (id.startsWith("basis-") ? `/farm/basis/${id.slice(6)}` : `/farm/perena/${id.slice(7)}`);

/** Recorded hourly share-price observations of one vault. */
export function useVaultHistory(id: string) {
  const q = useQuery({
    queryKey: ["farm", "vault-history", id],
    enabled: VAULTS.some((v) => v.id === id),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<NavPoint[]> => {
      const r = await fetchWithTimeout(`/api/farm/vaults/history?id=${id}`);
      if (!r.ok) throw new Error("Vault history is unavailable");
      return ((await r.json()) as { points: NavPoint[] }).points;
    },
  });
  return { points: q.data ?? [], isLoading: q.isLoading };
}

/** Phoenix funding history (daily, annualised) for a perp market. */
export function useFundingHistory(symbol: string | null) {
  const q = useQuery({
    queryKey: ["farm", "funding", symbol],
    enabled: Boolean(symbol),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    queryFn: async (): Promise<FundingResponse> => {
      const r = await fetchWithTimeout(`/api/farm/funding?symbol=${symbol}`);
      if (!r.ok) throw new Error("Phoenix funding is unavailable");
      return r.json();
    },
  });
  return q.data ?? null;
}

/**
 * Current hourly funding (%) per Phoenix market from the public WebSocket's `market` channel only
 * (no book / trades / candles). Empty until the first message; callers fall back to the latest
 * published hourly rate from {@link useFundingHistory}.
 */
export function usePhoenixFundingNow(symbols: string[]): Record<string, number> {
  const [now, setNow] = useState<Record<string, number>>({});
  const key = symbols.join(",");
  useEffect(() => {
    if (!key || typeof WebSocket === "undefined") return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      ws = new WebSocket("wss://perp-api.phoenix.trade/v1/ws");
      ws.onopen = () => {
        retry = 0;
        for (const symbol of key.split(",")) ws?.send(JSON.stringify({ type: "subscribe", subscription: { channel: "market", symbol } }));
      };
      ws.onmessage = (event) => {
        try {
          const m = JSON.parse(String(event.data)) as { channel?: string; symbol?: string; funding?: unknown };
          const f = Number(m.funding);
          if (m.channel === "market" && m.symbol && Number.isFinite(f)) setNow((prev) => (prev[m.symbol!] === f ? prev : { ...prev, [m.symbol!]: f }));
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        retry += 1;
        timer = setTimeout(connect, Math.min(15_000, 1_000 * 2 ** Math.min(retry, 4)));
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [key]);
  return now;
}

/** Annualised "Funding Now" (%) for a market: live WebSocket rate, else the latest published hourly rate. */
export function fundingNowApr(symbol: string, live: Record<string, number>, history: FundingResponse | null): number | null {
  const hourly = live[symbol] ?? history?.lastHourlyPct ?? null;
  return hourly === null ? null : hourly * HOURS_PER_YEAR;
}

/** The wallet's own position in a vault: receipt balance, value now, its vault history and earnings. */
export interface VaultPosition {
  shares: number;
  sharesRaw: bigint;
  valueUsd: number;
  /** This vault's deposit / withdraw rows from the margin account's on-chain history, newest first. */
  rows: MarginHistoryRow[];
  /**
   * Value now minus net USDC deposited (deposits − withdrawals). Null when the history scan is
   * incomplete or has no rows for a position that exists (the cost basis is unknown).
   */
  earnedUsd: number | null;
  /** Oldest deposit in the scanned history, unix ms. */
  since: number | null;
}

export function positionOf(def: VaultDefinition, margin: ReturnType<typeof useVaultAccount>["margin"], rows: MarginHistoryRow[], complete: boolean): VaultPosition {
  const holding = margin?.collateral.find((c) => c.mint === def.mint);
  const mine = rows.filter((r) => r.vaultId === def.id);
  const shares = holding?.amount ?? 0;
  const valueUsd = holding?.usd ?? 0;
  const net = mine.reduce((s, r) => s + (r.type === "farm-deposit" ? 1 : -1) * Number(r.amount), 0);
  const deposits = mine.filter((r) => r.type === "farm-deposit").map((r) => r.timestamp);
  const known = complete && (mine.length > 0 || shares === 0);
  return {
    shares,
    sharesRaw: BigInt(holding?.amountRaw ?? "0"),
    valueUsd,
    rows: mine,
    earnedUsd: known ? (shares === 0 && !mine.length ? 0 : valueUsd - net) : null,
    since: deposits.length ? Math.min(...deposits) : null,
  };
}

/** {@link positionOf} for the connected wallet. */
export function useVaultPosition(def: VaultDefinition | undefined): VaultPosition & { connected: boolean } {
  const { address, margin } = useVaultAccount();
  const history = useMarginHistory();
  return useMemo(() => {
    const empty: VaultPosition = { shares: 0, sharesRaw: 0n, valueUsd: 0, rows: [], earnedUsd: 0, since: null };
    if (!def) return { ...empty, connected: Boolean(address) };
    return { ...positionOf(def, margin, history.rows, Boolean(history.history?.complete)), connected: Boolean(address) };
  }, [def, margin, history.rows, history.history?.complete, address]);
}

/** Everything a vault page draws, from live sources only. */
export interface VaultView {
  def: VaultDefinition;
  state: LiveVault | null;
  isLoading: boolean;
  /** Recorded hourly share prices and the daily samples / daily APY drawn from them. */
  points: NavPoint[];
  sharePriceDays: DayPoint[];
  apyDays: DayPoint[];
  stats: NavStats;
  /** Basis only. */
  funding: {
    now: number | null;
    days: FundingDay[];
    stats: FundingStats;
  } | null;
  /** Share of NAV held short (0–1), from the live legs; null without a NAV. */
  hedgeShare: number | null;
  /** Price rise (%) to the short's liquidation; null without a short. */
  shortLiqRise: number | null;
}

export function useVaultView(id: string): VaultView | null {
  const def = VAULTS.find((v) => v.id === id);
  const live = useVaults(id);
  const history = useVaultHistory(id);
  const basis = def?.kind === "basis";
  const funding = useFundingHistory(basis ? def!.asset : null);
  const liveFunding = usePhoenixFundingNow(basis ? [def!.asset] : []);
  return useMemo(() => {
    if (!def) return null;
    const state = live.data.find((v) => v.id === id) ?? null;
    const days = dailySamples(history.points);
    const fundingDaysList = funding?.days ?? [];
    return {
      def,
      state,
      isLoading: live.isLoading,
      points: history.points,
      sharePriceDays: days,
      apyDays: dailyApy(days),
      stats: navStats(history.points),
      funding: basis ? { now: fundingNowApr(def.asset, liveFunding, funding), days: fundingDaysList, stats: fundingStats(fundingDaysList) } : null,
      hedgeShare: state?.navUsd && state.navUsd > 0 && state.shortUsd !== null ? Math.min(1, state.shortUsd / state.navUsd) : null,
      shortLiqRise: shortLiquidationRise(state?.shortUsd ?? null, state?.phoenixEffectiveUsd ?? null, state?.phoenixMaintenanceUsd ?? null),
    };
  }, [def, id, live.data, live.isLoading, history.points, funding, liveFunding, basis]);
}
