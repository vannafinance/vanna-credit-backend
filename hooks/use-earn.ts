'use client';

import { useEffect, useMemo, useRef } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLedgerTick } from '@/contexts/ledger-subscriber';
import { useUserStore } from '@/store/user';
import { refreshWalletBalancesOnChain } from '@/hooks/use-wallet';
import { fetchPoolStates, type PoolState, type SerializedPoolState } from '@/lib/solana/protocol-state';
import { fetchLenderPositions, redeem, supply, type LenderPosition } from '@/lib/solana/lend';
import { computeEarnedInterest, fetchEarnHistory, type EarnedInterest, type EarnHistoryRow, type HistoryPage } from '@/lib/solana/history';
import { describeError } from '@/lib/solana/errors';
import { onTxStatus, showTxError, showTxStep, showTxSuccess } from '@/lib/tx-progress';

export const EARN_POOLS_KEY = ['earn', 'pools'] as const;

/** Invalidate the query on each (throttled) slot tick. */
function useTickInvalidate(key: readonly unknown[]) {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const last = useRef(tick);
  const k = JSON.stringify(key);
  useEffect(() => {
    if (tick === last.current) return;
    last.current = tick;
    qc.invalidateQueries({ queryKey: JSON.parse(k) });
  }, [tick, qc, k]);
}

/**
 * Every registry lending pool from GET /api/pools (on-chain Reserve accounts, interest projected to
 * the fork clock, APYs from the program's own rate curve).
 *
 * @returns `{ pools: Record<symbol, SerializedPoolState>, isLoading, isRefreshing, error, refresh }`.
 */
export const usePoolData = () => {
  const query = useQuery({
    queryKey: EARN_POOLS_KEY,
    queryFn: async (): Promise<Record<string, SerializedPoolState>> => {
      const res = await fetch('/api/pools', { cache: 'no-store' });
      if (!res.ok) throw new Error(`pool stats failed (${res.status})`);
      return ((await res.json()) as { pools: Record<string, SerializedPoolState> }).pools;
    },
    staleTime: 4_000,
  });
  useTickInvalidate(EARN_POOLS_KEY);
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
 * enough (Earn detail "Details" / "Collateral and Limits" / rate-curve chart).
 */
export const usePoolDetails = () => {
  const key = ['earn', 'pool-details'] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: (): Promise<Record<string, PoolState>> => fetchPoolStates(),
    staleTime: 4_000,
  });
  useTickInvalidate(key);
  return {
    details: (query.data ?? {}) as Record<string, PoolState>,
    isLoading: query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

/**
 * The connected wallet's lender positions (share balance × projected exchange rate), per registry
 * symbol. Empty object when disconnected.
 */
export const useUserPositions = () => {
  const address = useUserStore((s) => s.address);
  const key = ['earn', 'positions', address ?? 'none'] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchLenderPositions(new PublicKey(address!)),
    enabled: Boolean(address),
    staleTime: 4_000,
  });
  useTickInvalidate(['earn', 'positions']);
  return {
    positions: (query.data ?? {}) as Record<string, LenderPosition>,
    isLoading: query.isLoading && Boolean(address),
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

/**
 * Supply / withdraw history decoded from on-chain events, plus honest earned interest per asset
 * (null — never zero — when the history can't prove the cost basis).
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
  useTickInvalidate(['earn', 'history']);
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
  return async (address: string) => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['earn'] }),
      qc.invalidateQueries({ queryKey: ['margin'] }),
      refreshWalletBalancesOnChain(address).catch(() => {}),
    ]);
  };
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
        await after(address);
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
        await after(address);
        return result;
      } catch (error) {
        showTxError(describeError(error, 'Withdraw failed'));
        throw error;
      }
    },
  });
};
