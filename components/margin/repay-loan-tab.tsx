"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useMemo } from "react";
import { DropdownOptions } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { formatTokenAmount, formatUsdValue } from "@/lib/utils/format-amount";
import { Dropdown } from "../ui/dropdown";
import { Popup } from "@/components/ui/popup";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import { ConversionRatio } from "@/components/ui/conversion-ratio";
import { MarginActionPreview, type PreviewRow } from "@/components/margin/margin-action-preview";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { useMarginHistory, useRepay } from "@/hooks/use-margin";
import { findToken } from "@/lib/solana/tokens";
import {
  HF_INFINITY,
  accruedInterestBySymbol,
  checkRepaySource,
  liquidationBufferUsd,
  projectedHealthFactor,
  toTokenAmountString,
} from "@/lib/margin/amounts";

const formatHF = (hf: number): string =>
  !Number.isFinite(hf) || hf >= HF_INFINITY ? "∞" : hf.toFixed(2);
// Delegate to the shared adaptive formatter so sub-cent values show "<$0.01"
// instead of a misleading "$0.00" — consistent with the rest of the UI.
const formatUsd = (n: number): string => formatUsdValue(n);

const REPAY_DUST_EPSILON = 1e-9;
const formatDetailedTokenAmount = (value: number): string =>
  Number.isFinite(value)
    ? value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 9 })
    : "0";

/** Where the repayment is paid from. */
type RepaySource = "margin" | "wallet";

interface RepayLoanTabProps {
  /** Asset to preselect on mount / when changed (e.g. from a positions-row Repay click). */
  prefilledAsset?: string;
}

/** Registry symbol for any accepted spelling ("sol", "wSOL" → "SOL"); null when unknown. */
const toDropdownAsset = (raw: string | undefined): string | null => findToken(raw)?.symbol ?? null;

const clampRepayDust = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.abs(value) < REPAY_DUST_EPSILON ? 0 : value;
};

/**
 * Repay tab for paying down an outstanding margin loan in a chosen asset. Shows
 * the true on-chain debt accrued to fork-now ("Net Outstanding Amount to Repay")
 * and the balance of that asset in the chosen SOURCE side by side, both in token
 * units with a live USD line, plus a form with quick-% chips and a free-text amount.
 *
 * Source toggle: MB = repay from the margin vault (`user_repay_from_margin`), WB =
 * repay from the wallet (`public_repay_from_wallet`). The 100% chip is a FULL repay
 * (`repay_all`, which also closes the debt position): the source must then hold the
 * debt + 0.2% accrual buffer. Borrowed SOL sitting in the vault is slightly LESS than
 * the accrued debt, so a full repay from margin is often short — the tab explains
 * that and offers the wallet instead (see `checkRepaySource`). The preview (before →
 * after debt / HF / liquidation buffer) is rendered by {@link RepayPreviewSection}.
 */
