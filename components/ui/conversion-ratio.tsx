"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";

interface ConversionRatioProps {
  tokenSymbol: string;
  tokenPrice: number;
  className?: string;
  variant?: "pill" | "inline";
}

const formatPrice = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return "0.00";
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toFixed(6);
};

const formatTokensPerDollar = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return "0.00";
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
};

/**
 * Live token ↔ USD ratio. Click to flip direction:
 *   "1 XLM = $0.16"  ⇄  "$1 = 6.25 XLM"
 * Reads its own price externally (caller passes `tokenPrice`) so the parent
 * controls oracle wiring and refresh cadence.
 */
export const ConversionRatio = ({
  tokenSymbol,
  tokenPrice,
  className = "",
  variant = "pill",
}: ConversionRatioProps) => {
  const { isDark } = useTheme();
  const [showInverse, setShowInverse] = useState(false);

  const hasPrice = Number.isFinite(tokenPrice) && tokenPrice > 0;
  const ratioText = !hasPrice
    ? "Price unavailable"
    : showInverse
    ? `$1 = ${formatTokensPerDollar(1 / tokenPrice)} ${tokenSymbol}`
    : `1 ${tokenSymbol} = $${formatPrice(tokenPrice)}`;

  const baseText = isDark ? "text-[#A7A7A7]" : "text-[#777777]";
  const baseHoverText = isDark ? "hover:text-white" : "hover:text-[#111111]";

  if (variant === "inline") {
    return (
      <button
        type="button"
        onClick={() => hasPrice && setShowInverse((s) => !s)}
        disabled={!hasPrice}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium leading-none transition-colors ${
          isDark
            ? "bg-[#2A2A2A] text-[#A7A7A7] hover:bg-[#333333] hover:text-white"
            : "bg-[#EEEEEE] text-[#666666] hover:bg-[#E2E2E2] hover:text-[#111111]"
        } ${hasPrice ? "cursor-pointer" : "cursor-not-allowed opacity-60"} ${className}`}
        aria-label={`Conversion rate: ${ratioText}. Click to swap direction.`}
        title={hasPrice ? "Click to swap direction" : undefined}
      >
        <span>{ratioText}</span>
        {hasPrice && <SwapIcon />}
      </button>
    );
  }

  return (
    <motion.button
      type="button"
      onClick={() => hasPrice && setShowInverse((s) => !s)}
      disabled={!hasPrice}
      whileTap={hasPrice ? { scale: 0.97 } : undefined}
      transition={{ duration: 0.1 }}
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10.5px] font-medium border transition-colors ${
        isDark
          ? "border-[#2A2A2A] bg-transparent text-[#888888] hover:border-[#3A3A3A] hover:text-[#CCCCCC]"
          : "border-[#E5E5E5] bg-transparent text-[#777777] hover:border-[#CFCFCF] hover:text-[#333333]"
      } ${hasPrice ? "cursor-pointer" : "cursor-not-allowed opacity-60"} ${className}`}
      aria-label={`Conversion rate: ${ratioText}. Click to swap direction.`}
      title={hasPrice ? "Click to swap direction" : undefined}
    >
      <span className="leading-none">{ratioText}</span>
      {hasPrice && <SwapIcon />}
    </motion.button>
  );
};

const SwapIcon = () => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 12 12"
    fill="none"
    aria-hidden="true"
    className="opacity-70"
  >
    <path
      d="M3 4h6m0 0L7 2m2 2L7 6M9 8H3m0 0l2-2m-2 2l2 2"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
