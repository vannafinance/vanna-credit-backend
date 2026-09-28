"use client";

import { Carousel } from "@/components/ui/carousel";
import {
  ACCOUNT_STATS_ITEMS,
  CAROUSEL_ITEMS,
  MARGIN_ACCOUNT_INFO_ITEMS,
  MARGIN_ORACLE_LTS_ITEMS,
} from "@/lib/constants/margin";
import { motion, AnimatePresence } from "framer-motion";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Image from "next/image";
import { InfoCard } from "@/components/margin/info-card";
import { LeverageCollateral } from "@/components/margin/leverage-collateral";
import { Positionstable } from "@/components/margin/positions-table";
import { AccountStats } from "@/components/margin/account-stats";
import {
  useMarginAccountInfoStore,
  applyMarginSnapshot,
  checkUserMarginAccount,
} from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import { formatValue } from "@/lib/utils/format-value";
import { useTheme } from "@/contexts/theme-context";
import { useShallow } from "zustand/shallow";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { deriveMarginHealth } from "@/lib/margin-health";
import { accountLeverage } from "@/lib/margin/amounts";
import { LIQUIDATION_HEALTH_FACTOR, PYTH_RECEIVER_PROGRAM_ID, VANNA_PROGRAM_ID } from "@/lib/solana/config";

interface MarginPageContentProps {
  /** Path this page lives at — the ?repay=<asset> hand-off is stripped back to it. */
  basePath: string;
  /** `<main>` classes (the /margin route scrolls inside a fixed-height main; home scrolls the page). */
  mainClassName?: string;
}

/**
 * The margin page (rendered at both `/` and `/margin` — same UX): carousel, account
 * KPIs, the Leverage / Repay / Transfer panel, the Margin Account Info card and the
 * positions table.
 *
 * Every figure comes from the on-chain margin snapshot (GET /api/account/:wallet via
 * `useAccountSnapshot`, fed into the margin store with `applyMarginSnapshot`), so the
 * header, the info card, the tabs and the positions table all read the same numbers.
 * Health is account-wide: HF = Σ collateral USD / Σ debt USD (∞ with no debt),
 * liquidatable at HF <= 1.10; leverage = gross collateral / net equity.
 *
 * useSearchParams() opts the page out of static prerendering, so callers wrap this in
 * a Suspense boundary.
 */
