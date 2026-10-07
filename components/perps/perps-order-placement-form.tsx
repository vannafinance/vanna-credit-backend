"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { useTheme } from "@/contexts/theme-context";
import { useOpenPerp } from "@/hooks/use-perps";
import type { PerpSide, PerpsView } from "@/lib/solana/perps-types";
import { LeverageSlider } from "../ui/leverage-slider";
import { QuantitySlider } from "../ui/quantity-slider";
import { fmtPrice, fmtTokenSize, fmtUsd, healthFactorDisplay } from "./perps-format";
import { defaultSlippageBps } from "@/lib/solana/perps";

const SLIPPAGE_OPTIONS = [
  { bps: 50, label: "0.5%" },
  { bps: 100, label: "1%" },
  { bps: 200, label: "2%" },
  { bps: 300, label: "3%" },
  { bps: 500, label: "5%" },
];

interface PerpsOrderPlacementFormProps {
  marketKey: string;
  view: PerpsView | undefined;
  address: string | null;
  connectWallet: () => void;
  /** Side preselected when the form opens (mobile bottom sheet). */
  initialSide?: PerpSide;
}

/** Leverage slider markers: integers from 1 to the market cap, thinned to at most 6. */
function leverageMarkers(max: number): number[] {
  const all: number[] = [];
  for (let i = 1; i <= Math.floor(max); i++) all.push(i);
  if (all.length <= 6) return all;
  const step = (max - 1) / 5;
  return [0, 1, 2, 3, 4, 5].map((i) => Math.round(1 + i * step));
}

/**
 * Market-order form for Phoenix perps: USDC collateral from the margin account × leverage.
 * Only what the protocol supports — market orders, open long / short, slippage protection.
 */
