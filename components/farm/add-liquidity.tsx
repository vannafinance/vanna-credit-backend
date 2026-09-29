"use client";

/**
 * Farm "Supply" panel for one single-asset Kamino Lend vault — the Solana counterpart of the
 * Stellar app's Blend supply: the asset already sitting in the MARGIN ACCOUNT (deposited,
 * borrowed or swapped in on the Margin / Swap pages) is supplied to Kamino via `margin_execute`
 * (`farmDeposit`, lib/solana/exec.ts). No leverage and no wallet source here — the cTokens stay in
 * the margin account as collateral, so the health factor is unchanged apart from the Kamino
 * exchange rate.
 */
import Image from "next/image";
import { useState, useEffect, memo } from "react";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { Button } from "../ui/button";
import { iconPaths } from "@/lib/constants";
import { DEPOSIT_PERCENTAGES } from "@/lib/constants/margin";
import { motion, AnimatePresence } from "framer-motion";
import { useMarginAccountInfoStore, refreshMarginAccount } from "@/store/margin-account-info-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { DepositSummary } from "./deposit-summary";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { formatUsdValue } from "@/lib/utils/format-amount";
import { describeError } from "@/lib/solana/errors";
import { findToken } from "@/lib/solana/tokens";
import { useFarmDeposit } from "@/lib/farm/use-farm";
import type { FarmPoolConfig } from "@/lib/farm/pools";
import { toTokenAmountString } from "@/lib/margin/amounts";

/** Floor a UI amount to the token's decimals for a %-of-balance fill (never rounds up). */
function percentOf(balance: number, pct: number, symbol: string): string {
  const decimals = findToken(symbol)?.decimals ?? 6;
  const factor = 10 ** Math.min(decimals, 6);
  return (Math.floor(((balance * pct) / 100) * factor) / factor).toString();
}

/** Memoized supply panel for one vault. Dispatches `farmDeposit` via {@link useFarmDeposit}. */
export const AddLiquidity = memo(function AddLiquidity({ pool }: { pool: FarmPoolConfig }) {
  const { isDark } = useTheme();
  const userAddress = useUserStore((state) => state.address);
  const hasMarginAccount = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const collateralBalances = useMarginAccountInfoStore((s) => s.collateralBalances);
  const isLoadingBalances = useMarginAccountInfoStore((s) => s.isLoadingBorrowedBalances);

  const token = pool.symbol;
  const prices = useTokenPrices([token]);
  const price = prices[token] ?? 0;
  const [value, setValue] = useState("");
  const [txError, setTxError] = useState("");

  // The margin-vault balance is the only source of farm liquidity — make sure it's loaded.
  useEffect(() => {
    if (userAddress) void refreshMarginAccount(userAddress);
  }, [userAddress]);

  // Reset the form when switching vaults.
  useEffect(() => {
    setValue("");
    setTxError("");
  }, [pool.id]);

  const available = hasMarginAccount ? parseFloat(collateralBalances[token]?.amount ?? "0") || 0 : 0;
  const amount = parseFloat(value) || 0;

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
    if (overBalance) return `Insufficient ${token} in Margin Account`;
    return `Supply ${token} to Kamino`;
  };

  const submit = () => {
    setTxError("");
    deposit.mutate(
      { symbol: token, marginAmount: toTokenAmountString(amount, token) },
      {
        onSuccess: () => {
          setValue("");
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
          <span className={`text-[12px] font-medium ${muted}`}>≈ {formatUsdValue(amount * price)}</span>
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
          <span
            className={`text-[11px] font-medium underline cursor-pointer shrink-0 ${isDark ? "text-[#555555]" : "text-[#AAAAAA]"}`}
            onClick={() => setValue(percentOf(available, 100, token))}
          >
            Margin: {isLoadingBalances ? "..." : available.toLocaleString(undefined, { maximumFractionDigits: 4 })} {token}
          </span>
        </div>
      </div>

      {userAddress && !hasMarginAccount && (
        <div className={`w-full rounded-xl p-3 border text-[12px] font-medium ${isDark ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-500" : "bg-yellow-50 border-yellow-200 text-yellow-700"}`}>
          A margin account is required to farm. Please create one in the Margin section.
        </div>
      )}
      {userAddress && hasMarginAccount && available <= 0 && !isLoadingBalances && (
        <div className={`w-full rounded-xl p-3 border text-[12px] font-medium ${isDark ? "bg-[#1A1A1A] border-[#2A2A2A] text-[#A7A7A7]" : "bg-[#F7F7F7] border-[#E8E8E8] text-[#5C5B5B]"}`}>
          No {token} in your margin account. Deposit or borrow {token} on the Margin page first.
        </div>
      )}

      <AnimatePresence>
        {amount > 0 && (
          <DepositSummary
            tokenSymbol={token}
            depositAmount={amount}
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
