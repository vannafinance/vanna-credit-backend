'use client';

/**
 * The connected wallet's Vanna margin account for the V3 pages: the program-exact model
 * (lib/account-model.ts) built from the on-chain view the Perps page already polls, so every page
 * shows the same health factor, account leverage, room before liquidation and liquidation prices.
 */
import { useCallback, useMemo } from 'react';
import { useUserStore } from '@/store/user';
import { usePerpsView } from '@/hooks/use-perps';
import { accountNumbers, liqMultiplier, liqRoom, priceKey, type AccountNumbers, type LiqRoom, type ModelState } from '@/lib/account-model';
import type { PerpsView } from '@/lib/solana/perps-types';

export interface V3Account {
  connected: boolean;
  hasMargin: boolean;
  loading: boolean;
  view: PerpsView | undefined;
  state: ModelState | null;
  now: AccountNumbers | null;
  room: LiqRoom | null;
  /** On-chain price of a symbol (perp markets use their index), USD; 0 when unknown. */
  priceOf: (symbol: string) => number;
  /**
   * Price of `symbol` at which the whole account reaches health factor 1.10, every other price
   * held; `side` limits it to the adverse direction of a position. null = None / no debt.
   */
  liqPriceOf: (symbol: string, side?: 'long' | 'short') => number | null;
}

export function useV3Account(): V3Account {
  const address = useUserStore((s) => s.address);
  const { view, isLoading } = usePerpsView();
  const acct = view?.account;
  const state: ModelState | null = useMemo(() => {
    if (!view || !acct?.hasMargin) return null;
    return {
      collateral: acct.collateralRows,
      debts: acct.debtRows,
      phoenixCollateral: acct.idleUsdc,
      perps: view.positions.map((p) => ({
        key: p.market,
        tokens: p.side === 'long' ? p.sizeTokens : -p.sizeTokens,
        entry: p.entryPrice,
        index: p.indexPrice,
        fundingUsd: p.fundingUsd,
        takerFee: view.markets.find((m) => m.key === p.market)?.takerFee ?? 0,
      })),
    };
  }, [view, acct]);
  const now = useMemo(() => (state ? accountNumbers(state) : null), [state]);
  const room = useMemo(() => (state ? liqRoom(state) : null), [state]);

  const priceOf = useCallback(
    (symbol: string) => {
      const key = priceKey(symbol);
      return acct?.prices[key] ?? acct?.prices[symbol] ?? view?.markets.find((m) => m.key === key)?.indexPrice ?? 0;
    },
    [acct, view],
  );
  const liqPriceOf = useCallback(
    (symbol: string, side?: 'long' | 'short') => {
      if (!state) return null;
      const m = liqMultiplier(state, priceKey(symbol), side);
      const p = priceOf(symbol);
      return m !== null && p > 0 ? p * m : null;
    },
    [state, priceOf],
  );

  // Stable between refreshes, so consumers' memos and effects only re-run when the account changes.
  return useMemo(
    () => ({ connected: Boolean(address), hasMargin: Boolean(acct?.hasMargin), loading: isLoading, view, state, now, room, priceOf, liqPriceOf }),
    [address, acct, isLoading, view, state, now, room, priceOf, liqPriceOf],
  );
}