const PerpsOrderPlacementForm = ({
  marketKey,
  view,
  address,
  connectWallet,
  initialSide = "long",
}: PerpsOrderPlacementFormProps) => {
  const { isDark } = useTheme();
  const openPerp = useOpenPerp();

  const [side, setSide] = useState<PerpSide>(initialSide);
  const [collateralInput, setCollateralInput] = useState("");
  const [percentage, setPercentage] = useState(0);
  const [leverageRaw, setLeverageRaw] = useState(2);
  // Price limit around Phoenix's mark: 1% by default on crypto, 3% on the thinner stock books.
  const [slippageBps, setSlippageBps] = useState(() => defaultSlippageBps(marketKey));
  const [slippageFor, setSlippageFor] = useState(marketKey);
  if (slippageFor !== marketKey) {
    setSlippageFor(marketKey);
    setSlippageBps(defaultSlippageBps(marketKey));
  }
  const [sizeInUsd, setSizeInUsd] = useState(false);

  const market = view?.markets.find((m) => m.key === marketKey);
  const account = view?.account;
  const maxLeverage = Math.max(1, market?.maxLeverage ?? 5);
  const leverage = Math.min(Math.max(1, leverageRaw), maxLeverage);
  const available = account?.marginUsdc ?? 0;

  const parsedCollateral = Number(collateralInput);
  const collateral = Number.isFinite(parsedCollateral) && parsedCollateral > 0 ? parsedCollateral : 0;
  const sizeUsd = collateral * leverage;
  const price = market?.indexPrice;
  const indexPrice = price != null && Number.isFinite(price) && price > 0 ? price : null;
  const sizeTokens = indexPrice == null || !Number.isFinite(sizeUsd) ? null : sizeUsd / indexPrice;
  // The order's worst price is set from the live index price (Phoenix's mark as a fallback).
  const refPrice = indexPrice ?? (market?.markPrice && market.markPrice > 0 ? market.markPrice : null);
  const acceptablePrice = refPrice == null ? null : refPrice * (1 + (side === "long" ? 1 : -1) * slippageBps / 10_000);
  const currentHealth = account?.hasMargin ? healthFactorDisplay(account.healthFactor) : null;
  const zeroEquityPrice =
    indexPrice == null ? null : side === "long" ? indexPrice * (1 - 1 / leverage) : indexPrice * (1 + 1 / leverage);
  const pendingOrder = view?.orders.some((o) => o.market === marketKey && o.side === side) ?? false;

  const setCollateralFromPercent = (pct: number) => {
    setPercentage(pct);
    const value = Math.floor(((available * pct) / 100) * 100) / 100;
    setCollateralInput(value > 0 ? String(value) : "");
  };

  const onCollateralChange = (raw: string) => {
    if (raw !== "" && !/^\d*\.?\d{0,6}$/.test(raw)) return;
    setCollateralInput(raw);
    const n = Number(raw) || 0;
    setPercentage(available > 0 ? Math.min(100, Math.max(0, (n / available) * 100)) : 0);
  };

  const setLeverage = (v: number) => setLeverageRaw(Math.round(Math.min(maxLeverage, Math.max(1, v)) * 2) / 2);

  // Submit button state, in priority order.
  type ButtonState = { label: string; disabled: boolean; onClick?: () => void; marginLink?: boolean };
  const buttonState: ButtonState = (() => {
    if (!address) return { label: "Connect wallet", disabled: false, onClick: connectWallet };
    if (!view) return { label: "Loading…", disabled: true };
    if (!view.account.hasMargin) return { label: "Create a margin account first", disabled: true, marginLink: true };
    if (!market) return { label: "Market unavailable", disabled: true };
    if (!market.tradingEnabled) return { label: "Market closed", disabled: true };
    if (!(collateral > 0)) return { label: "Enter collateral", disabled: true };
    if (!Number.isFinite(sizeUsd)) return { label: "Amount too large", disabled: true };
    if (collateral > available) return { label: "Insufficient margin USDC", disabled: true };
    // A stale on-chain price doesn't block the button: placing the order refreshes the price feeds
    // first (and the program re-checks freshness). Only a missing price does.
    if (indexPrice == null) return { label: "Price updating…", disabled: true };
    if (pendingOrder) return { label: "Order pending", disabled: true };
    if (openPerp.isPending) return { label: "Placing order…", disabled: true };
    return {
      label: `${side === "long" ? "Long" : "Short"} ${marketKey} ${leverage}x`,
      disabled: false,
      onClick: () =>
        openPerp.mutate(
          { market: marketKey, side, collateral, leverage, slippageBps },
          {
            onSuccess: () => {
              setCollateralInput("");
              setPercentage(0);
            },
          },
        ),
    };
  })();

  const primary = isDark ? "text-[#FFFFFF]" : "text-[#111111]";
  const muted = isDark ? "text-[#919191]" : "text-[#5C5B5B]";
  const sideColor = side === "long" ? "#24A0A9" : "#FC5457";

  const summary: { label: string; value: string }[] = [
    { label: "Market", value: market?.name ?? `${marketKey}-PERP` },
    { label: "Side", value: side === "long" ? "Long" : "Short" },
    { label: "Notional size", value: sizeUsd > 0 ? `≈ $${fmtUsd(sizeUsd)}` : "—" },
    { label: "Est. entry price", value: indexPrice == null ? "—" : `≈ $${fmtPrice(indexPrice)}` },
    { label: side === "long" ? "Max. entry price" : "Min. entry price", value: acceptablePrice == null ? "—" : `$${fmtPrice(acceptablePrice)}` },
    {
      label: "Zero-equity price (before fees)",
      value: zeroEquityPrice == null || collateral <= 0 ? "--" : `$${fmtPrice(zeroEquityPrice)}`,
    },
    { label: "Collateral", value: collateral > 0 ? `${fmtUsd(collateral)} USDC` : "-- USDC" },
  ];

  return (
    <form
      onSubmit={(e) => e.preventDefault()}
      className={`w-full rounded-lg p-4 flex flex-col gap-5 text-[10px] leading-[15px] font-medium ${isDark ? "bg-[#222222] border border-[#333333] text-[#FFFFFF]" : "bg-[#F7F7F7] border border-[#E2E2E2] text-[#111111]"}`}
    >
      {/* long / short toggle */}
      <div className={`flex p-1 gap-1 rounded-lg ${isDark ? "bg-[#111111]" : "bg-white"}`}>
        {(["long", "short"] as const).map((s) => {
          const active = side === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={`flex-1 h-[35px] rounded-lg text-[12px] leading-[100%] font-semibold cursor-pointer transition-colors ${
                active ? "text-white" : isDark ? "text-[#A7A7A7] hover:text-white" : "text-[#5C5B5B] hover:text-[#111111]"
              }`}
              style={active ? { backgroundColor: s === "long" ? "#24A0A9" : "#FC5457" } : undefined}
            >
              {s === "long" ? "Long" : "Short"}
            </button>
          );
        })}
      </div>

      {/* order type: market only */}
      <div className="flex items-center justify-between">
        <span className={`text-[12px] leading-[18px] font-semibold border-b-2 border-[#703AE6] pb-1 ${primary}`}>Market</span>
        <span className={`text-[10px] leading-[15px] ${muted}`}>Market orders only</span>
      </div>

      {/* market price */}
      <div className="flex flex-col gap-1">
        <label className={`text-[11px] leading-[15px] font-medium ${primary}`}>Price</label>
        <div
          className={`h-9 flex items-center p-2 rounded-lg text-[12px] leading-[18px] font-medium ${isDark ? "bg-[#111111] border border-[#333333] text-[#FFFFFF]" : "bg-[#E2E2E2] border border-[#E2E2E2]"}`}
        >
          Fill at market price
          <span className="ml-auto text-[10px] leading-3 font-medium">
            {indexPrice == null ? "" : `≈ ${fmtPrice(indexPrice)} `}USD
          </span>
        </div>
      </div>

      {/* collateral */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <label className={`text-[11px] leading-[15px] font-medium ${primary}`}>Collateral</label>
            <span className={`text-[11px] leading-[15px] ${muted}`}>
              Available (margin) <span className={`font-semibold ${primary}`}>{fmtUsd(available)} USDC</span>
            </span>
          </div>
          <div
            className={`h-9 flex items-center gap-2 p-2 rounded-lg ${isDark ? "bg-[#111111] border border-[#333333]" : "bg-white border border-[#E2E2E2]"}`}
          >
            <input
              aria-label="Collateral amount in USDC"
              type="text"
              inputMode="decimal"
              placeholder="Enter Amount"
              value={collateralInput}
              onChange={(e) => onCollateralChange(e.target.value)}
              className={`flex-1 min-w-0 bg-transparent text-[12px] leading-[18px] font-medium outline-none ${isDark ? "text-[#FFFFFF] placeholder:text-[#555555]" : "placeholder:text-[#C6C6C6]"}`}
            />
            <button
              type="button"
              onClick={() => setCollateralFromPercent(100)}
              disabled={available <= 0}
              className="cursor-pointer text-[11px] font-semibold text-[#703AE6] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              MAX
            </button>
            <span className="flex items-center gap-1 text-[12px] leading-[18px] font-semibold">
              <Image src="/coins/usdc.svg" alt="USDC" width={14} height={14} />
              USDC
            </span>
          </div>
        </div>

        <QuantitySlider
          min={0}
          max={100}
          step={1}
          value={percentage}
          onChange={setCollateralFromPercent}
          markers={[0, 25, 50, 75, 100]}
        />
        <p className={`text-[10px] leading-[15px] ${muted}`}>
          USDC collateral only. {marketKey} is the traded asset, not the collateral token.
        </p>
      </div>

      {/* Position size: one compact row (size = collateral × leverage; tokens at the index price). */}
      <div
        className={`rounded-lg border px-3 py-2 flex items-center justify-between gap-2 ${isDark ? "bg-[#191919] border-[#333333]" : "bg-white border-[#E2E2E2]"}`}
        title="Size = collateral × leverage. Token quantity is estimated at the index price."
      >
        <div className="flex flex-col min-w-0">
          <span className={`text-[11px] leading-[15px] ${muted}`}>Position size</span>
          <span className={`text-[10px] leading-[14px] truncate ${muted}`}>
            {collateral > 0 ? (sizeInUsd ? `≈ ${fmtTokenSize(sizeTokens)} ${marketKey}` : `≈ $${fmtUsd(sizeUsd)}`) : "Enter collateral"}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <output className={`text-[15px] leading-5 font-semibold ${primary}`}>
            {collateral > 0 ? (sizeInUsd ? `$${fmtUsd(sizeUsd)}` : fmtTokenSize(sizeTokens)) : "—"}
            <span className={`ml-1 text-[11px] font-medium ${muted}`}>{sizeInUsd ? "USD" : marketKey}</span>
          </output>
          <button
            type="button"
            aria-label={`Show position size in ${sizeInUsd ? marketKey : "USD"}`}
            onClick={() => setSizeInUsd((value) => !value)}
            className={`rounded-md p-1 cursor-pointer ${isDark ? "bg-[#333333] hover:bg-[#444444]" : "bg-[#F4F4F4] hover:bg-[#E2E2E2]"}`}
          >
            <ArrowLeftRight size={12} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* leverage */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label className={`text-[11px] leading-[15px] font-medium ${primary}`}>Leverage</label>
          <span className={`text-[11px] leading-[15px] ${muted}`}>Max {maxLeverage}x</span>
        </div>
        <div className={`w-full rounded-lg p-0.5 flex items-center gap-1 ${isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"}`}>
          <button
            type="button"
            onClick={() => setLeverage(leverage - 0.5)}
            disabled={leverage <= 1}
            className={`w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${isDark ? "bg-[#333333] hover:bg-[#444444]" : "bg-[#F4F4F4] hover:bg-[#D5D5D5]"}`}
          >
            <Image src="/icons/minus.svg" alt="decrease" width={12} height={12} style={isDark ? { filter: "brightness(0) invert(1)" } : undefined} />
          </button>
          <div className={`flex-1 h-9 flex items-center justify-center text-[16px] leading-6 font-medium ${primary}`}>
            {leverage}
            <span className={`ml-1 ${isDark ? "text-[#A7A7A7]" : "text-[#6F6F6F]"}`}>×</span>
          </div>
          <button
            type="button"
            onClick={() => setLeverage(leverage + 0.5)}
            disabled={leverage >= maxLeverage}
            className={`w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${isDark ? "bg-[#333333] hover:bg-[#444444]" : "bg-[#F4F4F4] hover:bg-[#D5D5D5]"}`}
          >
            <Image src="/icons/plus.svg" alt="increase" width={12} height={12} style={isDark ? { filter: "brightness(0) invert(1)" } : undefined} />
          </button>
        </div>
        {maxLeverage > 1 && (
          <LeverageSlider
            min={1}
            max={maxLeverage}
            step={0.5}
            value={leverage}
            onChange={setLeverage}
            markers={leverageMarkers(maxLeverage)}
          />
        )}
      </div>

      {/* slippage */}
      <div className="flex flex-col gap-1.5">
        <span className={`text-[11px] leading-[15px] font-medium ${primary}`}>Slippage</span>
        {/* Five equal-width options that always fit the form column. */}
        <div className="grid grid-cols-5 gap-1.5">
          {SLIPPAGE_OPTIONS.map((o) => (
            <button
              key={o.bps}
              type="button"
              onClick={() => setSlippageBps(o.bps)}
              className={`cursor-pointer h-8 min-w-0 rounded-lg px-1 text-[12px] leading-[18px] font-medium ${
                slippageBps === o.bps
                  ? "bg-[#F1EBFD] text-[#703AE6]"
                  : isDark
                    ? "bg-[#111111] text-[#FFFFFF]"
                    : "bg-white text-[#111111]"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className={`rounded-lg border p-3 ${isDark ? "border-[#333333]" : "border-[#E2E2E2]"}`}>
          <p className={`text-[10px] ${muted}`}>CURRENT ACCOUNT HEALTH</p>
          <p className={`mt-2 text-[20px] leading-6 font-semibold ${currentHealth?.color ?? muted}`}>{currentHealth?.label ?? "—"}</p>
          <p className={`mt-1 text-[10px] ${muted}`}>Before this order</p>
        </div>
        <div className={`rounded-lg border p-3 ${isDark ? "border-[#333333]" : "border-[#E2E2E2]"}`}>
          <p className={`text-[10px] ${muted}`}>ORDER LEVERAGE</p>
          <p className={`mt-2 text-[20px] leading-6 font-semibold ${primary}`}>{leverage.toFixed(1)}×</p>
          <p className={`mt-1 text-[10px] ${muted}`}>Size / collateral</p>
        </div>
      </div>

      <div className={`rounded-xl border p-3 flex flex-col gap-2 text-[11px] ${isDark ? "border-[#333333]" : "border-[#E2E2E2]"}`}>
        <h3 className={`mb-1 text-[11px] font-semibold uppercase ${muted}`}>Position details · Order preview</h3>
        {summary.map((row) => (
          <p key={row.label} className="flex justify-between gap-3">
            <span className={muted}>{row.label}</span>
            <span className={`text-right ${primary}`} style={row.label === "Side" ? { color: sideColor } : undefined}>{row.value}</span>
          </p>
        ))}
        <p className={`mt-1 text-[10px] leading-[15px] ${muted}`}>
          Estimates exclude fees and price impact. Zero-equity price is not a liquidation quote.
          {view?.positions.some((position) => position.market === marketKey && position.side === side)
            ? " This order increases your existing position; values above describe only this order."
            : " Final position details appear after execution."}
        </p>
      </div>

      {/* submit */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled={buttonState.disabled}
          onClick={buttonState.onClick}
          className={`w-full py-3 rounded-lg text-[14px] font-medium text-white transition-opacity ${
            buttonState.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:opacity-90 active:opacity-80"
          } ${!address ? "bg-gradient" : ""}`}
          style={
            !address
              ? undefined
              : { backgroundColor: buttonState.disabled ? (isDark ? "#444444" : "#A7A7A7") : sideColor }
          }
        >
          {buttonState.label}
        </button>
        {buttonState.marginLink && (
          <Link href="/" className="text-center text-[12px] font-semibold text-[#703AE6] hover:underline">
            Create a margin account on the Margin page →
          </Link>
        )}
        <p className={`text-[10px] leading-[15px] ${muted}`}>
          Market order on Phoenix, filled immediately (or not at all) within your slippage of the index price. Your first
          trade also creates your Phoenix account (one extra wallet approval).
        </p>
      </div>
    </form>
  );
};

export default PerpsOrderPlacementForm;
