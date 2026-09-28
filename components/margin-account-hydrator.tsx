"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUserStore } from "@/store/user";
import { checkUserMarginAccount } from "@/store/margin-account-info-store";
import { prefetchAccountSnapshot } from "@/hooks/use-account-snapshot";
import { useLedgerTick } from "@/contexts/ledger-subscriber";
import { refreshWalletBalancesOnChain } from "@/hooks/use-wallet";

/**
 * Hydrates the margin store and wallet balances whenever the wallet connects (so any page can
 * read them on first render) and re-reads them on every slot tick.
 */
export function MarginAccountHydrator() {
  const address = useUserStore((s) => s.address);
  const isConnected = useUserStore((s) => s.isConnected);
  const qc = useQueryClient();
  const { tick } = useLedgerTick();

  useEffect(() => {
    if (address && isConnected) {
      checkUserMarginAccount(address).catch(console.error);
      prefetchAccountSnapshot(qc, address);
    }
  }, [address, isConnected, qc]);

  useEffect(() => {
    if (!address || !isConnected || tick === 0) return;
    checkUserMarginAccount(address).catch(() => {});
    refreshWalletBalancesOnChain(address).catch(() => {});
  }, [tick, address, isConnected]);

  return null;
}
