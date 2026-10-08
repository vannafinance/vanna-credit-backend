"use client";

/**
 * Everything the V3 Margin screen reads, in one place:
 *
 * - `acct` / `model` / `now` / `room`: the program-exact account model (`useV3Account`) — health
 *   factor, account leverage, room before liquidation, liquidation prices and every "after this
 *   action" preview;
 * - `snap`: the on-chain margin snapshot (GET /api/account/:wallet, fed into the margin store) —
 *   per-token vault balances, debts accrued to fork-now and their borrow APR;
 * - wallet balances (user store), on-chain token prices (GET /api/prices).
 *
 * Nothing here is persisted; every figure is a live chain read.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useV3Account, type V3Account } from "@/hooks/use-v3-account";
import { accountNumbers, type AccountNumbers, type ModelState } from "@/lib/account-model";
import type { SerializedMarginSnapshot } from "@/lib/solana/margin";
import { EMPTY_STATE } from "./mg-sim";

/** Amounts below this are float dust (treated as zero). */
const DUST = 1e-9;

export interface MarginScreen {
  address: string | null;
  connected: boolean;
  /** The wallet has a margin account (snapshot first, store fallback). */
  hasAccount: boolean;
  /** Connected but the first snapshot hasn't arrived yet. */
  loading: boolean;
  acct: V3Account;
  /** The account model (an empty account when there is none / not loaded). */
  model: ModelState;
  now: AccountNumbers;
  snap: SerializedMarginSnapshot | null;
  snapshotError: string | null;
  /** On-chain USD price per registry symbol (0 = unknown). */
  prices: Record<string, number>;
  /** Wallet balance (UI units). */
  wbal: (symbol: string) => number;
  /** Margin-vault balance (UI units; borrowed tokens included). */
  vault: (symbol: string) => number;
  /** Debt accrued to fork-now (UI units). */
  debt: (symbol: string) => number;
  /** Debt-weighted borrow APR, fraction. */
  borrowRate: number;
}

export function useMarginScreen(): MarginScreen {
  const { address, connected, tokenBalances } = useUserStore(
    useShallow((s) => ({ address: s.address, connected: s.isConnected, tokenBalances: s.tokenBalances })),
  );
  const { storeHas, storeSnap } = useMarginAccountInfoStore(
    useShallow((s) => ({ storeHas: s.hasMarginAccount, storeSnap: s.snapshot })),
  );
  const { snapshot, error } = useAccountSnapshot(address);
  const acct = useV3Account();
  const prices = useTokenPrices();

  // The query snapshot is the freshest read; the store copy covers the post-transaction refresh.
  const snap = snapshot?.api?.margin ?? storeSnap ?? null;
  const hasAccount = Boolean(address) && (snapshot?.hasMarginAccount ?? storeHas);
  const model = acct.state ?? EMPTY_STATE;
  const now = useMemo(() => accountNumbers(model), [model]);

  return useMemo(() => {
    const vaultMap = new Map((snap?.collateral ?? []).map((c) => [c.symbol, c.amount]));
    const debtMap = new Map((snap?.debts ?? []).map((d) => [d.symbol, d.debt]));
    const totalDebt = snap?.totalDebtUsd ?? 0;
    const borrowRate = totalDebt > 0 ? (snap?.debts ?? []).reduce((t, d) => t + d.borrowApr * d.usd, 0) / totalDebt : 0;
    const clean = (v: number | undefined) => (v && v > DUST ? v : 0);
    return {
      address,
      connected: Boolean(address) && connected,
      hasAccount,
      loading: Boolean(address) && !snapshot && !storeSnap,
      acct,
      model,
      now,
      snap,
      snapshotError: error,
      prices,
      wbal: (s: string) => (address ? clean(parseFloat(tokenBalances[s] || "0")) : 0),
      vault: (s: string) => (address ? clean(vaultMap.get(s)) : 0),
      debt: (s: string) => (address ? clean(debtMap.get(s)) : 0),
      borrowRate,
    };
  }, [address, connected, hasAccount, snapshot, storeSnap, acct, model, now, snap, error, prices, tokenBalances]);
}
