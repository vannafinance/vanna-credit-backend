"use client";

/**
 * Farm "Supply" panel for one single-asset Kamino Lend vault.
 *
 * Source (same WB / MB toggle as the Margin page):
 * - WB: the amount is deposited from the WALLET into the margin account first;
 * - MB: the amount is already in the margin account (e.g. a previous borrow or swap).
 * Leverage borrows the SAME asset from Vanna's pool: borrow = amount × (leverage − 1), and the
 * whole (amount + borrow) is supplied to Kamino — deposit + borrow + Kamino supply in ONE
 * transaction (`farmDeposit`, lib/solana/exec.ts). The cTokens stay in the margin account as
 * collateral, so the health factor after the supply is (C + new equity + B) / (D + B); the max
 * leverage keeps it at or above the 1.15 safety line and within the pool's available liquidity.
 */
import Image from "next/image";
import { useState, useEffect, useMemo, memo } from "react";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { Button } from "../ui/button";
import { LeverageSlider } from "../ui/leverage-slider";
import { iconPaths } from "@/lib/constants";
import { DEPOSIT_PERCENTAGES } from "@/lib/constants/margin";
import { motion, AnimatePresence } from "framer-motion";
import { useMarginAccountInfoStore, refreshMarginAccount } from "@/store/margin-account-info-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { usePoolData } from "@/hooks/use-earn";
import { DepositSummary } from "./deposit-summary";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { formatUsdValue } from "@/lib/utils/format-amount";
import { describeError } from "@/lib/solana/errors";
import { findToken } from "@/lib/solana/tokens";
import { useFarmDeposit } from "@/lib/farm/use-farm";
import type { FarmPoolConfig } from "@/lib/farm/pools";
import {
  HF_INFINITY,
  floorTo,
  maxLeverageForInput,
  projectedHealthFactor,
  spendableWalletAmount,
  toTokenAmountString,
} from "@/lib/margin/amounts";

/** Farm leverage is capped at 5x regardless of how much headroom the account has. */
const FARM_MAX_LEVERAGE = 5;

/** Floor a UI amount to the token's decimals for a %-of-balance fill (never rounds up). */
function percentOf(balance: number, pct: number, symbol: string): string {
  const decimals = findToken(symbol)?.decimals ?? 6;
  const factor = 10 ** Math.min(decimals, 6);
  return (Math.floor(((balance * pct) / 100) * factor) / factor).toString();
}

/**
 * Memoized supply panel for one vault. Dispatches `farmDeposit` via {@link useFarmDeposit}.
 */
