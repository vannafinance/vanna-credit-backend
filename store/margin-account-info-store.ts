// Margin-account store: the connected user's margin account (identity + health factor /
// collateral / borrowed / derived-risk fields) plus the actions that discover, create and refresh
// it. Nothing here is persisted — it is always rebuilt from on-chain reads
// (lib/solana/margin.ts `fetchMarginSnapshot`).

import { PublicKey } from "@solana/web3.js";
import createNewStore from "@/zustand/index";
import {
  createMarginAccount as createMarginAccountTx,
  fetchMarginSnapshot,
  serializeMarginSnapshot,
  type SerializedMarginSnapshot,
} from "@/lib/solana/margin";
import { deriveMarginHealth, HEALTH_FACTOR_INFINITY_SENTINEL } from "@/lib/margin-health";
import { showTxStep, showTxSuccess, showTxError, onTxStatus } from "@/lib/tx-progress";
import { describeError } from "@/lib/solana/errors";

/** A per-token balance entry: `amount` (UI units) and its `usdValue`, both decimal strings. */
export interface BorrowedBalance {
  amount: string;
  usdValue: string;
}

export interface MarginAccountInfoStateType {
  totalBorrowedValue: number;
  totalCollateralValue: number;
  grossCollateralValue: number;
  totalValue: number;
  /** HEALTH_FACTOR_INFINITY_SENTINEL (999) when there is collateral but no debt; 0 when empty. */
  avgHealthFactor: number;
  collateralLeftBeforeLiquidation: number;
  netAvailableCollateral: number;
  timeToLiquidation: number;
  /** Debt-weighted borrow APR (fraction). */
  borrowRate: number;
  liquidationPremium: number;
  liquidationFee: number;
  debtLimit: number;
  minDebt: number;
  maxDebt: number;
  hasMarginAccount: boolean;
  marginAccountAddress: string | null;
  /** Wallet that owns the margin account (the PDA is seeded by it). */
  ownerAddress: string | null;
  isCreatingAccount: boolean;
  accountCreationError: string | null;
  /** Debt per registry symbol. */
  borrowedBalances: Record<string, BorrowedBalance>;
  /** Margin-vault balance per symbol (borrowed tokens included — they count as collateral). */
  collateralBalances: Record<string, BorrowedBalance>;
  isLoadingBorrowedBalances: boolean;
  /** Full JSON-safe snapshot for components that need exact figures. */
  snapshot: SerializedMarginSnapshot | null;
}

const EMPTY_ACCOUNT = {
  totalBorrowedValue: 0,
  totalCollateralValue: 0,
  grossCollateralValue: 0,
  totalValue: 0,
  avgHealthFactor: 0,
  collateralLeftBeforeLiquidation: 0,
  netAvailableCollateral: 0,
  timeToLiquidation: 0,
  borrowRate: 0,
  liquidationPremium: 0,
  liquidationFee: 0,
  debtLimit: 0,
  minDebt: 0,
  maxDebt: 0,
  borrowedBalances: {} as Record<string, BorrowedBalance>,
  collateralBalances: {} as Record<string, BorrowedBalance>,
  snapshot: null as SerializedMarginSnapshot | null,
};

const initialState: MarginAccountInfoStateType = {
  ...EMPTY_ACCOUNT,
  hasMarginAccount: false,
  marginAccountAddress: null,
  ownerAddress: null,
  isCreatingAccount: false,
  accountCreationError: null,
  isLoadingBorrowedBalances: false,
};

export const useMarginAccountInfoStore = createNewStore(initialState, {
  name: "margin-account-info-store",
  devTools: true,
});

/**
 * Maps a serialized on-chain margin snapshot onto the store's (Stellar-compatible) fields.
 * Pure — also used by the account-snapshot hook.
 */
