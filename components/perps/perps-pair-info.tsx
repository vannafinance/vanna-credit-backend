"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/contexts/theme-context";
import type { PerpMarketInfo } from "@/lib/solana/perps-types";
import { fmtPrice } from "./perps-format";

interface PerpsPairInfoProps {
  marketKey: string;
  market: PerpMarketInfo | undefined;
  markets: PerpMarketInfo[];
  onSelectMarket: (key: string) => void;
}

/* eslint-disable @next/next/no-img-element -- market icons come from the perps data layer and may be remote */

/**
 * Pair info bar: pair selector (the listed Phoenix markets), live index price and the market
 * stats the protocol actually exposes.
 */
export const PerpsPairInfo = ({ marketKey, market, markets, onSelectMarket }: PerpsPairInfoProps) => {
  const { isDark } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [isOpen]);

  const pair = `${marketKey}USDC`;
  const icon = market?.icon || `/coins/${marketKey.toLowerCase()}.svg`;
  const price = market?.indexPrice ?? null;

  const stats = [
    { label: "Index price", value: price == null ? "—" : `$${fmtPrice(price)}` },
    { label: "Max leverage", value: market ? `${market.maxLeverage}x` : "—" },
    {
      label: "Market status",
      value: market ? (market.tradingEnabled ? "Open" : "Closed") : "—",
      color: market ? (market.tradingEnabled ? "text-[#24A0A9]" : "text-[#FC5457]") : undefined,
    },
    {
      label: "Price feed",
      value: market ? (market.priceFresh ? "Fresh" : "Updating") : "—",
      color: market ? (market.priceFresh ? "text-[#24A0A9]" : "text-[#F5A524]") : undefined,
    },
  ];

  const muted = isDark ? "text-[#A0A0A0]" : "text-[#6B7280]";
  const primary = isDark ? "text-[#FFFFFF]" : "text-[#111111]";

  return (
    <div ref={ref} className="relative flex-1">
      <div
        className={`border rounded-lg p-4 flex flex-col xl:flex-row flex-1 gap-3 xl:gap-5 ${isDark ? "bg-[#222222] border-[#333333]" : "bg-[#F7F7F7] border-[#E2E2E2]"}`}
      >
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setIsOpen((v) => !v)}
            className="flex items-center gap-3 xl:px-4 cursor-pointer outline-none"
          >
            <img src={icon} alt={pair} height={24} width={24} className="rounded-full" />
            <div>
              <div className={`${primary} text-[16px] leading-6 font-semibold`}>{pair}</div>
              <div
                className={`text-[12px] leading-[18px] font-medium text-left ${isDark ? "text-[#919191]" : "text-[#57585C]"}`}
              >
                perps
              </div>
            </div>
            <Image
              src="/icons/down-arrow.svg"
              alt="arrow"
              height={16}
              width={16}
              className={`transition-transform duration-200 ease-in-out ${isOpen ? "rotate-180" : "rotate-0"}`}
              style={isDark ? { filter: "brightness(0) invert(1)" } : undefined}
            />
          </button>
          <div className={`flex flex-col justify-center ${primary}`}>
            <div className="text-[16px] leading-6 font-bold">
              {price == null ? (
                <span className={`inline-block h-5 w-24 rounded animate-pulse ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`} />
              ) : (
                fmtPrice(price)
              )}
            </div>
            <div className={`text-[12px] leading-[18px] font-medium ${muted}`}>Index price (USD)</div>
          </div>
        </div>

        <div
          className={`grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4 pt-3 border-t xl:flex xl:items-center xl:border-t-0 xl:pt-0 ${isDark ? "border-[#333333]" : "border-[#E2E2E2]"}`}
        >
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-0.5">
              <span className={`font-medium text-[11px] leading-4 whitespace-nowrap ${muted}`}>{stat.label}</span>
              <span className={`font-semibold text-[12px] leading-[18px] ${stat.color ?? primary}`}>{stat.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Pair selector */}
      {isOpen && (
        <div
          className={`absolute top-[calc(100%+4px)] left-0 z-50 w-full sm:w-[420px] rounded-lg border p-2 shadow-xl ${isDark ? "bg-[#222222] border-[#333333]" : "bg-white border-[#E2E2E2]"}`}
        >
          <div className={`grid grid-cols-[1fr_auto_auto] gap-4 px-3 py-2 text-[11px] font-medium ${muted}`}>
            <span>Market</span>
            <span className="text-right">Index price</span>
            <span className="text-right w-16">Max lev.</span>
          </div>
          {markets.length === 0 && (
            <div className={`px-3 py-4 text-[12px] ${muted}`}>Loading markets…</div>
          )}
          {markets.map((m) => {
            const active = m.key === marketKey;
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  onSelectMarket(m.key);
                }}
                className={`w-full grid grid-cols-[1fr_auto_auto] gap-4 items-center px-3 py-2.5 rounded-lg cursor-pointer text-left transition-colors ${
                  active
                    ? isDark
                      ? "bg-[#333333]"
                      : "bg-[#F1EBFD]"
                    : isDark
                      ? "hover:bg-[#2A2A2A]"
                      : "hover:bg-[#F7F7F7]"
                }`}
              >
                <span className="flex items-center gap-2">
                  <img src={m.icon || `/coins/${m.key.toLowerCase()}.svg`} alt={m.key} width={20} height={20} className="rounded-full" />
                  <span className={`text-[13px] font-semibold ${active ? "text-[#703AE6]" : primary}`}>{m.key}USDC</span>
                  {!m.tradingEnabled && (
                    <span className="text-[10px] font-semibold text-[#FC5457]">Closed</span>
                  )}
                </span>
                <span className={`text-[12px] font-medium text-right ${primary}`}>{fmtPrice(m.indexPrice)}</span>
                <span className={`text-[12px] font-medium text-right w-16 ${primary}`}>{m.maxLeverage}x</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
