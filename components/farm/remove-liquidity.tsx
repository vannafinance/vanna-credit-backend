"use client";

/**
 * Farm "Withdraw" panel — redeems a %-of-position of the margin account's Kamino cTokens back into
 * the margin account (`farmWithdraw`, lib/solana/exec.ts → `margin_execute` Kamino
 * `redeem_reserve_collateral`). 100% redeems exactly every cToken held. Repaying the leverage or
 * withdrawing to the wallet is then done on the Margin page.
 */
import Image from "next/image";
import { useState, useEffect, memo } from "react";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { Button } from "../ui/button";
import { iconPaths } from "@/lib/constants";
import { PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { motion } from "framer-motion";
import { refreshMarginAccount } from "@/store/margin-account-info-store";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { formatUsdValue } from "@/lib/utils/format-amount";
import { describeError } from "@/lib/solana/errors";
import { useFarmPositions, useFarmWithdraw } from "@/lib/farm/use-farm";
import type { FarmPoolConfig } from "@/lib/farm/pools";

const PERCENTAGE_OPTIONS = [25, 50, 75, 100] as const;

/** Memoized withdraw panel for one vault; dispatches `farmWithdraw`. */
export const RemoveLiquidity = memo(function RemoveLiquidity({ pool }: { pool: FarmPoolConfig }) {
  const { isDark } = useTheme();
  const userAddress = useUserStore((state) => state.address);
  const { positions, isLoading: loadingPosition } = useFarmPositions(userAddress);
  const position = positions.find((p) => p.poolId === pool.id) ?? null;

  // Entered as a percentage of the position (0–100).
  const [value, setValue] = useState<string>("");
  const [selectedPercentage, setSelectedPercentage] = useState<number>(0);
  const [txError, setTxError] = useState<string>("");

  useEffect(() => {
    setValue("");
    setSelectedPercentage(0);
    setTxError("");
  }, [pool.id]);

  const percent = parseFloat(value);
  const isInputValid = Number.isFinite(percent) && percent > 0 && percent <= 100;
  const withdrawUsd = position && isInputValid ? (position.liquidityUsd * percent) / 100 : null;

  const withdraw = useFarmWithdraw();
  const isPending = withdraw.isPending;
  const submit = () => {
    if (!position) return;
    setTxError("");
    const all = percent >= 100;
    // Floor to the cToken's 6 decimals so a partial redeem never asks for more than is held.
    const receipts = Math.floor(((position.receipts * percent) / 100) * 1e6) / 1e6;
    withdraw.mutate(
      { symbol: pool.symbol, all, receipts: all ? undefined : receipts },
      {
        onSuccess: () => {
          setValue("");
          setSelectedPercentage(0);
          if (userAddress) void refreshMarginAccount(userAddress);
        },
        onError: (error) => setTxError(describeError(error, "Withdraw failed")),
      },
    );
  };

  const isSubmitDisabled = !userAddress || !position || !isInputValid || isPending;

  const buttonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (!position) return "No Position";
    if (isPending) return "Withdrawing...";
    if (!isInputValid) return "Enter Percentage";
    return `Withdraw ${pool.symbol} to Margin Account`;
  };

  const balanceLabel = loadingPosition
    ? "Loading..."
    : position
      ? `${position.underlying.toFixed(4)} ${pool.symbol} · ${formatUsdValue(position.liquidityUsd)}`
      : "—";

  return (
    <div className="w-full h-fit flex flex-col gap-[16px]">
      <div className={`w-full h-fit rounded-[12px] p-[14px] flex justify-between items-center ${isDark ? "bg-[#1A1A1A]" : "bg-[#F7F7F7]"}`}>
        <span className={`text-[12px] font-medium ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
          Your Vault Position
        </span>
        <div className="flex items-center gap-[6px]">
          <Image src={iconPaths[pool.symbol] ?? "/coins/default.svg"} alt={pool.symbol} width={16} height={16} className="rounded-full" />
          <span className={`text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>{balanceLabel}</span>
        </div>
      </div>

      <div className={`w-full h-fit flex rounded-[16px] gap-[8px] p-[20px] ${isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"}`}>
        <div className="w-full h-fit flex flex-col gap-[16px]">
          <div className="flex flex-col gap-[6px]">
            <div className="flex items-baseline gap-1">
              <input
                type="text"
                inputMode="decimal"
                placeholder="0"
                className={`w-full h-fit text-[20px] font-semibold placeholder:opacity-20 outline-none border-none bg-transparent ${
                  isDark ? "text-white placeholder:text-white" : "text-[#111111] placeholder:text-[#111111]"
                }`}
                value={value}
                onChange={(e) => {
                  const sanitized = validateAmountChange(e.target.value);
                  if (sanitized === null) return;
                  setValue(sanitized);
                  setSelectedPercentage(0);
                }}
                disabled={isPending}
                aria-label="Percentage of position to withdraw"
              />
              <span className={`text-[16px] font-semibold ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>%</span>
            </div>
            <div className={`text-[11px] font-medium ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
              {Number.isFinite(percent) && percent > 100 ? (
                <span className="text-red-500">Cannot remove more than 100%</span>
              ) : withdrawUsd !== null && position ? (
                `≈ ${((position.underlying * percent) / 100).toFixed(4)} ${pool.symbol} · ${formatUsdValue(withdrawUsd)}`
              ) : (
                "≈ —"
              )}
            </div>
          </div>
          <div className="flex gap-[8px]">
            {PERCENTAGE_OPTIONS.map((pct) => (
              <motion.button
                key={pct}
                type="button"
                disabled={isPending}
                onClick={() => {
                  setSelectedPercentage(pct);
                  setValue(String(pct));
                }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.93 }}
                transition={{ duration: 0.1 }}
                className={`px-[10px] py-[6px] rounded-[8px] text-[12px] font-semibold cursor-pointer ${
                  selectedPercentage === pct
                    ? `${PERCENTAGE_COLORS[pct] ?? "bg-[#703AE6]"} text-white`
                    : isDark
                      ? "bg-[#1A1A1A] text-[#C7C7C7]"
                      : "bg-[#F2F2F2] text-[#555555]"
                }`}
              >
                {pct}%
              </motion.button>
            ))}
          </div>
        </div>
      </div>

      {txError && <p className="text-[12px] font-medium text-[#FC5457]">{txError}</p>}

      <Button text={buttonText()} size="large" type="solid" disabled={isSubmitDisabled} onClick={submit} />
    </div>
  );
});
