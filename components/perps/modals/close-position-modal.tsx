"use client";

import { useState } from "react";
import type { PerpPosition } from "@/lib/solana/perps-types";
import { QuantitySlider } from "../../ui/quantity-slider";
import { BaseModalContent } from "../../ui/base-modal-content";
import { useTheme } from "@/contexts/theme-context";
import { fmtPrice, fmtUsd } from "../perps-format";

interface ClosePositionModalProps {
  position: PerpPosition;
  onClose: () => void;
  /** sizeUsd undefined = full close. */
  onConfirm: (sizeUsd: number | undefined) => void;
}

/** Market close of a position: full, or partial by % of its USD size. */
export const ClosePositionModal = ({ position, onClose, onConfirm }: ClosePositionModalProps) => {
  const { isDark } = useTheme();
  const [percentage, setPercentage] = useState<number>(100);

  const closeSize = (position.sizeUsd * percentage) / 100;
  const isFull = percentage >= 100;

  const textPrimary = isDark ? "text-[#FFFFFF]" : "text-[#111111]";
  const textSecondary = isDark ? "text-[#A7A7A7]" : "text-[#5C5B5B]";
  const inputBg = isDark ? "border-[#333333] bg-[#111111]" : "border-[#E2E2E2] bg-white";
  const isLong = position.side === "long";

  const rows = [
    { label: "Mark price", value: `$${fmtPrice(position.markPrice)}` },
    { label: "Entry price", value: `$${fmtPrice(position.entryPrice)}` },
    { label: "Position size", value: `$${fmtUsd(position.sizeUsd)}` },
    { label: "Equity", value: `$${fmtUsd(position.equityUsd)}` },
  ];

  return (
    <BaseModalContent
      title="Close position"
      width="418px"
      gap="gap-5"
      onClose={onClose}
      confirmText={isFull ? "Close position" : `Close ${percentage}%`}
      confirmDisabled={percentage <= 0}
      onConfirm={() => onConfirm(isFull ? undefined : Math.floor(closeSize * 100) / 100)}
    >
      {/* Position Info Header */}
      <div className="flex items-center gap-1">
        <span className={`text-[12px] leading-[18px] font-semibold ${textPrimary}`}>{position.marketName}</span>
        <span
          className={`rounded-[5px] px-2 py-1 text-[10px] leading-[15px] font-semibold ${
            isLong ? "bg-[#E6F6F7] text-[#24A0A9]" : "bg-[#FFEEEE] text-[#FC5457]"
          }`}
        >
          Close {isLong ? "Long" : "Short"} {position.leverage.toFixed(1)}x
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.label} className="flex justify-between items-center">
            <span className={`text-[10px] leading-[15px] ${textSecondary} font-medium`}>{r.label}</span>
            <span className={`text-[10px] leading-[15px] ${textPrimary} font-semibold`}>{r.value}</span>
          </div>
        ))}

        <div className={`flex items-center justify-between rounded-lg border ${inputBg} px-2 py-3`}>
          <span className={`text-[10px] leading-[100%] ${textPrimary}`}>Close size</span>
          <span className={`text-[12px] leading-[18px] font-medium ${textPrimary}`}>
            ${fmtUsd(closeSize)} <span className="text-[10px]">({percentage}%)</span>
          </span>
        </div>
      </div>

      <QuantitySlider
        min={0}
        max={100}
        step={1}
        value={percentage}
        onChange={setPercentage}
        markers={[0, 25, 50, 75, 100]}
      />

      <p className={`text-[12px] leading-[140%] ${isDark ? "text-[#A7A7A7]" : "text-[#76737B]"}`}>
        Closes at the market price on GMTrade. The released USDC is settled back into your margin account.
      </p>
    </BaseModalContent>
  );
};
