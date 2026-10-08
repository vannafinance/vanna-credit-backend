'use client';

import { PublicKey } from '@solana/web3.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUserStore } from '@/store/user';
import { useAfterMarginTx } from '@/hooks/use-margin';
import { cancelPerpOrder, closePerp, fetchPerpsHistory, fetchPerpsView, withdrawPerpCollateral } from '@/lib/solana/perps';
import { openPerp } from '@/lib/solana/perps';
import type { CancelPerpRequest, ClosePerpRequest, OpenPerpRequest, PerpHistoryRow, PerpsView, WithdrawPerpCollateralRequest } from '@/lib/solana/perps-types';
import { describeError } from '@/lib/solana/errors';
import { onTxStatus, showTxError, showTxStep, showTxSuccess } from '@/lib/tx-progress';

/**
 * The Perps page's on-chain state: listed Phoenix markets (index / mark price, leverage cap), the
 * connected wallet's positions and its margin account. Polled every few seconds so PnL
 * follows the index price, with a single polling schedule. Works without a wallet (markets only).
 */
export const usePerpsView = () => {
  const address = useUserStore((s) => s.address);
  const query = useQuery({
    queryKey: ['perps', 'view', address ?? 'none'],
    queryFn: () => fetchPerpsView(address ? new PublicKey(address) : null),
    refetchInterval: 6_000,
    staleTime: 3_000,
  });
  return {
    view: query.data as PerpsView | undefined,
    isLoading: query.isLoading,
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

/** The wallet's Phoenix history (decoded from on-chain transactions); fetched while `enabled`. */
export const usePerpsHistory = (enabled: boolean) => {
  const address = useUserStore((s) => s.address);
  const query = useQuery({
    queryKey: ['perps', 'history', address ?? 'none'],
    queryFn: () => fetchPerpsHistory(new PublicKey(address!)),
    enabled: enabled && Boolean(address),
    staleTime: 10_000,
  });
  return { rows: (query.data ?? []) as PerpHistoryRow[], isLoading: query.isLoading && enabled && Boolean(address) };
};

function useAfterPerpsTx() {
  const qc = useQueryClient();
  const afterMargin = useAfterMarginTx();
  return async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['perps'] }), afterMargin()]);
  };
}

function useTx<T>(label: (req: T) => string, run: (req: T) => Promise<{ summary: string }>, failure: string) {
  const after = useAfterPerpsTx();
  return useMutation({
    mutationFn: async (req: T) => {
      showTxStep(label(req));
      try {
        const result = await run(req);
        showTxSuccess(result.summary);
        void after().catch(() => {});
        return result;
      } catch (error) {
        showTxError(describeError(error, failure));
        throw error;
      }
    },
  });
}

/** Open or increase a long / short with USDC from the margin account. */
export const useOpenPerp = () =>
  useTx<OpenPerpRequest>(
    (r) => `${r.side === 'long' ? 'Long' : 'Short'} ${r.market}-PERP ${r.leverage}x`,
    (r) => openPerp(r, { onStatus: onTxStatus }),
    'Order failed',
  );

/** Close (or partly close) a position; once nothing is open its USDC goes back to the margin account. */
export const useClosePerp = () =>
  useTx<ClosePerpRequest>((r) => `Closing ${r.market}-PERP ${r.side}`, (r) => closePerp(r, { onStatus: onTxStatus }), 'Close failed');

/** Kept for older callers: Phoenix market orders fill immediately, so there is nothing to cancel. */
export const useCancelPerpOrder = () =>
  useTx<CancelPerpRequest>((r) => `Cancelling ${r.market}-PERP ${r.side} order`, (r) => cancelPerpOrder(r, { onStatus: onTxStatus }), 'Cancel failed');

/** Move USDC from Phoenix back into the margin account (all of it by default). */
export const useWithdrawPerpCollateral = () =>
  useTx<WithdrawPerpCollateralRequest>(() => 'Withdrawing USDC from Phoenix', (r) => withdrawPerpCollateral(r, { onStatus: onTxStatus }), 'Withdraw failed');