export const RepayLoanTab = ({ prefilledAsset }: RepayLoanTabProps = {}) => {
  const { isDark } = useTheme();

  const snapshot = useMarginAccountInfoStore((s) => s.snapshot);
  const hasMarginAccount = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const tokenBalances = useUserStore((state) => state.tokenBalances);

  // Default to the first asset with outstanding debt (else the first registry token).
  const firstDebtSymbol = snapshot?.debts.find((d) => d.debt > 0)?.symbol;
  const [selectedRepayCurrency, setSelectedRepayCurrency] =
    useState<string>(() => toDropdownAsset(prefilledAsset) ?? firstDebtSymbol ?? DropdownOptions[0]);
  const [repaySource, setRepaySource] = useState<RepaySource>("margin");
  const [selectedRepayPercentage, setSelectedRepayPercentage] =
    useState<number>(0);
  // The amount field is held as a RAW STRING while editing — converting to a
  // Number on each keystroke turned a partial "." into NaN and dropped trailing
  // decimals. `repayAmount` is derived for all numeric uses; the input shows
  // `repayInput` verbatim.
  const [repayInput, setRepayInput] = useState<string>("");
  const repayAmount = parseFloat(repayInput) || 0;

  // Sync currency when caller asks to prefill (e.g. row-level Repay click)
  useEffect(() => {
    const mapped = toDropdownAsset(prefilledAsset);
    if (mapped) {
      setSelectedRepayCurrency(mapped);
      setRepayInput("");
      setSelectedRepayPercentage(0);
    }
  }, [prefilledAsset]);

  // Reset local state on wallet disconnect so the previous user's figures don't linger.
  const globalIsConnected = useUserStore((state) => state.isConnected);
  const globalAddress = useUserStore((state) => state.address);
  useEffect(() => {
    if (!globalIsConnected || !globalAddress) {
      setRepayInput("");
      setSelectedRepayPercentage(0);
    }
  }, [globalIsConnected, globalAddress]);

  // Debt (accrued to fork-now) and vault balance of the selected asset — both from the
  // same on-chain margin snapshot, so they can never mix a fresh and a stale read.
  const debtEntry = snapshot?.debts.find((d) => d.symbol === selectedRepayCurrency);
  const vaultEntry = snapshot?.collateral.find((c) => c.symbol === selectedRepayCurrency);
  const outstandingDebt = globalAddress ? clampRepayDust(debtEntry?.debt ?? 0) : 0;
  const vaultBalance = globalAddress ? clampRepayDust(vaultEntry?.amount ?? 0) : 0;
  const walletBalance = globalAddress ? parseFloat(tokenBalances[selectedRepayCurrency] || "0") || 0 : 0;
  const sourceBalance = repaySource === "margin" ? vaultBalance : walletBalance;

  const repayStats = {
    netOutstandingAmountToPay: outstandingDebt,
    availableBalance: sourceBalance,
  };

  // Live on-chain (fork Pyth) price; 0 while unknown.
  const tokenPrices = useTokenPrices();
  const selectedTokenPrice = tokenPrices[selectedRepayCurrency] ?? 0;
  const repayAmountInUsd = repayAmount * selectedTokenPrice;

  // Interest accrued since this debt position was opened, from decoded on-chain events.
  // null when the open-debt event isn't in the scanned history (never faked as 0).
  const { rows: marginHistoryRows, isLoading: marginHistoryLoading } = useMarginHistory();
  const selectedAccruedInterest = useMemo(() => {
    if (marginHistoryLoading || !(outstandingDebt > 0)) return null;
    return accruedInterestBySymbol(marginHistoryRows, { [selectedRepayCurrency]: outstandingDebt })[selectedRepayCurrency] ?? null;
  }, [marginHistoryRows, marginHistoryLoading, outstandingDebt, selectedRepayCurrency]);

  // Popup visibility states
  const [isPayNowPopupOpen, setIsPayNowPopupOpen] = useState(false);

  // Both stat tiles are denominated in tokens of the selected repay currency.
  // Primary line shows the token amount (the actual on-chain debt/balance),
  // secondary line shows the live USD equivalent via the oracle price.
  const formatStatValue = (value: number): { token: string; usd: string | null } => {
    const cleaned = clampRepayDust(value);
    const token = `${formatTokenAmount(cleaned)} ${selectedRepayCurrency}`;
    const usd = selectedTokenPrice > 0 ? `≈ ${formatUsdValue(cleaned * selectedTokenPrice)}` : null;
    return { token, usd };
  };

  // Full repay = the 100% chip, or a typed amount that covers the whole debt.
  const isFullRepay = selectedRepayPercentage === 100 || (outstandingDebt > 0 && repayAmount >= outstandingDebt);

  // Pre-check the source exactly like the service will (debt + 0.2% buffer for a full repay).
  const sourceCheck = checkRepaySource({
    symbol: selectedRepayCurrency,
    source: repaySource,
    all: isFullRepay,
    amount: repayAmount,
    debt: outstandingDebt,
    vaultAmount: vaultBalance,
    walletAmount: walletBalance,
  });

  // Handler for percentage click. 10/25/50% are fractions of the TRUE debt, capped to the
  // source balance (more than the source holds can never succeed). 100% is a full repay
  // (repay_all) — never capped; if the source is short, the check below says so.
  const handlePercentageClick = (item: number) => {
    setSelectedRepayPercentage(item);
    if (item === 100) {
      setRepayInput(toTokenAmountString(outstandingDebt, selectedRepayCurrency) || "");
      return;
    }
    const rawFraction = (outstandingDebt * item) / 100;
    const target = Math.min(rawFraction, sourceBalance);
    setRepayInput(toTokenAmountString(clampRepayDust(target), selectedRepayCurrency));
  };

  // Handler for input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = validateAmountChange(e.target.value);
    if (sanitized === null) return; // invalid char — toast already shown
    // A percentage chip is only a shortcut for filling the field. Once the
    // user edits that value, the typed amount becomes authoritative.
    setSelectedRepayPercentage(0);
    setRepayInput(sanitized);
  };

  const handleCurrencyChange = (currency: string) => {
    setSelectedRepayCurrency(currency);
    setRepayInput("");
    setSelectedRepayPercentage(0);
  };

  const handleSourceChange = (source: RepaySource) => {
    setRepaySource(source);
    // A partial chip amount was capped to the old source's balance — recompute it.
    if (selectedRepayPercentage > 0 && selectedRepayPercentage < 100) {
      setRepayInput("");
      setSelectedRepayPercentage(0);
    }
  };

  // Repay via the service (`repay` in lib/solana/margin.ts). No optimistic write — the
  // position reflects ONLY confirmed on-chain state (useRepay refreshes the store after).
  const repayMutation = useRepay();

  // Handler for pay now click
  const handlePayNowClick = async () => {
    if (!(repayAmount > 0) || !sourceCheck.ok) return;
    try {
      await repayMutation.mutateAsync(
        isFullRepay
          ? { symbol: selectedRepayCurrency, all: true, source: repaySource }
          : { symbol: selectedRepayCurrency, amount: toTokenAmountString(repayAmount, selectedRepayCurrency), source: repaySource },
      );
      setRepayInput("");
      setSelectedRepayPercentage(0);
    } catch {
      // Progress modal already shows the decoded error (useRepay).
    } finally {
      setIsPayNowPopupOpen(false);
    }
  };

  // Handler for closing pay now popup
  const handleClosePayNowPopup = () => {
    setIsPayNowPopupOpen(false);
  };

  // Check if buttons should be disabled (when input is 0 or empty)
  const isInputEmpty = !(repayAmount > 0);

  // Surface a short source up front instead of letting the user hit Pay Now and land on
  // the service's insufficient-balance error.
  const exceedsAvailableBalance = !isInputEmpty && !sourceCheck.ok;

  return (
    <motion.section
      className="w-full flex flex-col gap-6 pt-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, delay: 0.1 }}
    >
      <motion.section
        className="flex flex-col gap-[43px] h-full"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3, delay: 0.2 }}
      >
        {/* Repay stats cards */}
        <motion.section
          className="grid grid-cols-1 sm:grid-cols-2 gap-3"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.2 }}
        >
          {Object.entries(repayStats).map(([key, value], index) => (
            <motion.article
              key={key}
              className={`w-full flex flex-col gap-2 rounded-2xl border p-3 sm:p-4 ${
                isDark
                  ? "bg-[#1A1A1A] border-[#2A2A2A]"
                  : "bg-white border-[#EEEEEE]"
              }`}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.1 + index * 0.1 }}
            >
              <span
                className={`flex items-center gap-1 text-[12px] font-medium ${
                  isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                }`}
              >
                {key === "netOutstandingAmountToPay" ? (
                  <>
                    Net Outstanding Amount to Repay
                    <InfoTooltip
                      placement="bottom"
                      size="regular"
                      label={`${selectedRepayCurrency} outstanding loan and accrued interest details`}
                      content={(
                        <span className="flex flex-col gap-1">
                          {selectedAccruedInterest !== null ? (
                            <>
                              <span>
                                Net borrowed amount: {formatDetailedTokenAmount(Math.max(0, repayStats.netOutstandingAmountToPay - selectedAccruedInterest))} {selectedRepayCurrency}
                              </span>
                              <span>
                                Interest accrued till date: {formatDetailedTokenAmount(selectedAccruedInterest)} {selectedRepayCurrency} (≈ {formatUsdValue(selectedAccruedInterest * selectedTokenPrice)})
                              </span>
                              <span>
                                Total outstanding loan: {formatDetailedTokenAmount(repayStats.netOutstandingAmountToPay)} {selectedRepayCurrency}
                              </span>
                            </>
                          ) : (
                            <>
                              <span>
                                Total outstanding loan: {formatDetailedTokenAmount(repayStats.netOutstandingAmountToPay)} {selectedRepayCurrency}
                              </span>
                              <span>Principal and interest breakdown is unavailable: the transaction that opened this debt position is outside the scanned on-chain history.</span>
                            </>
                          )}
                        </span>
                      )}
                    />
                  </>
                ) : (
                  <>
                    {repaySource === "margin" ? "Available Balance in Margin Account" : "Available Balance in Wallet"}
                    <InfoTooltip
                      placement="bottom"
                      label="Available repay source balance information"
                      content={repaySource === "margin"
                        ? "Selected asset held in your margin account's vault (borrowed tokens included)."
                        : "Selected asset in your connected wallet. SOL keeps 0.05 SOL for fees."}
                    />
                  </>
                )}
              </span>
              {(() => {
                const { token, usd } = formatStatValue(value);
                return (
                  <>
                    <span
                      className={`text-[22px] font-bold leading-tight ${
                        isDark ? "text-white" : "text-[#111111]"
                      }`}
                    >
                      {token}
                    </span>
                    {usd && (
                      <span
                        className={`text-[12px] font-medium ${
                          isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                        }`}
                      >
                        {usd}
                      </span>
                    )}
                  </>
                );
              })()}
            </motion.article>
          ))}
        </motion.section>

        {/* Repay form */}
        <motion.article
          className={`w-full rounded-2xl border p-3 sm:p-4 flex flex-col gap-2 ${
            isDark
              ? "bg-[#1A1A1A] border-[#2A2A2A]"
              : "bg-white border-[#EEEEEE]"
          }`}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.3 }}
        >
          {/* Row 1: "Repay" label + % chips */}
          <div className="flex items-center justify-between">
            <span
              className={`text-sm font-medium ${
                isDark ? "text-[#A7A7A7]" : "text-[#777777]"
              }`}
            >
              Repay
            </span>
            <motion.div
              className="flex items-center gap-1 sm:gap-1.5"
              role="group"
              aria-label="Repay percentage"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.3, delay: 0.4 }}
            >
              {DEPOSIT_PERCENTAGES.map((item: number) => (
                <motion.button
                  type="button"
                  key={item}
                  onClick={() => handlePercentageClick(item)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer border transition-all ${
                    selectedRepayPercentage === item
                      ? `${PERCENTAGE_COLORS[item]} text-white border-transparent`
                      : isDark
                        ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                        : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                  }`}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.93 }}
                  transition={{ duration: 0.1 }}
                  aria-label={`Repay ${item} percent`}
                  aria-pressed={selectedRepayPercentage === item}
                >
                  {item}%
                </motion.button>
              ))}
            </motion.div>
          </div>

          {/* Row 2: token dropdown + amount input */}
          <div className="flex items-center justify-between gap-3">
            <div className="shrink-0">
              <Dropdown
                classname={`gap-2 px-3 py-2 rounded-full text-[14px] font-semibold transition-colors ${
                  isDark
                    ? "bg-[#333333] hover:bg-[#3D3D3D] text-white"
                    : "bg-[#EEEEEE] hover:bg-[#E2E2E2]"
                }`}
                items={DropdownOptions}
                selectedOption={selectedRepayCurrency}
                setSelectedOption={handleCurrencyChange}
                dropdownClassname="text-[13px] gap-2"
              />
            </div>
            <div className="flex-1 min-w-0">
              <label htmlFor="repay-amount-input" className="sr-only">
                Repay amount
              </label>
              <input
                id="repay-amount-input"
                onChange={handleInputChange}
                className={`w-full text-right text-[22px] sm:text-[28px] font-semibold bg-transparent outline-none placeholder:opacity-20 ${
                  isDark
                    ? "text-white placeholder:text-white"
                    : "text-[#111111] placeholder:text-[#111111]"
                }`}
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={repayInput}
              />
            </div>
          </div>

          {/* Row 3: live conversion ratio (click to swap) + USD value */}
          <div className="flex items-center justify-between">
            <ConversionRatio
              tokenSymbol={selectedRepayCurrency}
              tokenPrice={selectedTokenPrice}
              variant="inline"
            />
            <span
              className={`text-sm font-medium ${
                isDark ? "text-[#777777]" : "text-[#A7A7A7]"
              }`}
              aria-live="polite"
            >
              ≈ {formatUsdValue(repayAmountInUsd)}
            </span>
          </div>

          {/* Row 4: repay source — MB = margin vault, WB = wallet */}
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[12px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
              Repay From:{" "}
              <span className={`font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                {repaySource === "margin" ? "Margin Account" : "Wallet"}
              </span>
            </span>
            <div className={`rounded-[10px] p-[3px] flex gap-[3px] ${isDark ? "bg-[#2A2A2A]" : "bg-[#F0F0F0]"}`}>
              {([
                { id: "wallet", label: "WB" },
                { id: "margin", label: "MB" },
              ] as const).map((opt) => {
                const active = repaySource === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleSourceChange(opt.id)}
                    aria-pressed={active}
                    aria-label={opt.id === "margin" ? "Repay from margin balance" : "Repay from wallet balance"}
                    className={`px-3 py-1 rounded-[8px] text-[12px] font-semibold transition-all ${
                      active
                        ? "bg-[#703AE6] text-white"
                        : isDark
                          ? "text-[#A7A7A7] hover:text-white"
                          : "text-[#777777] hover:text-[#333333]"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

        </motion.article>

        {/* Source shortfall — e.g. a full repay from margin when the vault holds less than
            debt + 0.2% (borrowed SOL in the vault is slightly less than the accrued debt). */}
        {exceedsAvailableBalance && sourceCheck.reason && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs font-semibold text-amber-800 flex flex-col gap-2">
            <span>{sourceCheck.reason}</span>
            {repaySource === "margin" && (
              <button
                type="button"
                onClick={() => handleSourceChange("wallet")}
                className="self-start rounded-md bg-[#703AE6] px-3 py-1 text-[11px] font-semibold text-white"
              >
                Repay from wallet instead
              </button>
            )}
          </div>
        )}

        {/* Repay preview — before → after values (same style as Leverage/Transfer tabs) */}
        <RepayPreviewSection
          repayAmount={repayAmount}
          selectedTokenPrice={selectedTokenPrice}
          symbol={selectedRepayCurrency}
          isFullRepay={isFullRepay}
          source={repaySource}
        />

        {/* Action buttons */}
        <motion.section
          className="flex flex-col gap-[16px]"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.4 }}
        >
          {/* Pay Now button */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              type: "spring",
              stiffness: 300,
              damping: 25,
              delay: 0.5,
            }}
            whileHover={isInputEmpty || exceedsAvailableBalance ? {} : { scale: 1.02 }}
            whileTap={isInputEmpty || exceedsAvailableBalance ? {} : { scale: 0.98 }}
          >
            <Button
              text={
                repayMutation.isPending
                  ? "Processing..."
                  : exceedsAvailableBalance
                    ? "Insufficient Balance"
                    : "Pay Now"
              }
              size="large"
              type="gradient"
              onClick={() => void handlePayNowClick()}
              disabled={
                isInputEmpty || repayMutation.isPending || !hasMarginAccount || !(outstandingDebt > 0) || exceedsAvailableBalance
              }
            />
          </motion.div>
        </motion.section>
      </motion.section>

      {/* Pay Now popup */}
      <AnimatePresence>
        {isPayNowPopupOpen && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#45454566]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={handleClosePayNowPopup}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              transition={{ duration: 0.3 }}
              onClick={(e) => e.stopPropagation()}
            >
              <Popup
                icon="/assets/exclamation.png"
                description={`Are you sure you want to repay ${formatTokenAmount(Number(repayAmount) || 0)} ${selectedRepayCurrency}? This will reduce your borrowed amount.`}
                buttonText={repayMutation.isPending ? "Processing..." : "Confirm Repayment"}
                buttonOnClick={() => void handlePayNowClick()}
                closeButtonText="Cancel"
                closeButtonOnClick={handleClosePayNowPopup}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </motion.section>
  );
};


interface RepayPreviewSectionProps {
  /** Repay amount in token units (converted to USD via `selectedTokenPrice`). */
  repayAmount: number;
  /** Live oracle price of the selected repay token. */
  selectedTokenPrice: number;
  /** True for a full repay (repay_all) — preview shows the whole debt of this asset cleared. */
  isFullRepay?: boolean;
  /** Registry symbol being repaid. */
  symbol: string;
  /** Where the repayment comes from — a margin repay also shrinks the vault (collateral). */
  source: RepaySource;
}

/**
 * Computes the after-state of a repay action and renders the before → after
 * preview from the on-chain margin snapshot (account-wide HF = Σ collateral / Σ debt).
 *
 * Repay math:
 *   from margin: collateral − R, debt − R   (the vault pays, so both sides shrink)
 *   from wallet: collateral unchanged, debt − R
 *   HF_after = collateral_after / debt_after   (∞ when no debt remains)
 */
const RepayPreviewSection = ({
  repayAmount,
  selectedTokenPrice,
  isFullRepay = false,
  symbol,
  source,
}: RepayPreviewSectionProps) => {
  const snapshot = useMarginAccountInfoStore((s) => s.snapshot);
  const collateralUsd = snapshot?.totalCollateralUsd ?? 0;
  const debtUsd = snapshot?.totalDebtUsd ?? 0;
  const assetDebtUsd = snapshot?.debts.find((d) => d.symbol === symbol)?.usd ?? 0;

  const requestedUsd = Math.max(0, repayAmount * selectedTokenPrice);
  if ((requestedUsd <= 0 && !isFullRepay) || debtUsd <= 0) return null;

  // A full repay clears this asset's whole debt; a partial never exceeds it.
  const repayUsd = isFullRepay ? assetDebtUsd : Math.min(requestedUsd, assetDebtUsd);
  const account = { collateralUsd, debtUsd };
  const hfBefore = projectedHealthFactor(account, {});
  const bufferBefore = liquidationBufferUsd(collateralUsd, debtUsd);

  const debtAfter = Math.max(0, debtUsd - repayUsd);
  const collateralAfter = source === "margin" ? Math.max(0, collateralUsd - repayUsd) : collateralUsd;
  const hfAfter = projectedHealthFactor(account, { repayUsd, removeCollateralUsd: source === "margin" ? repayUsd : 0 });
  const bufferAfter = liquidationBufferUsd(collateralAfter, debtAfter);

  const rows: PreviewRow[] = [
    {
      label: "Outstanding Debt",
      before: formatUsd(debtUsd),
      after: formatUsd(debtAfter),
      tone: "positive",
    },
    ...(source === "margin"
      ? [{ label: "Margin Collateral", before: formatUsd(collateralUsd), after: formatUsd(collateralAfter), tone: "negative" as const }]
      : []),
    {
      label: "Health Factor",
      before: formatHF(hfBefore),
      after: formatHF(hfAfter),
      tone: hfAfter >= hfBefore ? "positive" : "negative",
    },
    {
      label: "Liquidation Buffer",
      before: formatUsd(bufferBefore),
      after: formatUsd(bufferAfter),
      tone: bufferAfter >= bufferBefore ? "positive" : "negative",
    },
  ];

  return <MarginActionPreview rows={rows} />;
};
