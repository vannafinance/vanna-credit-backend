"use client";

/**
 * Live adapters for the V3 Farm vault pages (Basis /farm/basis/:id and Perena /farm/perena/:id).
 *
 * Sources — nothing here is sampled or invented:
 * - vault state: GET /api/farm/vaults (fork reads, `useVaults`): NAV, share price, cap, legs, Phoenix margin;
 * - share-price history: GET /api/farm/vaults/history (hourly observations recorded by the server);
 * - funding: GET /api/farm/funding (Phoenix mainnet hourly rates, 90 days) and, for "now", Phoenix's
 *   public WebSocket `market` channel (the same feed the Perps terminal uses), which also gives each
 *   market's live open interest and mark price;
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
  type PerenaMarket,
  type PerenaProduct,
} from "./nav-math";

/** /farm/basis/sol → "basis-sol"; the route segment of a catalogue id. */
export const vaultHref = (id: string) => (id.startsWith("basis-") ? `/farm/basis/${id.slice(6)}` : `/farm/perena/${id.slice(7)}`);

/** Perena's published APY / holders / mainnet price for USD* and USD* Junior (GET /api/farm/perena). */
export function usePerenaMarket(): PerenaMarket | null {
  const q = useQuery({
    queryKey: ["farm", "perena-market"],
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async (): Promise<PerenaMarket> => {
      const r = await fetchWithTimeout("/api/farm/perena");
      if (!r.ok) throw new Error("Perena data is unavailable");
      return r.json();
    },
  });
  return q.data ?? null;
}

/** The Perena product of a catalogue id (all-null when unknown or not loaded). */
export function perenaProduct(market: PerenaMarket | null, id: string): PerenaProduct {
  const p = market ? (id === "perena-junior" ? market.junior : id === "perena-usdstar" ? market.usdstar : null) : null;
  return p ?? { apy7: null, holders: null, price: null };
}

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

/** One Phoenix perp market's live figures from the public WebSocket `market` channel. */
export interface PhoenixMarketNow {
  /** Current hourly funding, % (positive: longs pay shorts). */
  funding: number | null;
  /** Open interest, base units (e.g. SOL for SOL-PERP). */
  openInterest: number | null;
  /** Phoenix mark price, USD. */
  markPx: number | null;
}

/** Open interest in USD (base units × mark); null until both are known. */
export function openInterestUsd(m: PhoenixMarketNow | undefined | null): number | null {
  return m && m.openInterest !== null && m.markPx !== null ? m.openInterest * m.markPx : null;
}

const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return v !== null && v !== undefined && Number.isFinite(n) ? n : null;
};

/**
 * Live funding, open interest and mark per Phoenix market from the public WebSocket's `market`
 * channel only (no book / trades / candles), one socket for all `symbols`. Empty until the first
 * message per market.
 */
export function usePhoenixMarketNow(symbols: string[]): Record<string, PhoenixMarketNow> {
  const [now, setNow] = useState<Record<string, PhoenixMarketNow>>({});
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
          const m = JSON.parse(String(event.data)) as { channel?: string; symbol?: string; funding?: unknown; openInterest?: unknown; markPx?: unknown };
          if (m.channel !== "market" || !m.symbol) return;
          const sym = m.symbol;
          setNow((prev) => {
            const old = prev[sym];
            // A frame may omit fields; keep the last known value for those.
            const next: PhoenixMarketNow = {
              funding: finite(m.funding) ?? old?.funding ?? null,
              openInterest: finite(m.openInterest) ?? old?.openInterest ?? null,
              markPx: finite(m.markPx) ?? old?.markPx ?? null,
            };
            return old && old.funding === next.funding && old.openInterest === next.openInterest && old.markPx === next.markPx ? prev : { ...prev, [sym]: next };
          });
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

/** Hourly funding (%) per market out of {@link usePhoenixMarketNow}'s live figures. */
export function fundingOf(markets: Record<string, PhoenixMarketNow>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [sym, m] of Object.entries(markets)) if (m.funding !== null) out[sym] = m.funding;
  return out;
}

/**
 * Current hourly funding (%) per Phoenix market from the public WebSocket's `market` channel only
 * (no book / trades / candles). Empty until the first message; callers fall back to the latest
 * published hourly rate from {@link useFundingHistory}. A thin view over {@link usePhoenixMarketNow}.
 */
export function usePhoenixFundingNow(symbols: string[]): Record<string, number> {
  const markets = usePhoenixMarketNow(symbols);
  return useMemo(() => fundingOf(markets), [markets]);
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
  /** Short notional per dollar of NAV (can exceed 1), from the live legs; null without a NAV. */
  hedgeShare: number | null;
  /** Price rise (%) to the short's liquidation; null without a short. */
  shortLiqRise: number | null;
  /** Basis only: the Phoenix market's live open interest and mark (public WebSocket); null otherwise. */
  market: PhoenixMarketNow | null;
}

export function useVaultView(id: string): VaultView | null {
  const def = VAULTS.find((v) => v.id === id);
  const live = useVaults(id);
  const history = useVaultHistory(id);
  const basis = def?.kind === "basis";
  const funding = useFundingHistory(basis ? def!.asset : null);
  const liveMarkets = usePhoenixMarketNow(basis ? [def!.asset] : []);
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
      funding: basis ? { now: fundingNowApr(def.asset, fundingOf(liveMarkets), funding), days: fundingDaysList, stats: fundingStats(fundingDaysList) } : null,
      hedgeShare: state?.navUsd && state.navUsd > 0 && state.shortUsd !== null ? state.shortUsd / state.navUsd : null,
      shortLiqRise: shortLiquidationRise(state?.shortUsd ?? null, state?.phoenixEffectiveUsd ?? null, state?.phoenixMaintenanceUsd ?? null),
      market: basis ? liveMarkets[def.asset] ?? { funding: null, openInterest: null, markPx: null } : null,
    };
  }, [def, id, live.data, live.isLoading, history.points, funding, liveMarkets, basis]);
}