export const AddLiquidity = memo(function AddLiquidity({ pool }: { pool: FarmPoolConfig }) {
  const { isDark } = useTheme();
  const userAddress = useUserStore((state) => state.address);
  const walletBalances = useUserStore((state) => state.tokenBalances);
  const hasMarginAccount = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const collateralBalances = useMarginAccountInfoStore((s) => s.collateralBalances);
  const collateralUsd = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const debtUsd = useMarginAccountInfoStore((s) => s.totalBorrowedValue);
  const isLoadingBalances = useMarginAccountInfoStore((s) => s.isLoadingBorrowedBalances);
  const { pools } = usePoolData();

  const token = pool.symbol;
  const prices = useTokenPrices([token]);
  const price = prices[token] ?? 0;
  const [source, setSource] = useState<"WB" | "MB">("WB");
  const [value, setValue] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [txError, setTxError] = useState("");

  // Margin-vault balances and totals feed the MB balance and the HF projection.
  useEffect(() => {
    if (userAddress) void refreshMarginAccount(userAddress);
  }, [userAddress]);

  // Reset the form when switching vaults.
  useEffect(() => {
    setValue("");
    setLeverage(1);
    setTxError("");
  }, [pool.id]);

  const walletAvailable = spendableWalletAmount(token, parseFloat(walletBalances[token] ?? "0") || 0);
  const marginAvailable = hasMarginAccount ? parseFloat(collateralBalances[token]?.amount ?? "0") || 0 : 0;
  const available = source === "WB" ? walletAvailable : marginAvailable;
  const amount = parseFloat(value) || 0;
  const amountUsd = amount * price;
  const account = { collateralUsd: collateralUsd || 0, debtUsd: debtUsd || 0 };

  // Max leverage: the HF safety line, the pool's free liquidity, and the farm cap.
  const poolAvailable = pools[token]?.availableLiquidity ?? 0;
  const maxLeverage = useMemo(() => {
    const byHealth = maxLeverageForInput(amountUsd, account, source);
    const byLiquidity = amount > 0 ? 1 + poolAvailable / amount : FARM_MAX_LEVERAGE;
    return Math.max(1, floorTo(Math.min(FARM_MAX_LEVERAGE, byHealth, byLiquidity), 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountUsd, amount, account.collateralUsd, account.debtUsd, source, poolAvailable]);
  const effectiveLeverage = Math.min(leverage, maxLeverage);
  const borrowAmount = amount * (effectiveLeverage - 1);
  const supplyTotal = amount + borrowAmount;
  const hfAfter = projectedHealthFactor(account, {
    addCollateralUsd: source === "WB" ? amountUsd : 0,
    addBorrowUsd: borrowAmount * price,
  });

  const deposit = useFarmDeposit();
  const isPending = deposit.isPending;
  const isInputValid = amount > 0;
  const overBalance = amount > available + 1e-12;
  const isSubmitDisabled = !userAddress || !hasMarginAccount || !isInputValid || overBalance || isPending;

  const buttonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (!hasMarginAccount) return "Margin Account Required";
    if (isPending) return "Supplying...";
    if (!isInputValid) return "Enter Amount";
    if (overBalance) return `Insufficient ${token} ${source === "WB" ? "Wallet" : "Margin"} Balance`;
    return effectiveLeverage > 1 ? `Supply ${token} at ${effectiveLeverage.toFixed(2)}x` : `Supply ${token}`;
  };

  const submit = () => {
    setTxError("");
    const amountText = toTokenAmountString(amount, token);
    const borrowText = borrowAmount > 0 ? toTokenAmountString(borrowAmount, token) : "0";
    deposit.mutate(
      {
        symbol: token,
        walletAmount: source === "WB" ? amountText : 0,
        marginAmount: source === "MB" ? amountText : 0,
        borrowAmount: borrowText,
      },
      {
        onSuccess: () => {
          setValue("");
          setLeverage(1);
          if (userAddress) void refreshMarginAccount(userAddress);
        },
        onError: (error) => setTxError(describeError(error, "Supply failed")),
      },
    );
  };

  const muted = isDark ? "text-[#777777]" : "text-[#A7A7A7]";
  const strong = isDark ? "text-white" : "text-[#111111]";

  return (
    <div className="w-full h-fit flex flex-col gap-3">
      {/* Source toggle */}
      <div className="flex items-center justify-between">
        <span className={`text-[12px] font-semibold ${muted}`}>Supply from</span>
        <div className={`flex rounded-lg p-0.5 ${isDark ? "bg-[#222222]" : "bg-[#EEEEEE]"}`}>
          {(["WB", "MB"] as const).map((s) => (
            <button
              key={s}
              type="button"
              disabled={isPending}
              onClick={() => {
                setSource(s);
                setValue("");
              }}
              className={`px-3 py-1 rounded-md text-[11px] font-semibold cursor-pointer ${source === s ? "bg-[#703AE6] text-white" : muted}`}
              title={s === "WB" ? "Wallet balance" : "Margin account balance"}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Input card */}
      <div className={`w-full rounded-xl border flex flex-col ${isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"}`}>
        <div className="flex items-center gap-2 px-3 pt-3 pb-2">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={value}
            onChange={(e) => {
              const sanitized = validateAmountChange(e.target.value);
              if (sanitized === null) return;
              setValue(sanitized);
            }}
            disabled={isPending}
            className={`flex-1 min-w-0 bg-transparent outline-none text-[20px] font-semibold placeholder:opacity-20 ${isDark ? "text-white placeholder:text-white" : "text-[#111111] placeholder:text-[#111111]"}`}
          />
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full shrink-0 ${isDark ? "bg-[#1A1A1A] border border-[#2A2A2A]" : "bg-[#F7F7F7] border border-[#E8E8E8]"}`}>
            <Image src={iconPaths[token] ?? "/coins/default.svg"} alt={token} width={20} height={20} className="rounded-full w-5 h-5 flex-none" />
            <span className={`text-[14px] font-semibold ${strong}`}>{token}</span>
          </div>
        </div>
        <div className="px-3 -mt-1 pb-1">
          <span className={`text-[12px] font-medium ${muted}`}>≈ {formatUsdValue(amountUsd)}</span>
        </div>
        <div className="flex items-center justify-between px-3 pb-3">
          <div className="flex items-center gap-1">
            {DEPOSIT_PERCENTAGES.map((pct) => (
              <motion.button
                key={pct}
                type="button"
                disabled={isPending}
                onClick={() => setValue(percentOf(available, pct, token))}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.93 }}
                transition={{ duration: 0.1 }}
                className={`px-2 py-1 rounded-lg text-[10px] font-semibold cursor-pointer border transition-all ${
                  isDark ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white" : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                } ${isPending ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                {pct}%
              </motion.button>
            ))}
          </div>
          <span className={`text-[11px] font-medium underline cursor-pointer shrink-0 ${isDark ? "text-[#555555]" : "text-[#AAAAAA]"}`} onClick={() => setValue(percentOf(available, 100, token))}>
            {source === "WB" ? "Wallet" : "Margin"}: {isLoadingBalances && source === "MB" ? "..." : available.toLocaleString(undefined, { maximumFractionDigits: 4 })} {token}
          </span>
        </div>
      </div>

      {/* Leverage */}
      <div className={`w-full rounded-xl border px-3 py-3 flex flex-col gap-2 ${isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"}`}>
        <div className="flex items-center justify-between">
          <span className={`text-[12px] font-semibold ${muted}`}>Leverage (borrow {token} from Vanna)</span>
          <span className={`text-[13px] font-bold ${strong}`}>{effectiveLeverage.toFixed(2)}x</span>
        </div>
        <LeverageSlider min={1} max={Math.max(1.01, maxLeverage)} step={0.01} value={effectiveLeverage} onChange={setLeverage} markers={[1, Math.max(1, maxLeverage)]} />
        <div className={`flex flex-col gap-1 text-[11px] font-medium ${muted}`}>
          <div className="flex justify-between"><span>Borrow</span><span className={strong}>{borrowAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })} {token}</span></div>
          <div className="flex justify-between"><span>Total supplied to Kamino</span><span className={strong}>{supplyTotal.toLocaleString(undefined, { maximumFractionDigits: 6 })} {token}</span></div>
          <div className="flex justify-between"><span>Vanna borrow APY</span><span className={strong}>{(((pools[token]?.borrowApr ?? 0) as number) * 100).toFixed(2)}%</span></div>
          <div className="flex justify-between">
            <span>Health factor after</span>
            <span className={hfAfter < 1.3 ? "text-[#FC5457]" : "text-[#16a34a]"}>{hfAfter >= HF_INFINITY ? "∞" : hfAfter.toFixed(2)}</span>
          </div>
          <div className="flex justify-between"><span>Max leverage</span><span className={strong}>{maxLeverage.toFixed(2)}x</span></div>
        </div>
      </div>

      {userAddress && !hasMarginAccount && (
        <div className={`w-full rounded-xl p-3 border text-[12px] font-medium ${isDark ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-500" : "bg-yellow-50 border-yellow-200 text-yellow-700"}`}>
          A margin account is required to farm. Please create one in the Margin section.
        </div>
      )}

      <AnimatePresence>
        {supplyTotal > 0 && (
          <DepositSummary
            tokenSymbol={token}
            depositAmount={supplyTotal}
            tokenPriceUsd={price}
            supplyApyPct={pool.supplyApy === null ? null : pool.supplyApy * 100}
          />
        )}
      </AnimatePresence>
      {txError && <p className="text-[12px] font-medium text-[#FC5457]">{txError}</p>}

      <Button disabled={isSubmitDisabled} type="solid" size="large" text={buttonText()} onClick={submit} />
    </div>
  );
});
