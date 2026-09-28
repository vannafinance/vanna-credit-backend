import createNewStore from "@/zustand/index";
import { emptyBalanceMap } from "@/lib/solana/tokens";

// Connected-wallet store: connection status, native SOL balance, per-token wallet balances and
// per-pool supplied (lender) balances. The single source of truth for "who is connected" across the
// app; written by the wallet hooks. Every balance map is keyed by the token registry's symbols.

/** Connected-wallet slice: address/connection flags plus wallet and deposited balances (decimal strings). */
export interface User {
  address: string | null;
  isConnected: boolean;
  /** Wallet Standard wallet name (Phantom / Backpack / Solflare …). */
  walletName: string | null;
  /** Native SOL balance. */
  balance: string;
  /** Wallet balance per registry symbol (SOL = native lamports, not wSOL). */
  tokenBalances: Record<string, string>;
  /** Underlying value of the wallet's lender shares per registry symbol. */
  depositedBalances: Record<string, string>;
  isLoading: boolean;
  manuallyDisconnected: boolean;
}

const initialState: User = {
  address: null,
  isConnected: false,
  walletName: null,
  balance: "0",
  tokenBalances: emptyBalanceMap(),
  depositedBalances: emptyBalanceMap(),
  isLoading: false,
  manuallyDisconnected: false,
};

// Financial and wallet state is intentionally memory-only: the wallet is authoritative for the
// connection and every balance is re-read from chain (clearing the cache must never lose data).
export const useUserStore = createNewStore(initialState, {
  name: "user-store",
  devTools: true,
});
