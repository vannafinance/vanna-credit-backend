"use client";

import { useState, useEffect } from "react";
import { Dropdown } from "../ui/dropdown";
import { AnimatePresence, motion } from "framer-motion";
import { DropdownOptions } from "@/lib/constants";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { Button } from "../ui/button";
import { useTheme } from "@/contexts/theme-context";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useUserStore } from "@/store/user";
import toast from "react-hot-toast";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { useTokenPrices as useTokenPricesFromHook } from "@/hooks/use-token-prices";
import { useDepositAndBorrow, useWithdrawCollateral } from "@/hooks/use-margin";
import { ConversionRatio } from "@/components/ui/conversion-ratio";
import { MarginActionPreview } from "@/components/margin/margin-action-preview";
import { computeCollateralPreviewRows } from "@/lib/utils/margin-preview";
import {
  LIQUIDATION_HEALTH_FACTOR,
  maxWithdrawTokens,
  projectedHealthFactor,
  spendableWalletAmount,
  toTokenAmountString,
} from "@/lib/margin/amounts";

const AMOUNT_EPSILON = 1e-9;
/** Debt below this USD value is dust — the no-debt branch applies (HF reads ∞). */
const USD_DUST_EPSILON = 0.000001;

/**
 * Transfer tab for moving a token between the user's wallet and their margin
 * account in either direction (MB = wallet → margin deposit via
 * `depositAndBorrow({ deposits })`, WB = margin → wallet withdraw via
 * `user_withdraw_collateral`). Computes two distinct caps: the source balance
 * (wallet SOL keeps the 0.05 SOL fee reserve), and the risk-safe withdraw limit
 * from `maxWithdrawTokens` — `maxWithdrawUsd` at SAFE_HEALTH_FACTOR converted to
 * token units and capped at the vault balance — so a withdrawal can't approach the
 * 1.10 liquidation threshold. Failed transactions preserve the entered amount and
 * report the error; balances refresh after confirmation (useAfterMarginTx).
 */
