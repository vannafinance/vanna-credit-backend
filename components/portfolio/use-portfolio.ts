"use client";

/**
 * Everything the Portfolio page shows, read once from the app's existing on-chain hooks and
 * combined with `portfolio-math.ts`:
 *
 * - wallet tokens (user store, refreshed on mount by the page) × oracle prices (`/api/prices`);
 * - lending supply and provable interest (`useUserPositions`, `useEarnTransactions`);
 * - the margin account as the program values it (`useV3Account`) plus token amounts from the
 *   account snapshot (`useAccountSnapshot`) and its decoded history (`useMarginHistory`);
 * - Phoenix perps (`usePerpsView` via `useV3Account`), Kamino farm positions (`useFarmPositions`)
 *   and the margin's spot positions (`useSpotPositions`).
 */
import { useMemo } from "react";
import { useUserStore } from "@/store/user";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useEarnTransactions, usePoolData, useUserPositions } from "@/hooks/use-earn";
import { useMarginHistory } from "@/hooks/use-margin";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { useV3Account } from "@/hooks/use-v3-account";
import { useSpotPositions } from "@/hooks/use-spot-positions";
import { useFarmPools, useFarmPositions } from "@/lib/farm/use-farm";
import { positionOf } from "@/lib/farm/basis-live";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import {
  farmEarnedBySymbol,
  farmEarnedUsd,
  interestAccruedUsd,
  lendingEarnedUsd,
  lendingUsd,
  netDepositedUsd,
  perpsFlowPnl,
  vaultEarnedUsd,
  walletUsd,
} from "./portfolio-math";

export function usePortfolio() {
  const address = useUserStore((s) => s.address);
  const tokenBalances = useUserStore((s) => s.tokenBalances);
  const prices = useTokenPrices();
  const acct = useV3Account();
  const { positions: lendPositions, isLoading: lendLoading } = useUserPositions();
  const { pools } = usePoolData();
  const earn = useEarnTransactions();
  const margin = useMarginHistory();
  const { snapshot } = useAccountSnapshot(address);
  const { pools: farmPools } = useFarmPools();
  const { positions: farmPositions, isLoading: farmLoading } = useFarmPositions(address);
  const spot = useSpotPositions();

  /** Oracle price per symbol: the margin's own price map first (what the HF uses), then /api/prices. */
  const px = useMemo(() => {
    const out: Record<string, number> = { ...prices };
    for (const [k, v] of Object.entries(acct.view?.account.prices ?? {})) if (v > 0) out[k] = v;
    return out;
  }, [prices, acct.view]);

  return useMemo(() => {
    const now = acct.now;
    const perps = acct.view?.positions ?? [];
    const venueValue = acct.view?.account.venueValueUsd ?? 0;

    const wallet = walletUsd(tokenBalances, px);
    const lending = lendingUsd(lendPositions, px);
    const marginEquity = now ? now.equity : 0;

    const lendEarned = lendingEarnedUsd(earn.earned, px);
    const perpsUnrealized = perps.reduce((t, p) => t + p.pnlUsd, 0);
    const perpsEquity = perps.reduce((t, p) => t + p.equityUsd, 0);
    const perpsFlow = perpsFlowPnl(margin.history, venueValue, perpsEquity);
    // Spot rows without an entry price the chain can prove (deposited tokens) have no P&L.
    const spotPnl = spot.positions.reduce((t, p) => t + (p.pnl ?? 0), 0);
    const spotTraded = spot.positions.filter((p) => p.source !== "deposit");
    // Earnings = value now − net put in: unknown (null) until the holdings are loaded, or a
    // still-loading position reads as the whole deposit lost.
    const farmBySym = farmLoading ? null : farmEarnedBySymbol(margin.history, farmPositions);
    const farmEarned = farmEarnedUsd(farmBySym, px);
    // Basis / Perena vaults held by the margin: receipts at NAV now − net USDC put in, per vault.
    const vaults = VAULTS.map((def) => ({ def, ...positionOf(def, snapshot?.api.margin, margin.rows, Boolean(margin.history?.complete)) }));
    const vaultEarned = snapshot?.api.margin ? vaultEarnedUsd(vaults) : null;
    const perpsPnl = perpsFlow.total ?? perpsUnrealized;
    // Trading: perps all-in (realized + open, from the margin's Phoenix flows) when the history is
    // complete, else the open positions' PnL; plus open spot PnL; plus Kamino farm and Basis /
    // Perena vault earnings when known.
    const trading = perpsPnl + spotPnl + (farmEarned ?? 0) + (vaultEarned ?? 0);

    const debtTokens: Record<string, number> = {};
    for (const [sym, b] of Object.entries(snapshot?.borrowedBalances ?? {})) debtTokens[sym] = parseFloat(b.amount) || 0;
    const interest = interestAccruedUsd(margin.rows, debtTokens, px);

    return {
      address,
      connected: Boolean(address),
      px,
      acct,
      pools,
      lendPositions,
      lendLoading,
      earn,
      margin,
      snapshot,
      farmPools,
      farmPositions,
      farmBySym,
      vaults,
      spot,
      totals: {
        net: wallet + lending + marginEquity,
        wallet,
        lending,
        marginEquity,
        lendEarned,
        trading,
        /** Trading split: perps all-in, open spot, Kamino farm, Basis / Perena vaults (USD; null = unknown). */
        tradingParts: { perps: perpsPnl, spot: spotPnl, farm: farmEarned, vaults: vaultEarned },
        perpsUnrealized,
        perpsRealized: perpsFlow.realized,
        spotPnl,
        /** Open positions Flash repay would close: perps, traded spot rows, farm positions. */
        openCount: perps.length + spotTraded.length + farmPositions.length,
        farmEarned,
        vaultEarned,
        netEarnings: (lendEarned ?? 0) + trading,
        interest,
        netDeposited: netDepositedUsd(margin.history, px),
        debtTokens,
      },
    };
  }, [address, acct, tokenBalances, px, lendPositions, lendLoading, pools, earn, margin, snapshot, farmPools, farmPositions, farmLoading, spot]);
}

export type Portfolio = ReturnType<typeof usePortfolio>;
