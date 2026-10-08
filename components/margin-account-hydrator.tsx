"use client";

import { useEffect } from "react";
import { useUserStore } from "@/store/user";
import { applyMarginSnapshot } from "@/store/margin-account-info-store";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";

/** One shared account query hydrates stores and page consumers on connect and ledger ticks. */
export function MarginAccountHydrator() {
  const address = useUserStore((s) => s.address);
  const isConnected = useUserStore((s) => s.isConnected);
  const { snapshot } = useAccountSnapshot(isConnected ? address : null);

  useEffect(() => {
    if (!snapshot || !address || !isConnected) return;
    const { api } = snapshot;
    // Drop late responses from a wallet that disconnected or changed during the read.
    if (api.margin.owner !== address || useUserStore.getState().address !== address) return;
    applyMarginSnapshot(api.margin);
    useUserStore.setState({
      balance: api.wallet.ui.SOL ?? "0",
      tokenBalances: { ...api.wallet.ui },
      depositedBalances: Object.fromEntries(Object.values(api.lender).map((p) => [p.symbol, String(p.assets)])),
    });
  }, [snapshot, address, isConnected]);

  return null;
}