export const MarginPageContent = ({
  basePath,
  mainClassName = "w-full h-[calc(100vh-56px)] lg:h-[calc(100vh-72px)] overflow-y-auto scrollbar-hide px-4 sm:px-10 lg:px-30 pb-8 lg:pb-0",
}: MarginPageContentProps) => {
  const { isDark } = useTheme();
  const searchParams = useSearchParams();
  const router = useRouter();

  // State to trigger tab switch to Repay Loan
  const [switchToRepayTab, setSwitchToRepayTab] = useState(false);
  const [prefilledRepayAsset, setPrefilledRepayAsset] = useState<string | undefined>(undefined);
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  // Ref for scrolling to LeverageCollateral component
  const leverageCollateralRef = useRef<HTMLDivElement>(null);

  const scrollToLeverageSection = useCallback(() => {
    if (leverageCollateralRef.current) {
      leverageCollateralRef.current.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }, []);

  // Scroll to LeverageCollateral when repay is clicked
  useEffect(() => {
    if (switchToRepayTab) {
      setTimeout(() => {
        scrollToLeverageSection();
      }, 100);
    }
  }, [switchToRepayTab, scrollToLeverageSection]);

  // Portfolio's per-asset Repay button hands off here via ?repay=<asset> (it
  // has no Repay UI of its own) — consume it once on arrival, then strip it
  // from the URL so a manual refresh doesn't re-trigger the tab switch.
  useEffect(() => {
    const repayAsset = searchParams.get("repay");
    if (repayAsset !== null) {
      setPrefilledRepayAsset(repayAsset || undefined);
      setSwitchToRepayTab(true);
      router.replace(basePath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Wallet connection state — single shallow-compared read
  const { isWalletConnected, userAddress } = useUserStore(
    useShallow((state) => ({
      isWalletConnected: state.isConnected,
      userAddress: state.address,
    })),
  );

  // Margin account data — single shallow-compared read.
  const {
    hasMarginAccount,
    grossCollateralValue,
    totalBorrowedValue,
    timeToLiquidation,
    storeBorrowRate,
  } = useMarginAccountInfoStore(
    useShallow((state) => ({
      hasMarginAccount: state.hasMarginAccount,
      grossCollateralValue: state.grossCollateralValue,
      totalBorrowedValue: state.totalBorrowedValue,
      timeToLiquidation: state.timeToLiquidation,
      storeBorrowRate: state.borrowRate,
    })),
  );

  // Discover the margin account whenever the wallet connects (margin state is reset on
  // disconnect and rediscovered from chain — nothing is persisted client-side).
  useEffect(() => {
    if (userAddress && isWalletConnected) {
      checkUserMarginAccount(userAddress).catch(console.error);
    }
  }, [userAddress, isWalletConnected]);

  // Per-user stats come from GET /api/account/[addr] (a live chain read, revalidated on
  // slot ticks and invalidated after every margin tx). The snapshot is fed into the
  // store with a shallow replace so every consumer (tabs, positions table) reads the
  // same numbers and a repaid asset's key can't linger.
  const { snapshot, error: snapshotError } = useAccountSnapshot(userAddress);

  useEffect(() => {
    if (snapshot?.api?.margin) applyMarginSnapshot(snapshot.api.margin);
  }, [snapshot]);

  const marginError = snapshotError && snapshotError !== dismissedError ? snapshotError : null;
  const setMarginError = (value: string | null) => {
    if (value === null) setDismissedError(snapshotError);
  };

  // Source the displayed stats from the snapshot directly (available on first paint),
  // falling back to the store for the post-mutation refresh path. `??` preserves a
  // legitimate 0 (an empty account) rather than masking it.
  const effHasAccount = snapshot?.hasMarginAccount ?? hasMarginAccount;
  const effGrossCollateral = snapshot?.grossCollateralValue ?? grossCollateralValue;
  const effBorrowed = snapshot?.totalBorrowedValue ?? totalBorrowedValue;
  const effBorrowRate = snapshot?.borrowRate ?? storeBorrowRate;
  const stalePrices = snapshot?.api?.margin?.stalePrices ?? [];

  // The risk trio (HF, net-available, collateral-left) is RECOMPUTED from the gross
  // collateral + debt being displayed so all KPI cards (and the InfoCard) stay coherent.
  const derivedHealth = deriveMarginHealth({
    grossCollateralValue: effGrossCollateral,
    effectiveDebtValue: effBorrowed > 0 ? effBorrowed : 0,
    totalBorrowedValue: effBorrowed,
  });
  const effHealthFactor = derivedHealth.avgHealthFactor;
  const effNetAvailable = derivedHealth.netAvailableCollateral;
  const effCollateralLeft = derivedHealth.collateralLeftBeforeLiquidation;

  // Net leverage = gross collateral / net equity — same formula as the positions table.
  const effNetLeverage = useMemo(() => {
    const lev = accountLeverage(effGrossCollateral, effBorrowed);
    return lev > 0 ? parseFloat(lev.toFixed(2)) : 0;
  }, [effGrossCollateral, effBorrowed]);

  // Shimmer (never a 0 or spinner) until we have a snapshot to show.
  const showStatsSkeleton = isWalletConnected && !snapshot;

  const accountStats = useMemo(() => {
    const hasAnyMarginData =
      effHasAccount || effGrossCollateral > 0 || effBorrowed > 0;

    if (!hasAnyMarginData) {
      return null;
    }

    return {
      netHealthFactor: effHealthFactor,
      collateralLeftBeforeLiquidation: effCollateralLeft,
      netAvailableCollateral: effNetAvailable,
      netAmountBorrowed: effBorrowed,
      netLeverageTaken: effNetLeverage,
    };
  }, [
    effHealthFactor,
    effCollateralLeft,
    effNetAvailable,
    effBorrowed,
    effNetLeverage,
    effGrossCollateral,
    effHasAccount,
  ]);

  // InfoCard data. Liquidation premium / fee, min/max debt and time-to-liquidation are
  // not exposed by the margin snapshot, so those rows aren't shown (no made-up numbers).
  const infoCardData = useMemo(() => {
    const hasAnyMarginData = effHasAccount || effGrossCollateral > 0 || effBorrowed > 0;
    return {
      totalBorrowedValue: hasAnyMarginData ? effBorrowed : 0,
      // "Net Available Collateral" = gross vault collateral − debt (net equity).
      totalCollateralValue: hasAnyMarginData ? effNetAvailable : 0,
      totalValue: hasAnyMarginData ? effBorrowed + effNetAvailable : 0,
      avgHealthFactor: hasAnyMarginData ? effHealthFactor : 0,
      timeToLiquidation,
      // Debt-weighted borrow APR is a fraction; the percentage formatter expects percent.
      borrowRate: hasAnyMarginData ? effBorrowRate * 100 : 0,
      oracleContract: PYTH_RECEIVER_PROGRAM_ID.toBase58(),
      liquidationThreshold: `${LIQUIDATION_HEALTH_FACTOR.toFixed(2)}x`,
      riskEngine: VANNA_PROGRAM_ID.toBase58(),
    };
  }, [effHasAccount, effGrossCollateral, effBorrowed, effNetAvailable, effHealthFactor, effBorrowRate, timeToLiquidation]);

  // Expandable sections — stable array (constants are already stable).
  const infoCardExpandableSections = useMemo(
    () => [
      {
        title: "ORACLES AND LTS",
        headingBold: true,
        items: MARGIN_ORACLE_LTS_ITEMS,
        defaultExpanded: false,
        delay: 0.1,
      },
    ],
    [],
  );

  // Stable handlers for memoized children.
  const handleTabSwitched = useCallback(() => setSwitchToRepayTab(false), []);
  const handleRepayClick = useCallback((asset?: string) => {
    setPrefilledRepayAsset(asset);
    setSwitchToRepayTab(true);
  }, []);

  // Format account stats value with explicit units, following industry
  // conventions: Health Factor is a bare unitless ratio (never with ×), leverage is
  // Nx (never $), USD totals with $ prefix.
  const formatAccountStatValue = (itemId: string, value: number) => {
    if (itemId === "netHealthFactor") {
      if (value === Infinity || !isFinite(value) || value >= 999) {
        return "∞";
      }
      return formatValue(value, {
        type: "health-factor",
        showZeroAsDash: false,
      });
    }

    // Always "3.31x" style — never fall through to the USD formatter below.
    if (itemId === "netLeverageTaken") {
      if (!Number.isFinite(value) || value <= 0) return "—";
      return `${value.toFixed(2)}x`;
    }

    const usdText = formatValue(Math.abs(value), {
      type: "number",
      useLargeFormat: true,
      showZeroAsDash: false,
    });

    // Sub-cent (but non-zero) → "<$0.01" rather than a misleading "$0.00".
    const isDust = Math.abs(value) > 0 && Math.abs(value) < 0.01;
    if (isDust) return "<$0.01";
    return `$${usdText}`;
  };

  // Prepare account stats values for AccountStats component. The loading state
  // is handled by the shimmer (showStatsSkeleton).
  const accountStatsValues = useMemo(() => {
    return ACCOUNT_STATS_ITEMS.reduce(
      (acc, item) => {
        const value = accountStats
          ? (accountStats[item.id as keyof typeof accountStats] ?? 0)
          : 0;
        acc[item.id] = formatAccountStatValue(item.id, value);
        return acc;
      },
      {} as Record<string, string>,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountStats]);

  const accountStatsValueColors = useMemo(() => ({} as Record<string, string>), []);

  return (
    <main className={mainClassName}>
      {/* Error banner for margin data loading issues */}
      <AnimatePresence>
        {marginError && (
          <motion.div
            className="w-full pt-5"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div
              className={`${
                marginError.includes("wait") ||
                marginError.includes("Rate limit")
                  ? "bg-yellow-100 border-yellow-400 text-yellow-800"
                  : "bg-red-100 border-red-400 text-red-700"
              } border px-4 py-3 rounded relative flex items-center gap-3`}
              role="alert"
            >
              {/* Icon */}
              {marginError.includes("wait") ||
              marginError.includes("Rate limit") ? (
                <svg
                  className="w-6 h-6 shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : (
                <svg
                  className="w-6 h-6 shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
              )}

              {/* Message */}
              <div className="flex-1">
                <span className="block sm:inline">{marginError}</span>
              </div>

              {/* Close button */}
              <button
                onClick={() => setMarginError(null)}
                className="shrink-0 ml-auto"
              >
                <svg
                  className="w-5 h-5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stale-price notice — the service refreshes prices automatically before a
          borrow / withdraw, so this is informational only. */}
      <AnimatePresence>
        {isWalletConnected && stalePrices.length > 0 && (
          <motion.div
            className="w-full pt-5"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className="bg-yellow-100 border border-yellow-400 text-yellow-800 px-4 py-3 rounded-xl text-[13px] font-medium" role="status">
              On-chain price for {stalePrices.join(", ")} is older than its max age — USD values may lag. Prices are refreshed automatically before any borrow or withdraw.
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Liquidation danger banner — shown when own HF drops below 1.1 */}
      <AnimatePresence>
        {isWalletConnected && effHasAccount && effHealthFactor > 0 && effHealthFactor <= LIQUIDATION_HEALTH_FACTOR && (
          <motion.div
            className="w-full pt-5"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className="bg-rose-100 border border-rose-400 text-rose-800 px-4 py-3 rounded-xl flex items-start gap-3">
              <svg className="w-6 h-6 shrink-0 mt-0.5 text-rose-600" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <div className="flex-1">
                <p className="font-bold text-[14px]">
                  Liquidation Risk — Health Factor {effHealthFactor.toFixed(2)} (at or below 1.10)
                </p>
                <p className="text-[13px] mt-0.5">
                  Your account is undercollateralised and can be liquidated by anyone. Repay debt or add collateral immediately to restore your Health Factor above 1.1.
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Carousel section - displays promotional items */}
      <motion.section
        className="w-full h-fit pt-4 sm:pt-6 pb-3 sm:pb-4"
        initial={{ opacity: 0, y: 50 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: 0.8,
          ease: "easeOut",
          delay: 0.2,
        }}
      >
        <Carousel items={[...CAROUSEL_ITEMS]} autoplayInterval={5000} />
      </motion.section>

      {isWalletConnected && (
        <motion.section
          className="w-full h-auto pb-2 sm:pb-0"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        >
          <AccountStats
            items={ACCOUNT_STATS_ITEMS}
            values={accountStatsValues}
            valueColors={accountStatsValueColors}
            gridCols="grid-cols-5"
            compact
            loading={showStatsSkeleton}
          />
        </motion.section>
      )}

      {/* Main leverage section */}
      <section className="w-full pt-6 pb-4 sm:pb-6 lg:pb-10 flex flex-col gap-3">
        {/* Section heading */}
        <motion.header
          ref={leverageCollateralRef}
          className="w-full flex items-center gap-3"
          initial={{ opacity: 0, x: -20 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          <h1 className={`text-[20px] font-bold ${isDark ? "text-white" : ""}`}>
            Leverage your Collateral
          </h1>
        </motion.header>

        {/* Responsive layout — stacked on mobile/tablet, side-by-side on desktop */}
        <div
          className="flex flex-col lg:grid lg:items-start gap-5 sm:gap-6 margin-layout-cols min-w-0 w-full"
        >
          <div className="w-full min-w-0">
            <LeverageCollateral
              switchToRepayTab={switchToRepayTab}
              onTabSwitched={handleTabSwitched}
              prefilledRepayAsset={prefilledRepayAsset}
            />
          </div>

          {/* Right: Margin account info card */}
          <motion.aside
            className="flex flex-col gap-3 h-fit w-full min-w-0 lg:sticky lg:top-4 lg:self-start"
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          >
            <motion.header
              className="flex gap-2.5 items-start"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            >
              <motion.div
                className="border flex flex-col justify-center items-center p-1.5 rounded-[11px] w-11 h-11 shrink-0"
                initial={{ scale: 0, rotate: -180 }}
                whileInView={{ scale: 1, rotate: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, type: "spring", stiffness: 200 }}
              >
                <Image
                  alt="vanna"
                  src="/logos/vanna-icon.png"
                  width={22}
                  height={20}
                />
              </motion.div>
              <div className="flex flex-col flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h2
                    className={`text-lg font-bold ${isDark ? "text-white" : ""}`}
                  >
                    Margin Account Info
                  </h2>
                </div>
                <p className="w-full text-sm font-medium text-gray-400">
                  Stay updated details and status.
                </p>
              </div>
            </motion.header>

            <InfoCard
              data={infoCardData}
              items={MARGIN_ACCOUNT_INFO_ITEMS}
              showExpandable={true}
              expandableSections={infoCardExpandableSections}
              loading={showStatsSkeleton}
            />
          </motion.aside>
        </div>

        {/* Positions table section */}
        {isWalletConnected && (
          <motion.section
            className="w-full h-fit pt-3"
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-100px" }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          >
            <Positionstable
              onRepayClick={handleRepayClick}
              onOpenPositionClick={scrollToLeverageSection}
            />
          </motion.section>
        )}
      </section>
    </main>
  );
};