export function marginFieldsFromSnapshot(s: SerializedMarginSnapshot): Partial<MarginAccountInfoStateType> {
  const collateralBalances: Record<string, BorrowedBalance> = {};
  for (const c of s.collateral) {
    if (!c.active && c.amount <= 0) continue;
    collateralBalances[c.symbol] = { amount: String(c.amount), usdValue: String(c.usd) };
  }
  const borrowedBalances: Record<string, BorrowedBalance> = {};
  for (const d of s.debts) borrowedBalances[d.symbol] = { amount: String(d.debt), usdValue: String(d.usd) };
  const health = deriveMarginHealth({
    grossCollateralValue: s.totalCollateralUsd,
    effectiveDebtValue: s.totalDebtUsd,
    totalBorrowedValue: s.totalDebtUsd,
  });
  const borrowRate = s.totalDebtUsd > 0 ? s.debts.reduce((sum, d) => sum + d.borrowApr * d.usd, 0) / s.totalDebtUsd : 0;
  return {
    hasMarginAccount: s.exists,
    marginAccountAddress: s.exists ? s.address : null,
    ownerAddress: s.owner,
    borrowedBalances,
    collateralBalances,
    totalBorrowedValue: s.totalDebtUsd,
    totalCollateralValue: s.totalCollateralUsd,
    grossCollateralValue: s.totalCollateralUsd,
    totalValue: health.totalValue,
    avgHealthFactor: s.healthFactor ?? (s.totalCollateralUsd > 0 ? HEALTH_FACTOR_INFINITY_SENTINEL : 0),
    collateralLeftBeforeLiquidation: health.collateralLeftBeforeLiquidation,
    netAvailableCollateral: health.netAvailableCollateral,
    debtLimit: health.debtLimit,
    maxDebt: health.debtLimit,
    borrowRate,
    snapshot: s,
  };
}

/** Commit a freshly read snapshot (ignored if the connected owner changed meanwhile). */
export function applyMarginSnapshot(s: SerializedMarginSnapshot) {
  const current = useMarginAccountInfoStore.getState().ownerAddress;
  if (current && current !== s.owner) return;
  // setState (shallow top-level replace), NOT the factory's deep-merging `set`: a deep merge would
  // keep a repaid asset's old key alive inside borrowedBalances / collateralBalances.
  useMarginAccountInfoStore.setState({ ...marginFieldsFromSnapshot(s), isLoadingBorrowedBalances: false });
}

/** Reset to "no margin account" (disconnect / wallet switch). */
export const clearMarginAccount = () => {
  useMarginAccountInfoStore.setState({
    ...useMarginAccountInfoStore.getState(),
    ...EMPTY_ACCOUNT,
    hasMarginAccount: false,
    marginAccountAddress: null,
    ownerAddress: null,
    accountCreationError: null,
    isLoadingBorrowedBalances: false,
  });
};

const inflight = new Map<string, Promise<void>>();

/**
 * Re-read the owner's margin account from chain and commit it. Concurrent calls for the same owner
 * share one read.
 */
export const refreshMarginAccount = async (ownerAddress: string): Promise<void> => {
  const existing = inflight.get(ownerAddress);
  if (existing) return existing;
  const run = (async () => {
    try {
      useMarginAccountInfoStore.getState().set({ isLoadingBorrowedBalances: true, ownerAddress });
      const snap = await fetchMarginSnapshot(new PublicKey(ownerAddress));
      applyMarginSnapshot(serializeMarginSnapshot(snap));
    } catch (error) {
      console.error("margin refresh failed", error);
      useMarginAccountInfoStore.getState().set({ isLoadingBorrowedBalances: false });
    } finally {
      inflight.delete(ownerAddress);
    }
  })();
  inflight.set(ownerAddress, run);
  return run;
};

/** Stellar-compatible names. On Solana the margin account is keyed by its owner wallet. */
export const checkUserMarginAccount = (userAddress: string, _forceRefresh = false) => refreshMarginAccount(userAddress);
export const refreshBorrowedBalances = (_marginOrOwner?: string | null, _force = false) => {
  const owner = useMarginAccountInfoStore.getState().ownerAddress;
  return owner ? refreshMarginAccount(owner) : Promise.resolve();
};

export const setAccountCreationLoading = (loading: boolean) =>
  useMarginAccountInfoStore.getState().set({ isCreatingAccount: loading, accountCreationError: loading ? null : useMarginAccountInfoStore.getState().accountCreationError });

export const setAccountCreationError = (error: string | null) =>
  useMarginAccountInfoStore.getState().set({ accountCreationError: error, isCreatingAccount: false });

/** `user_create_margin` with progress modal; returns true on success. */
export const createMarginAccount = async (userAddress: string): Promise<boolean> => {
  try {
    setAccountCreationLoading(true);
    showTxStep("Creating your Vanna margin account on Solana");
    const result = await createMarginAccountTx({ onStatus: onTxStatus });
    useMarginAccountInfoStore.getState().set({ hasMarginAccount: true, marginAccountAddress: result.address, isCreatingAccount: false });
    showTxSuccess("Margin account created!");
    void refreshMarginAccount(userAddress).catch(() => {});
    return true;
  } catch (error) {
    const message = describeError(error, "Could not create the margin account");
    setAccountCreationError(message);
    showTxError(message);
    return false;
  }
};

export const resetCreationState = () => useMarginAccountInfoStore.getState().set({ isCreatingAccount: false, accountCreationError: null });
export const updateAccountData = (data: Partial<MarginAccountInfoStateType>) => useMarginAccountInfoStore.getState().set(data);
