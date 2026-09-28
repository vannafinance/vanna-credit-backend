"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { motion } from "framer-motion";

import { Dropdown } from "../ui/dropdown";
import { LeverageSlider } from "../ui/leverage-slider";
import { ConversionRatio } from "@/components/ui/conversion-ratio";
import { useTheme } from "@/contexts/theme-context";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { DropdownOptions } from "@/lib/constants";
import { MAX_LEVERAGE } from "@/lib/constants/margin";
import type { BorrowInfo } from "@/lib/types";
import { splitBorrowUsd } from "@/lib/margin/amounts";

const BRAND_RED = "#FC5457";
const GRADIENT = "linear-gradient(135deg, #FC5457 10%, #703AE6 80%)";

/** Leverage values are kept at 2-decimal precision (the slider steps in float 0.1s). */
const roundLev = (v: number) => Math.round(v * 100) / 100;

/** Slider marker positions: 1x, whole multiples in between, and the max itself. */
const leverageMarkers = (max: number): number[] => {
  const whole = Math.floor(max);
  const stride = whole > 8 ? Math.ceil((whole - 1) / 4) : whole > 5 ? 2 : 1;
  const out: number[] = [];
  for (let m = 1; m < max - 0.25; m += stride) out.push(m);
  out.push(max);
  return out;
};

const fmtUsd = (n: number) =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Validated state emitted to the parent so it can gate the submit button. */
export interface DualBorrowState {
  items: BorrowInfo[];
  totalUsd: number;
  maxUsd: number;
  isValid: boolean;
  error: string | null;
}

interface DualBorrowProps {
  /** Collateral USD being deposited (WB) or sized from the margin balance (MB) — drives the borrow ceiling. */
  depositUsd: number;
  leverage: number;
  setLeverage: (v: number) => void;
  /**
   * Account-wide max leverage for this input, from `maxLeverageForInput` (lib/margin/amounts.ts):
   * derived from the HF rule at SAFE_HEALTH_FACTOR (≈7.67x for a fresh account). Defaults to the
   * fresh-account figure.
   */
  maxLeverage?: number;
  /**
   * Absolute account-wide borrow limit in USD at SAFE_HEALTH_FACTOR (`maxBorrowUsdAfterDeposit` /
   * `maxBorrowUsd`). Manual amounts above it are flagged even if under the leverage ceiling.
   */
  accountMaxBorrowUsd?: number;
  /** Fires on every change with the assembled items + validity. */
  onChange?: (state: DualBorrowState) => void;
}

type BorrowMode = "single" | "dual";

/**
 * Dual-borrow surface: borrow one or two assets against deposited collateral.
 * Both assets go out in ONE transaction (`depositAndBorrow({ deposits, borrows: [a, b] })`);
 * a borrow asset different from the deposit asset is a cross-asset borrow.
 *
 * Manual amounts are primary — the user types how much of each asset to borrow.
 * The leverage slider sets the borrow ceiling (`Max = deposit × (leverage − 1)`), and the
 * slider's own max comes from the account-wide health rule (`maxLeverage` prop);
 * exceeding it turns the affected card + the Total line red and reports an
 * invalid state to the parent (which disables submit). Responsive: the two
 * borrow cards stack on mobile and sit side-by-side from `lg` up. Borrow
 * execution is wired by the parent — this component owns input + validation only.
 */
