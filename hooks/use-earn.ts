'use client';

import { fetchWithTimeout } from "../lib/async";

import { useMemo } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '@/store/user';
import { refreshAfterTx } from '@/lib/after-tx';
import { freshParam } from '@/lib/fresh-reads';
import { useAccountSnapshot, type AccountApiResponse } from '@/hooks/use-account-snapshot';
import { fetchPoolStates, type PoolState, type SerializedPoolState } from '@/lib/solana/protocol-state';
import { redeem, supply, type LenderPosition } from '@/lib/solana/lend';
import { computeEarnedInterest, fetchEarnHistory, type EarnedInterest, type EarnHistoryRow, type HistoryPage } from '@/lib/solana/history';
import { describeError } from '@/lib/solana/errors';
import { onTxStatus, showTxError, showTxStep, showTxSuccess } from '@/lib/tx-progress';

export const EARN_POOLS_KEY = ['earn', 'pools'] as const;

/** Pool details hold slow-moving config (caps, rate curve) next to the totals the summary already ticks. */
const POOL_DETAILS_REFRESH_MS = 30_000;

/**
 * Every registry lending pool from GET /api/pools (on-chain Reserve accounts, interest projected to
 * the fork clock, APYs from the program's own rate curve). Refreshed on each slot tick
 * (components/tick-refresh.tsx).
 *
 * @returns `{ pools: Record<symbol, SerializedPoolState>, isLoading, isRefreshing, error, refresh }`.
 */
export const usePoolData = () => {
  const query = useQuery({
    queryKey: EARN_POOLS_KEY,
    queryFn: async (): Promise<Record<string, SerializedPoolState>> => {
      const res = await fetchWithTimeout(`/api/pools${freshParam()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`pool stats failed (${res.status})`);
      return ((await res.json()) as { pools: Record<string, SerializedPoolState> }).pools;
    },
    staleTime: 4_000,
  });
  return {
    pools: query.data ?? {},
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    lastUpdated: query.dataUpdatedAt || null,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

/**
 * Full on-chain pool state per registry symbol (decoded Reserve + AssetConfig with bigint fields,
 * rate-curve coefficients, share mint, caps, liquidation bonus, max collateral per margin), read
 * directly from the RPC in the browser. Use this where the JSON summary from `usePoolData` is not
 * enough (Earn detail "Details" / "Collateral and Limits" / rate-curve chart). Refreshed every 30 s
 * while shown and right after the user's own transactions (lib/after-tx.ts), not on every slot tick.
 */
export const usePoolDetails = () => {
  const query = useQuery({
    queryKey: ['earn', 'pool-details'],
    queryFn: (): Promise<Record<string, PoolState>> => fetchPoolStates(),
    staleTime: 4_000,
    refetchInterval: POOL_DETAILS_REFRESH_MS,
  });
  return {
    details: (query.data ?? {}) as Record<string, PoolState>,
    isLoading: query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

/** The account snapshot's lender rows with their raw amounts back as bigints. */
export function lenderPositionsFromApi(lender: AccountApiResponse['lender'] | undefined): Record<string, LenderPosition> {
  const out: Record<string, LenderPosition> = {};
  for (const [symbol, p] of Object.entries(lender ?? {})) out[symbol] = { ...p, sharesRaw: BigInt(p.sharesRaw), assetsRaw: BigInt(p.assetsRaw) };
  return out;
}

/**
 * The connected wallet's lender positions (share balance × projected exchange rate), per registry
 * symbol. Empty object when disconnected. Read from the shared account snapshot (GET /api/account,
 * the same server-side fetchLenderPositions), so it costs no extra request.
 */
export const useUserPositions = () => {
  const address = useUserStore((s) => s.address);
  const { snapshot, isLoading, isRefreshing, error, refresh } = useAccountSnapshot(address);
  const lender = snapshot?.api.lender;
  const positions = useMemo(() => lenderPositionsFromApi(lender), [lender]);
  return {
    positions,
    isLoading: isLoading && Boolean(address),
    isRefreshing,
    error,
    refresh,
  };
};

/**
 * Supply / withdraw history decoded from on-chain events, plus honest earned interest per asset
 * (null — never zero — when the history can't prove the cost basis). Not refreshed on slot ticks:
 * it changes only with the user's own transactions, which refresh it (lib/after-tx.ts).
 */
export const useEarnTransactions = () => {
  const address = useUserStore((s) => s.address);
  const { positions } = useUserPositions();
  const query = useQuery({
    queryKey: ['earn', 'history', address ?? 'none'],
    queryFn: () => fetchEarnHistory(new PublicKey(address!)),
    enabled: Boolean(address),
    staleTime: 10_000,
  });
  const earned = useMemo<Record<string, EarnedInterest> | null>(
    () => (query.data ? computeEarnedInterest(query.data, positions) : null),
    [query.data, positions],
  );
  return {
    history: query.data as HistoryPage<EarnHistoryRow> | undefined,
    transactions: query.data?.rows ?? [],
    earned,
    isLoading: query.isLoading && Boolean(address),
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

function useAfterEarnTx() {
  const qc = useQueryClient();
  // Lender positions, pools and the account snapshot (wallet balances) first, history later.
  return () => refreshAfterTx(qc, ['earn', 'margin']);
}

/** Supply mutation (`lender_supply`) with the progress modal + toast. */
export const useSupplyLiquidity = () => {
  const after = useAfterEarnTx();
  return useMutation({
    mutationFn: async ({ symbol, amount }: { symbol: string; amount: string | number }) => {
      const address = useUserStore.getState().address;
      if (!address) throw new Error('Please connect your wallet first');
      showTxStep(`Supplying ${amount} ${symbol}`);
      try {
        const result = await supply(symbol, amount, { onStatus: onTxStatus });
        showTxSuccess(`Supplied ${amount} ${symbol}`);
        void after().catch(() => {});
        return result;
      } catch (error) {
        showTxError(describeError(error, 'Supply failed'));
        throw error;
      }
    },
  });
};

/** Withdraw mutation (`lender_redeem`): by underlying amount, or everything. */
export const useWithdrawLiquidity = () => {
  const after = useAfterEarnTx();
  return useMutation({
    mutationFn: async ({ symbol, amount, all }: { symbol: string; amount?: string | number; all?: boolean }) => {
      const address = useUserStore.getState().address;
      if (!address) throw new Error('Please connect your wallet first');
      showTxStep(all ? `Withdrawing all ${symbol}` : `Withdrawing ${amount} ${symbol}`);
      try {
        const result = await redeem(symbol, all ? { all: true } : { assetsUi: amount }, { onStatus: onTxStatus });
        showTxSuccess(all ? `Withdrew all ${symbol}` : `Withdrew ${amount} ${symbol}`);
        void after().catch(() => {});
        return result;
      } catch (error) {
        showTxError(describeError(error, 'Withdraw failed'));
        throw error;
      }
    },
  });
};
