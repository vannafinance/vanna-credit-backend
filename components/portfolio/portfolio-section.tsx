"use client";

import { useState, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useEarnTransactions } from "@/hooks/use-earn";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { useTheme } from "@/contexts/theme-context";
import { Button } from "../ui/button";
import { AccountStats } from "../margin/account-stats";
import { AnimatedTabs } from "../ui/animated-tabs";
import { PORTFOLIO_STATS_ITEMS } from "@/lib/constants/portfolio";
import { LenderTab } from "./lender-tab";
import { TraderTab } from "./trader-tab";
import { InfoTooltip } from "@/components/ui/info-tooltip";

const PORTFOLIO_TABS = [
  { id: "lender", label: "Lender" },
  { id: "trader", label: "Trader" },
];

export const PortfolioSection = () => {
  const userAddress = useUserStore((user) => user.address);
  const tokenBalances = useUserStore((user) => user.tokenBalances);
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState("lender");

  // Real account-level figures. Prefer the /api/account snapshot (warmed by the
  // connect-time prefetch, so the cards fill even on a first Portfolio visit),
  // falling back to the live store — the same source the margin header reads, so
  // Portfolio and Margin never disagree.
  const { snapshot } = useAccountSnapshot(userAddress);
  const store = useMarginAccountInfoStore(
    useShallow((s) => ({
      totalCollateralValue: s.totalCollateralValue,
      netAvailableCollateral: s.netAvailableCollateral,
      totalBorrowedValue: s.totalBorrowedValue,
    })),
  );
  const marginAccountBalance = snapshot?.totalCollateralValue ?? store.totalCollateralValue ?? 0;
  const netAvailableCollateral = snapshot?.netAvailableCollateral ?? store.netAvailableCollateral ?? 0;
  const totalBorrowed = snapshot?.totalBorrowedValue ?? store.totalBorrowedValue ?? 0;

  // Wallet (spendable) USD = Σ wallet token balance × on-chain Pyth price, over the token registry.
  const prices = useTokenPrices();
  const walletUsd = useMemo(
    () =>
      Object.entries(tokenBalances).reduce(
        (sum, [sym, amt]) => sum + (parseFloat(String(amt)) || 0) * (prices[sym] ?? 0),
        0,
      ),
    [tokenBalances, prices],
  );

  // Net Earnings = Σ (current supplied value − net principal) × price, per asset, from
  // `computeEarnedInterest` (lib/solana/history.ts). That helper only returns a number when the
  // decoded on-chain supply/redeem history provably explains the wallet's current share balance;
  // otherwise it returns null and the asset is left out — a missing history entry means "principal
  // unknown", NEVER "principal is 0" (which would report the entire deposit as yield).
  const { earned, isLoading: earnTxLoading } = useEarnTransactions();
  const netEarnings = useMemo(() => {
    if (earnTxLoading || !earned) return 0;
    return Object.values(earned).reduce((sum, e) => {
      if (e.earned === null || e.earned <= 0) return sum;
      return sum + e.earned * (prices[e.symbol] ?? 0);
    }, 0);
  }, [earned, prices, earnTxLoading]);

  const fmtUsd = (n: number) =>
    `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const statsValues = {
    walletBalance: userAddress ? fmtUsd(walletUsd) : "-",
    marginAccountBalance: userAddress ? fmtUsd(marginAccountBalance) : "-",
    netAvailableCollateral: userAddress ? fmtUsd(netAvailableCollateral) : "-",
    totalBorrowed: userAddress ? fmtUsd(totalBorrowed) : "-",
  };

  return (
    <div className="w-full h-fit flex flex-col gap-[16px]">
      {/* Stats grid */}
      <AccountStats
        gridCols="grid-cols-4"
        items={PORTFOLIO_STATS_ITEMS}
        values={statsValues}
      />

      {/* Net Earnings — real accrued lending interest. The over-time chart is
          not built yet (no value-over-time series), but the figure is live. */}
      <div
        className={`w-full rounded-[16px] border px-5 py-5 flex items-center justify-between ${
          isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"
        }`}
      >
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1 text-[13px] font-medium text-[#777777]">
            Net Earnings
            <InfoTooltip
              label="Net Earnings information"
              placement="bottom"
              content="Interest earned from supplied assets."
            />
          </span>
          <span className={`text-[22px] font-bold ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>
            {userAddress ? fmtUsd(netEarnings) : "-"}
          </span>
          <span className="text-[11px] font-medium text-[#777777]">Accrued lending interest</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="w-full h-fit flex flex-col">
        <AnimatedTabs
          type="underline"
          tabs={PORTFOLIO_TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          containerClassName="w-fit"
          tabClassName="h-[40px] sm:h-[44px] text-[13px] sm:text-[14px] w-[100px] sm:w-[120px]"
        />

        {!userAddress ? (
          <div
            className={`w-full h-[260px] rounded-b-[20px] flex items-center justify-center ${
              isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"
            }`}
          >
            <div className="w-[70px]">
              <Button text="Login" size="small" type="solid" disabled={false} />
            </div>
          </div>
        ) : (
          <div className="w-full h-fit pt-4 sm:pt-[16px]">
            {activeTab === "lender" && <LenderTab />}
            {activeTab === "trader" && <TraderTab />}
          </div>
        )}
      </div>
    </div>
  );
};
