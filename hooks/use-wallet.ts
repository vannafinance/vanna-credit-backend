"use client";

import { useCallback, useEffect } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet as useSolanaWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import toast from "react-hot-toast";
import { useUserStore } from "@/store/user";
import { clearMarginAccount } from "@/store/margin-account-info-store";
import { fetchWalletBalances } from "@/lib/solana/balances";
import { fetchLenderPositions } from "@/lib/solana/lend";
import { emptyBalanceMap } from "@/lib/solana/tokens";

const refreshes = new Map<string, Promise<void>>();

/**
 * Re-read the wallet's token balances and lender positions from chain into the user store.
 * Concurrent calls for one address share a request; a response for a wallet that disconnected
 * or changed mid-request is dropped.
 */
export function refreshWalletBalancesOnChain(address: string): Promise<void> {
  const existing = refreshes.get(address);
  if (existing) return existing;
  const owner = new PublicKey(address);
  const request = Promise.all([fetchWalletBalances(owner), fetchLenderPositions(owner)])
    .then(([balances, lender]) => {
      if (useUserStore.getState().address !== address) return;
      const depositedBalances = Object.fromEntries(Object.values(lender).map((p) => [p.symbol, String(p.assets)]));
      // setState: replace the maps outright (the factory's `set` deep-merges).
      useUserStore.setState({ balance: balances.ui.SOL ?? "0", tokenBalances: { ...balances.ui }, depositedBalances });
    })
    .finally(() => refreshes.delete(address));
  refreshes.set(address, request);
  return request;
}

/**
 * Connected wallet (Wallet Standard autodetect: Phantom / Backpack / Solflare) mirrored into the
 * user store, with connect (opens the wallet-adapter modal) / disconnect / refresh helpers.
 */
export function useWallet() {
  const wallet = useSolanaWallet();
  const { setVisible } = useWalletModal();
  const address = wallet.publicKey?.toBase58() ?? null;
  const storedAddress = useUserStore((s) => s.address);
  const balance = useUserStore((s) => s.balance);
  const tokenBalances = useUserStore((s) => s.tokenBalances);
  const depositedBalances = useUserStore((s) => s.depositedBalances);
  const storeIsLoading = useUserStore((s) => s.isLoading);

  const refreshBalances = useCallback(
    async (target: string | null | undefined = address) => {
      if (!target) return;
      try {
        await refreshWalletBalancesOnChain(target);
      } catch (error) {
        console.warn("Solana balance refresh failed", error);
      }
    },
    [address],
  );

  useEffect(() => {
    if (wallet.connected && address) {
      if (storedAddress !== address) {
        // Switching wallets: never let the previous wallet's figures bleed into the new one.
        clearMarginAccount();
        useUserStore.setState({ tokenBalances: emptyBalanceMap(), depositedBalances: emptyBalanceMap(), balance: "0" });
      }
      useUserStore.getState().set({
        address,
        isConnected: true,
        walletName: wallet.wallet?.adapter.name ?? null,
        manuallyDisconnected: false,
        isLoading: false,
      });
      // The root MarginAccountHydrator loads one shared account snapshot on connect.
      return;
    }
    if (!wallet.connecting && storedAddress) {
      useUserStore.setState({
        address: null,
        isConnected: false,
        walletName: null,
        balance: "0",
        tokenBalances: emptyBalanceMap(),
        depositedBalances: emptyBalanceMap(),
        isLoading: false,
      });
      clearMarginAccount();
    }
  }, [wallet.connected, wallet.connecting, wallet.wallet, address, storedAddress]);

  const connectWallet = useCallback(async () => {
    setVisible(true);
  }, [setVisible]);

  const disconnectWallet = useCallback(async () => {
    await wallet.disconnect();
    useUserStore.setState({
      address: null,
      isConnected: false,
      walletName: null,
      balance: "0",
      tokenBalances: emptyBalanceMap(),
      depositedBalances: emptyBalanceMap(),
      manuallyDisconnected: true,
      isLoading: false,
    });
    clearMarginAccount();
    toast("Wallet disconnected");
  }, [wallet]);

  return {
    address,
    isConnected: wallet.connected,
    walletName: wallet.wallet?.adapter.name ?? null,
    walletIcon: wallet.wallet?.adapter.icon ?? null,
    balance,
    tokenBalances,
    depositedBalances,
    isLoading: wallet.connecting || storeIsLoading,
    connectWallet,
    disconnectWallet,
    refreshBalances,
  };
}