export const DualBorrow = ({ depositUsd, leverage, setLeverage, maxLeverage = MAX_LEVERAGE, accountMaxBorrowUsd, onChange }: DualBorrowProps) => {
  const { isDark } = useTheme();
  // Every registry token's on-chain price (0 while unknown — never a made-up fallback).
  const prices = useTokenPrices();
  const bgColor = isDark ? "#1A1A1A" : "#ffffff";

  const [mode, setMode] = useState<BorrowMode>("single");
  // Default to two distinct registry assets so dual mode is valid out of the box.
  const [tokens, setTokens] = useState<[string, string]>([
    DropdownOptions[1] ?? DropdownOptions[0],
    DropdownOptions[0],
  ]);
  const [amounts, setAmounts] = useState<[string, string]>(["", ""]);

  const slotCount = mode === "dual" ? 2 : 1;

  const priceOf = useCallback((sym: string) => prices[sym] ?? 0, [prices]);
  const sliderMax = Math.max(1, maxLeverage);
  const markers = useMemo(() => leverageMarkers(sliderMax), [sliderMax]);
  const changeLeverage = useCallback((v: number) => setLeverage(roundLev(Math.max(1, Math.min(sliderMax, v)))), [setLeverage, sliderMax]);

  const maxUsd = useMemo(() => Math.max(0, depositUsd * (leverage - 1)), [depositUsd, leverage]);

  // Leverage-driven auto-calc. The borrow follows the deposit × (leverage − 1)
  // ceiling: single mode puts the whole amount on the one asset; dual mode
  // splits it 50/50. So saving the deposit (or moving the slider) fills the
  // borrow automatically — no Max Value click needed. The user can still type to
  // override a card; a manual edit pauses auto-fill (so a price tick doesn't
  // clobber it) until a driving input — deposit, leverage, mode, or asset —
  // changes, which returns control to auto-calc.
  const manualRef = useRef(false);
  // Token amounts come from the shared `splitBorrowUsd` helper (equal USD shares, floored to each
  // token's decimals) — the same math the margin verification script exercises on the fork.
  const fillFromLeverage = useCallback(() => {
    const symbols = mode === "single" ? [tokens[0]] : [tokens[0], tokens[1]];
    const split = splitBorrowUsd(maxUsd, symbols, prices);
    setAmounts([split[0]?.amount ?? "", split[1]?.amount ?? ""]);
  }, [mode, maxUsd, tokens, prices]);

  // Driving inputs (deposit/leverage via maxUsd, mode, asset) → reset to auto.
  useEffect(() => {
    manualRef.current = false;
    fillFromLeverage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, maxUsd, tokens[0], tokens[1]]);

  // Price tick → keep the auto amounts in sync, but never clobber a manual edit.
  useEffect(() => {
    if (!manualRef.current) fillFromLeverage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices]);

  const usds = useMemo(
    () => [0, 1].map((i) => (i < slotCount ? (parseFloat(amounts[i]) || 0) * priceOf(tokens[i]) : 0)),
    [amounts, tokens, slotCount, priceOf],
  );
  const totalUsd = usds[0] + usds[1];

  // ── Validation: every "more than borrowable" scenario the user can hit ──────
  const { error, exceeds, duplicate } = useMemo(() => {
    const duplicate = slotCount === 2 && tokens[0] === tokens[1];
    if (totalUsd > 0 && depositUsd <= 0) {
      return { error: "Add collateral before borrowing.", exceeds: false, duplicate };
    }
    if (duplicate) {
      return { error: "Pick two different assets to borrow.", exceeds: false, duplicate };
    }
    // 1-cent tolerance: the leverage auto-fill targets exactly maxUsd, and
    // amount→USD rounding can land a hair above it — don't flag that as an
    // over-borrow. Only a real manual overshoot trips the red text.
    if (totalUsd > maxUsd + 0.01) {
      return {
        error: `Total borrow ${fmtUsd(totalUsd)} exceeds your limit of ${fmtUsd(maxUsd)}. Lower an amount or raise leverage.`,
        exceeds: true,
        duplicate,
      };
    }
    if (accountMaxBorrowUsd !== undefined && totalUsd > accountMaxBorrowUsd + 0.01) {
      return {
        error: `Total borrow ${fmtUsd(totalUsd)} exceeds your account's safe borrow limit of ${fmtUsd(accountMaxBorrowUsd)} (Health Factor must stay above 1.15).`,
        exceeds: true,
        duplicate,
      };
    }
    return { error: null, exceeds: false, duplicate };
  }, [totalUsd, maxUsd, depositUsd, slotCount, tokens, accountMaxBorrowUsd]);

  const isValid = totalUsd > 0 && error === null;

  // Emit assembled items + validity to the parent.
  useEffect(() => {
    const items: BorrowInfo[] = [];
    for (let i = 0; i < slotCount; i++) {
      const amount = parseFloat(amounts[i]) || 0;
      if (amount > 0) {
        items.push({
          assetData: { asset: tokens[i], amount: amounts[i] },
          percentage: depositUsd > 0 ? Number(((usds[i] / depositUsd) * 100).toFixed(2)) : 0,
          usdValue: usds[i],
        });
      }
    }
    onChange?.({ items, totalUsd, maxUsd, isValid, error });
    // onChange is treated as stable by callers (memoised); excluding it avoids
    // a feedback loop on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amounts, tokens, slotCount, totalUsd, maxUsd, isValid, error, depositUsd]);

  const setToken = (i: number) => (v: string | ((p: string) => string)) =>
    setTokens((prev) => {
      const next: [string, string] = [...prev];
      next[i] = typeof v === "function" ? v(prev[i]) : v;
      return next;
    });

  const setAmount = (i: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return; // numeric only
    manualRef.current = true; // user override → pause leverage auto-fill
    setAmounts((prev) => {
      const next: [string, string] = [...prev];
      next[i] = raw;
      return next;
    });
  };

  // "Max Value" (single mode): snap leverage to the account-wide safe max. The borrow is
  // leverage-driven, so this maxes the slider and the auto-fill then fills the
  // amount to deposit × (maxLeverage − 1) — one click for the largest safe position.
  const handleMaxValue = () => changeLeverage(sliderMax);

  const cardBase = isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]";
  const labelMuted = isDark ? "text-[#A7A7A7]" : "text-[#888888]";
  const subMuted = isDark ? "text-[#777777]" : "text-[#A7A7A7]";

  const renderCard = (i: number) => {
    const usd = usds[i];
    // A slot is in error when the total over-borrows (highlight all active slots)
    // or it's a duplicate-asset slot.
    const cardError = (exceeds && usd > 0) || (duplicate && i === 1);
    return (
      <motion.article
        key={i}
        className={`w-full min-w-0 rounded-2xl p-3 sm:p-4 flex flex-col gap-1.5 sm:gap-2 border transition-colors ${cardBase}`}
        style={cardError ? { borderColor: BRAND_RED } : undefined}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.25, delay: i * 0.06 }}
      >
        <div className="flex items-center justify-between min-h-[26px]">
          <span className={`text-sm font-medium ${labelMuted}`}>Borrow</span>
          {/* Max Value only in single mode. In dual mode the amount is auto-split
              50/50 from leverage, so a per-card "max" would overfill one side
              and zero the other — it has no meaning here. */}
          {mode === "single" && (
            <motion.button
              type="button"
              onClick={handleMaxValue}
              className={`px-3 py-1 rounded-lg shrink-0 text-[11px] font-semibold whitespace-nowrap cursor-pointer ${
                isDark ? "text-white" : "text-[#111111]"
              }`}
              style={{
                background: `linear-gradient(${bgColor}, ${bgColor}) padding-box, ${GRADIENT} border-box`,
                border: "1.2px solid transparent",
              }}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              aria-label={`Borrow the maximum — set leverage to ${sliderMax.toFixed(2)}x`}
            >
              Max Value
            </motion.button>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="shrink-0">
            <Dropdown
              dropdownClassname="text-[13px] gap-2"
              items={DropdownOptions}
              selectedOption={tokens[i]}
              setSelectedOption={setToken(i)}
              classname={`gap-2 px-3 py-2 rounded-full! text-[14px] font-semibold transition-colors ${
                isDark ? "bg-[#2A2A2A] hover:bg-[#333333] text-white" : "bg-[#EEEEEE] hover:bg-[#E2E2E2] text-[#111111]"
              }`}
              arrowClassname="size-3"
            />
          </div>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={amounts[i]}
            onChange={setAmount(i)}
            aria-invalid={cardError}
            className={`flex-1 min-w-0 text-[22px] sm:text-[28px] font-semibold bg-transparent text-right outline-none placeholder:opacity-20 ${
              isDark ? "text-white placeholder:text-white" : "text-[#111111] placeholder:text-[#111111]"
            }`}
          />
        </div>

        <div className={`flex items-center justify-between gap-2 text-[12px] font-medium ${subMuted}`}>
          <ConversionRatio tokenSymbol={tokens[i]} tokenPrice={priceOf(tokens[i])} variant="inline" />
          <span className="shrink-0">≈ {fmtUsd(usd)}</span>
        </div>
      </motion.article>
    );
  };

  return (
    <section className="w-full min-w-0 flex flex-col gap-3">
      {/* Header: Borrow + Single/Dual toggle */}
      <div className="flex items-center justify-between gap-2">
        <span className={`text-base font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>Borrow</span>
        <div className="flex items-center gap-2 text-[12px] font-medium">
          <span className={mode === "single" ? (isDark ? "text-white" : "text-[#111111]") : subMuted}>
            Single Borrow
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={mode === "dual"}
            aria-label="Toggle dual borrow"
            onClick={() => setMode((m) => (m === "single" ? "dual" : "single"))}
            className="relative w-10 h-5 rounded-full transition-colors cursor-pointer shrink-0"
            style={{ background: mode === "dual" ? GRADIENT : isDark ? "#333333" : "#D1D5DB" }}
          >
            <motion.span
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow"
              animate={{ left: mode === "dual" ? "calc(100% - 1.125rem)" : "0.125rem" }}
              transition={{ type: "spring", stiffness: 500, damping: 32 }}
            />
          </button>
          <span className={mode === "dual" ? (isDark ? "text-white" : "text-[#111111]") : subMuted}>
            Dual Borrow
          </span>
        </div>
      </div>

      {/* Borrow cards — stacked on mobile, side-by-side from lg up */}
      <div className={`w-full min-w-0 grid gap-3 ${mode === "dual" ? "grid-cols-1 lg:grid-cols-2" : "grid-cols-1"}`}>
        {Array.from({ length: slotCount }).map((_, i) => renderCard(i))}
      </div>

      {/* Total + Max */}
      <div className="flex items-center justify-between text-sm">
        <span className={`font-semibold ${exceeds ? "" : isDark ? "text-white" : "text-[#111111]"}`} style={exceeds ? { color: BRAND_RED } : undefined}>
          Total: {fmtUsd(totalUsd)}
        </span>
        <span className={`font-medium ${subMuted}`}>Max: {fmtUsd(maxUsd)}</span>
      </div>

      {/* Inline validation message */}
      {error && (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-[12px] font-medium"
          style={{ color: BRAND_RED }}
          role="alert"
        >
          {error}
        </motion.p>
      )}

      {/* Leverage slider — sets the borrow ceiling (Max) */}
      <section className="relative z-0 flex items-start justify-between gap-3">
        <div className={`flex gap-0.5 items-center rounded-lg border p-0.5 shrink-0 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E2E2E2]"}`}>
          <button
            type="button"
            onClick={() => leverage > 1 && changeLeverage(Math.max(1, Math.ceil(leverage) - 1))}
            disabled={leverage <= 1}
            className={`w-4 h-8 flex items-center justify-center rounded-md text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed ${isDark ? "text-white hover:bg-[#222222]" : "hover:bg-[#F7F7F7]"}`}
            aria-label="Decrease leverage"
          >
            −
          </button>
          <span className={`min-w-8 px-0.5 h-8 flex items-center justify-center text-[14px] font-medium ${isDark ? "text-white" : ""}`}>
            {Number.isInteger(leverage) ? leverage : leverage.toFixed(2)}
          </span>
          <button
            type="button"
            onClick={() => leverage < sliderMax && changeLeverage(Math.floor(leverage) + 1)}
            disabled={leverage >= sliderMax}
            className={`w-4 h-8 flex items-center justify-center rounded-md text-[14px] font-medium disabled:opacity-50 disabled:cursor-not-allowed ${isDark ? "text-white hover:bg-[#222222]" : "hover:bg-[#F7F7F7]"}`}
            aria-label="Increase leverage"
          >
            +
          </button>
        </div>
        <div className="flex-1 min-w-0 pl-2 mt-1.5">
          <LeverageSlider value={Math.min(leverage, sliderMax)} onChange={changeLeverage} max={sliderMax} min={1} step={0.1} markers={markers} />
        </div>
      </section>
    </section>
  );
};
