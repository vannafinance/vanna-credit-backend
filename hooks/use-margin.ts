'use client';

import { useEffect, useRef } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLedgerTick } from '@/contexts/ledger-subscriber';
import { useUserStore } from '@/store/user';
import { refreshMarginAccount } from '@/store/margin-account-info-store';
import { refreshWalletBalancesOnChain } from '@/hooks/use-wallet';
import {
  depositAndBorrow,
  repay,
  withdrawCollateral,
  closeCollateralPosition,
  type AmountItem,
  type RepayRequest,
  type WithdrawRequest,
} from '@/lib/solana/margin';
import { fetchMarginHistory, type HistoryPage, type MarginHistoryRow } from '@/lib/solana/history';
import { describeError } from '@/lib/solana/errors';
import { onTxStatus, showTxError, showTxStep, showTxSuccess } from '@/lib/tx-progress';

export type { MarginHistoryRow };

/** Margin-account history decoded from on-chain events, newest first. */
export const useMarginHistory = () => {
  const address = useUserStore((s) => s.address);
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const last = useRef(tick);
  const query = useQuery({
    queryKey: ['margin', 'history', address ?? 'none'],
    queryFn: () => fetchMarginHistory(new PublicKey(address!)),
    enabled: Boolean(address),
    staleTime: 10_000,
  });
  useEffect(() => {
    if (tick === last.current) return;
    last.current = tick;
    qc.invalidateQueries({ queryKey: ['margin', 'history'] });
  }, [tick, qc]);
  return {
    history: query.data as HistoryPage<MarginHistoryRow> | undefined,
    rows: query.data?.rows ?? [],
    isLoading: query.isLoading && Boolean(address),
    error: query.error ? (query.error as Error).message : null,
    refresh: () => query.refetch(),
  };
};

/** Refresh everything a margin transaction can change. */
export function useAfterMarginTx() {
  const qc = useQueryClient();
  return async () => {
    const address = useUserStore.getState().address;
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['margin'] }),
      qc.invalidateQueries({ queryKey: ['earn'] }),
      address ? refreshMarginAccount(address) : Promise.resolve(),
      address ? refreshWalletBalancesOnChain(address).catch(() => {}) : Promise.resolve(),
    ]);
  };
}

const describeItems = (items: AmountItem[]) => items.map((i) => `${i.amount} ${i.symbol}`).join(' + ');

/**
 * Deposit (from wallet) and/or borrow any number of assets in ONE transaction — covers single,
 * dual and cross-asset borrows. `createIfMissing` also creates the margin account in the same tx.
 */
export const useDepositAndBorrow = () => {
  const after = useAfterMarginTx();
  return useMutation({
    mutationFn: async (input: { deposits?: AmountItem[]; borrows?: AmountItem[]; createIfMissing?: boolean }) => {
      const deposits = input.deposits ?? [];
      const borrows = input.borrows ?? [];
      const label = [deposits.length ? `Depositing ${describeItems(deposits)}` : '', borrows.length ? `Borrowing ${describeItems(borrows)}` : '']
        .filter(Boolean)
        .join(' and ');
      showTxStep(label || 'Submitting');
      try {
        const result = await depositAndBorrow(input, { onStatus: onTxStatus });
        showTxSuccess(label.replace('Depositing', 'Deposited').replace('Borrowing', 'borrowed'));
        await after();
        return result;
      } catch (error) {
        showTxError(describeError(error, 'Transaction failed'));
        throw error;
      }
    },
  });
};

/** Repay from the margin vault or the wallet; `all` repays the full accrued debt. */
export const useRepay = () => {
  const after = useAfterMarginTx();
  return useMutation({
    mutationFn: async (req: RepayRequest) => {
      showTxStep(req.all ? `Repaying all ${req.symbol} debt` : `Repaying ${req.amount} ${req.symbol}`);
      try {
        const result = await repay(req, { onStatus: onTxStatus });
        showTxSuccess(req.all ? `Repaid all ${req.symbol} debt` : `Repaid ${req.amount} ${req.symbol}`);
        await after();
        return result;
      } catch (error) {
        showTxError(describeError(error, 'Repay failed'));
        throw error;
      }
    },
  });
};

/** Withdraw collateral from the margin vault to the wallet (health-checked on-chain). */
export const useWithdrawCollateral = () => {
  const after = useAfterMarginTx();
  return useMutation({
    mutationFn: async (req: WithdrawRequest) => {
      showTxStep(req.all ? `Withdrawing all ${req.symbol}` : `Withdrawing ${req.amount} ${req.symbol}`);
      try {
        const result = await withdrawCollateral(req, { onStatus: onTxStatus });
        showTxSuccess(req.all ? `Withdrew all ${req.symbol}` : `Withdrew ${req.amount} ${req.symbol}`);
        await after();
        return result;
      } catch (error) {
        showTxError(describeError(error, 'Withdraw failed'));
        throw error;
      }
    },
  });
};

/** Close an empty collateral vault (reclaims rent). */
export const useCloseCollateralPosition = () => {
  const after = useAfterMarginTx();
  return useMutation({
    mutationFn: async (symbol: string) => {
      showTxStep(`Closing empty ${symbol} vault`);
      try {
        const result = await closeCollateralPosition(symbol, { onStatus: onTxStatus });
        showTxSuccess(`Closed ${symbol} vault`);
        await after();
        return result;
      } catch (error) {
        showTxError(describeError(error, 'Close failed'));
        throw error;
      }
    },
  });
};