export const TransferCollateral = () => {
  const { isDark } = useTheme();
  const [selectedCurrency, setSelectedCurrency] = useState<string>(DropdownOptions[0]);
  const [selectedTransferType, setSelectedTransferType] = useState<"MB" | "WB">("MB");
  const [valueInput, setValueInput] = useState<string>("");
  const [percentage, setPercentage] = useState<number>(0);
  // True when the WB amount came from the Max / 100% chip on a debt-free account — sent as
  // `all: true` so the whole vault (to the last base unit) is withdrawn.
  const [withdrawAll, setWithdrawAll] = useState(false);

  const snapshot = useMarginAccountInfoStore((state) => state.snapshot);
  const totalBorrowedValue = useMarginAccountInfoStore((state) => state.totalBorrowedValue);
  const hasMarginAccount = useMarginAccountInfoStore((state) => state.hasMarginAccount);
  const tokenBalances = useUserStore((state) => state.tokenBalances);
  // Sub-cent residual debt is dust: treat as no debt, consistent with the ∞ HF the
  // header shows for it.
  const hasMeaningfulDebt = totalBorrowedValue > USD_DUST_EPSILON;

  // Reset the form on wallet disconnect so the previous wallet's figures don't linger.
  const globalIsConnected = useUserStore((state) => state.isConnected);
  const globalAddress = useUserStore((state) => state.address);
  useEffect(() => {
    if (!globalIsConnected || !globalAddress) {
      setValueInput("");
      setPercentage(0);
      setWithdrawAll(false);
    }
  }, [globalIsConnected, globalAddress]);

  // Live on-chain (fork Pyth) prices for every registry token; 0 while unknown.
  const tokenPrices = useTokenPricesFromHook();
  const selectedTokenPrice = tokenPrices[selectedCurrency] ?? 0;

  const walletBalance = globalAddress ? parseFloat(tokenBalances[selectedCurrency] || "0") || 0 : 0;
  const marginAccountBalance = globalAddress
    ? snapshot?.collateral.find((c) => c.symbol === selectedCurrency)?.amount ?? 0
    : 0;
  const sourceBalance = selectedTransferType === "MB" ? walletBalance : marginAccountBalance;
  // Wallet → margin: SOL keeps the fee reserve. Margin → wallet: the vault balance.
  const maxTransferableBalance = selectedTransferType === "MB"
    ? spendableWalletAmount(selectedCurrency, walletBalance)
    : Math.max(0, marginAccountBalance);
  // What gets SHOWN as "your balance" — for wallet → margin SOL this is the spendable amount,
  // so Max/100% never fills in a number different from the one displayed.
  const displayedSourceBalance = maxTransferableBalance;
  const sourceBalanceInUsd = displayedSourceBalance * selectedTokenPrice;

  // Account-wide safe withdraw limit (HF stays >= 1.15), in token units, ≤ vault balance.
  const accountTotals = {
    collateralUsd: snapshot?.totalCollateralUsd ?? 0,
    debtUsd: hasMeaningfulDebt ? snapshot?.totalDebtUsd ?? totalBorrowedValue : 0,
  };
  const maxExecutableWithdraw = selectedTransferType === "WB"
    ? maxWithdrawTokens({ symbol: selectedCurrency, vaultAmount: marginAccountBalance, price: selectedTokenPrice, ...accountTotals })
    : maxTransferableBalance;
  const isOverSourceBalance = Number(valueInput || 0) > sourceBalance + AMOUNT_EPSILON;

  // Projected HF after a WB (withdraw) — used to block the Transfer button
  // and show a warning when the withdrawal would push HF to 1.10 or below.
  const projectedHfAfterWb = (() => {
    if (selectedTransferType !== "WB" || !hasMeaningfulDebt) return Infinity;
    const withdrawUsd = Number(valueInput || 0) * selectedTokenPrice;
    return projectedHealthFactor(accountTotals, { removeCollateralUsd: withdrawUsd });
  })();
  const isWbBelowLiqThreshold =
    selectedTransferType === "WB" &&
    Number(valueInput || 0) > 0 &&
    hasMeaningfulDebt &&
    projectedHfAfterWb <= LIQUIDATION_HEALTH_FACTOR;

  // Keep the form coherent when switching asset / direction.
  useEffect(() => {
    setValueInput("");
    setPercentage(0);
    setWithdrawAll(false);
  }, [selectedCurrency]);

  const handlePercentageClick = (item: number) => {
    setPercentage(item);
    const baseBalance = selectedTransferType === "WB" ? maxExecutableWithdraw : maxTransferableBalance;
    // 100% of a debt-free vault = withdraw everything (`all: true`).
    setWithdrawAll(selectedTransferType === "WB" && item === 100 && !hasMeaningfulDebt);
    setValueInput(toTokenAmountString((baseBalance * item) / 100, selectedCurrency));
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = validateAmountChange(e.target.value);
    if (sanitized === null) return;
    setWithdrawAll(false);
    setPercentage(0);
    setValueInput(sanitized);
  };

  const handleMaxValueClick = () => {
    const targetMax = selectedTransferType === "WB" ? maxExecutableWithdraw : maxTransferableBalance;
    // Floored to the token's decimals (never rounds UP past the real max).
    setWithdrawAll(selectedTransferType === "WB" && !hasMeaningfulDebt);
    setValueInput(toTokenAmountString(targetMax, selectedCurrency));
  };

  const depositMutation = useDepositAndBorrow();
  const withdrawMutation = useWithdrawCollateral();
  const transferMutation = {
    isPending: depositMutation.isPending || withdrawMutation.isPending,
  };

  const handleTransferClick = async () => {
    if (!valueInput || Number(valueInput) <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }

    if (Number(valueInput) > sourceBalance + AMOUNT_EPSILON) {
      toast.error("Insufficient balance for selected transfer mode");
      return;
    }
    if (selectedTransferType === "MB" && Number(valueInput) > maxTransferableBalance + AMOUNT_EPSILON) {
      toast.error(`You cannot transfer all your wallet ${selectedCurrency}. Keep at least 0.05 SOL in your wallet for fees.`);
      return;
    }
    if (
      selectedTransferType === "WB" &&
      Number(valueInput) > maxExecutableWithdraw + AMOUNT_EPSILON
    ) {
      const safeMaxDisplay = toTokenAmountString(maxExecutableWithdraw, selectedCurrency) || "0";
      if (!hasMeaningfulDebt) {
        toast.error(`Max transferable right now: ${safeMaxDisplay} ${selectedCurrency}.`);
      } else if (maxExecutableWithdraw > 0) {
        toast.error(`Unsafe withdrawal for current debt/health factor. Max you can transfer now: ${safeMaxDisplay} ${selectedCurrency}.`);
      } else {
        toast.error("Unsafe withdrawal for current debt/health factor. Repay some debt first.");
      }
      return;
    }

    try {
      if (selectedTransferType === "MB") {
        // Wallet → margin. Creates the margin account in the same tx if it doesn't exist yet.
        await depositMutation.mutateAsync({
          deposits: [{ symbol: selectedCurrency, amount: toTokenAmountString(Number(valueInput), selectedCurrency) }],
          createIfMissing: true,
        });
      } else {
        await withdrawMutation.mutateAsync(
          withdrawAll
            ? { symbol: selectedCurrency, all: true }
            : { symbol: selectedCurrency, amount: toTokenAmountString(Number(valueInput), selectedCurrency) },
        );
      }
      setValueInput("");
      setPercentage(0);
      setWithdrawAll(false);
    } catch {
      // Progress modal already shows the decoded error; the entered amount is kept.
    }
  };

  return (
    <motion.section
      className="flex flex-col justify-between gap-6 pt-8"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
    >
      {/* Transfer form card */}
      <motion.article
        className={`w-full rounded-2xl border p-3 sm:p-4 flex flex-col gap-2 ${
          isDark
            ? "bg-[#1A1A1A] border-[#2A2A2A]"
            : "bg-white border-[#EEEEEE]"
        }`}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3, delay: 0.1 }}
      >
        {/* Row 1: "Transfer" label + % chips */}
        <div className="flex items-center justify-between">
          <span
            className={`text-sm font-medium ${
              isDark ? "text-[#A7A7A7]" : "text-[#777777]"
            }`}
          >
            Transfer
          </span>
          <AnimatePresence mode="wait">
            <motion.div
              key="pct-chips"
              className="flex items-center gap-1 sm:gap-1.5"
              role="group"
              aria-label="Deposit percentage"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            >
              {DEPOSIT_PERCENTAGES.map((item) => (
                <motion.button
                  type="button"
                  key={item}
                  onClick={() => handlePercentageClick(item)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold cursor-pointer border transition-all ${
                    percentage === item
                      ? `${PERCENTAGE_COLORS[item]} text-white border-transparent`
                      : isDark
                        ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                        : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                  }`}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.93 }}
                  transition={{ duration: 0.1 }}
                  aria-label={`Select ${item} percent`}
                  aria-pressed={percentage === item}
                >
                  {item}%
                </motion.button>
              ))}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Row 2: token dropdown pill + amount input */}
        <div className="flex items-center justify-between gap-3">
          <div className="shrink-0">
            <Dropdown
              classname={`gap-2 px-3 py-2 rounded-full text-[14px] font-semibold transition-colors ${
                isDark
                  ? "bg-[#333333] hover:bg-[#3D3D3D] text-white"
                  : "bg-[#EEEEEE] hover:bg-[#E2E2E2]"
              }`}
              selectedOption={selectedCurrency}
              setSelectedOption={setSelectedCurrency}
              items={DropdownOptions}
              dropdownClassname="text-[13px] gap-2"
            />
          </div>
          <div className="flex-1 min-w-0">
            <label htmlFor="collateral-amount-input" className="sr-only">
              Collateral amount
            </label>
            <input
              id="collateral-amount-input"
              onChange={handleInputChange}
              className={`w-full text-right text-[22px] sm:text-[28px] font-semibold bg-transparent outline-none placeholder:opacity-30 ${
                isDark
                  ? "text-white placeholder:text-[#555555]"
                  : "text-[#111111] placeholder:text-[#CCCCCC]"
              }`}
              type="text"
              inputMode="decimal"
              placeholder="0"
              value={valueInput}
            />
          </div>
        </div>

        {/* Row 3: balance info + USD + Max */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`text-[12px] font-medium truncate ${
                isDark ? "text-[#777777]" : "text-[#A7A7A7]"
              }`}
            >
              Transfer To:{" "}
              <span
                className={`font-semibold ${
                  isDark ? "text-white" : "text-[#111111]"
                }`}
              >
                {selectedTransferType === "MB" ? "Margin Account" : "Wallet"}
              </span>
            </span>
            <motion.button
              onClick={handleMaxValueClick}
              className={`cursor-pointer rounded-md py-0.5 px-2 text-[11px] font-semibold shrink-0 ${
                isDark
                  ? "bg-[#2A1A3E] text-[#A97EFF]"
                  : "bg-[#F1EBFD] text-[#703AE6]"
              }`}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              transition={{ duration: 0.2 }}
            >
              Max
            </motion.button>
            <ConversionRatio
              tokenSymbol={selectedCurrency}
              tokenPrice={selectedTokenPrice}
              variant="inline"
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`text-[13px] font-semibold ${
                isDark ? "text-white" : "text-[#111111]"
              }`}
            >
              {displayedSourceBalance.toLocaleString("en-US", { maximumFractionDigits: 4 })} {selectedCurrency}
            </span>
            <motion.p
              className={`text-sm font-medium ${
                isDark ? "text-[#777777]" : "text-[#A7A7A7]"
              }`}
              aria-live="polite"
              key={sourceBalanceInUsd}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
            >
              ≈ {sourceBalanceInUsd.toFixed(2)} USD
            </motion.p>
          </div>
        </div>

        {/* Row 4: WB/MB toggle */}
        <div className="flex items-center justify-start">
          <div className={`rounded-[10px] p-[3px] flex gap-[3px] ${isDark ? "bg-[#2A2A2A]" : "bg-[#F0F0F0]"}`}>
            {["WB", "MB"].map((mode) => {
              const active = selectedTransferType === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setSelectedTransferType(mode as "WB" | "MB");
                    setPercentage(0);
                    setValueInput("");
                    setWithdrawAll(false);
                  }}
                  className={`px-3 py-1 rounded-[8px] text-[12px] font-semibold transition-all ${
                    active
                      ? "bg-[#703AE6] text-white"
                      : isDark
                        ? "text-[#A7A7A7] hover:text-white"
                        : "text-[#777777] hover:text-[#333333]"
                  }`}
                >
                  {mode}
                </button>
              );
            })}
          </div>
        </div>
      </motion.article>

      {/* Transaction preview — collateral / HF / liquidation buffer before vs after */}
      <TransferPreviewSection
        transferAmount={Number(valueInput) || 0}
        selectedTokenPrice={selectedTokenPrice}
        transferType={selectedTransferType}
      />


      {/* Action buttons */}
      <motion.section
        className="flex flex-col gap-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.4 }}
      >
        {isWbBelowLiqThreshold && (
          <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-xs font-semibold text-red-700">
            ⚠ This withdrawal would drop your Health Factor to {projectedHfAfterWb.toFixed(2)} (below 1.10). Reduce the amount or repay some debt first.
          </div>
        )}
        <Button
          text={transferMutation.isPending ? "Processing..." : "Transfer"}
          size="large"
          type="gradient"
          disabled={!(Number(valueInput) > 0 && !transferMutation.isPending && (hasMarginAccount || selectedTransferType === "MB") && !isOverSourceBalance) || isWbBelowLiqThreshold}
          onClick={() => void handleTransferClick()}
        />
      </motion.section>
    </motion.section>
  );
};

interface TransferPreviewSectionProps {
  /** Transfer amount in token units (converted to USD via `selectedTokenPrice`). */
  transferAmount: number;
  /** Live oracle price of the selected token. */
  selectedTokenPrice: number;
  /** "MB" = wallet → margin (collateral grows). "WB" = margin → wallet (collateral shrinks). */
  transferType: "MB" | "WB";
}

/**
 * Computes the after-state of a collateral transfer and renders the
 * before → after preview. Reads margin totals from the store; the actual
 * before/after math lives in `computeCollateralPreviewRows` (shared with the
 * Portfolio page's Deposit/Withdraw modals).
 *
 * - MB (deposit into margin): collateral grows, debt unchanged → HF improves.
 * - WB (withdraw from margin): collateral shrinks, debt unchanged → HF drops.
 */
const TransferPreviewSection = ({
  transferAmount,
  selectedTokenPrice,
  transferType,
}: TransferPreviewSectionProps) => {
  const totalCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const totalBorrowedValue = useMarginAccountInfoStore((s) => s.totalBorrowedValue);
  const avgHealthFactor = useMarginAccountInfoStore((s) => s.avgHealthFactor);

  const transferUsd = Math.max(0, transferAmount * selectedTokenPrice);
  if (transferUsd <= 0) return null;

  const rows = computeCollateralPreviewRows({
    totalCollateralValue,
    totalBorrowedValue,
    avgHealthFactor,
    transferUsd,
    isInbound: transferType === "MB",
  });

  return <MarginActionPreview rows={rows} />;
};
