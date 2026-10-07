"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/contexts/theme-context";
import { useWallet } from "@/hooks/use-wallet";
import { usePerpsView } from "@/hooks/use-perps";
import type { PerpSide } from "@/lib/solana/perps-types";
import { Dropdown } from "@/components/ui/dropdown";
import TradingViewChart from "@/components/ui/trading-view-chart";
import PerpsOrderPlacementForm from "./perps-order-placement-form";
import PositionTables from "./position-tables";
import { PerpsAccountPanel } from "./non-orderbook";
import { PerpsPairInfo } from "./perps-pair-info";
import { pairSlug } from "./perps-format";

const PROTOCOL_OPTIONS = ["Phoenix"];
const FALLBACK_CHART_SYMBOL: Record<string, string> = {
  ETH: "PYTH:ETHUSD",
  BTC: "PYTH:BTCUSD",
  SOL: "PYTH:SOLUSD",
  TSLA: "NASDAQ:TSLA",
  META: "NASDAQ:META",
};

interface PerpsPageProps {
  /** "ETH" | "BTC" | "SOL" */
  marketKey: string;
}

/** Perps trading page: pair bar, chart, account panel, order form, positions / orders. */
const PerpsPage = ({ marketKey }: PerpsPageProps) => {
  const { isDark } = useTheme();
  const router = useRouter();
  const { address, connectWallet } = useWallet();
  const { view, isLoading, error } = usePerpsView();

  const [mobileTab, setMobileTab] = useState<"trade" | "chart">("trade");
  const [sheetSide, setSheetSide] = useState<PerpSide | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef(0);
  const currentTranslateY = useRef(0);
  const isDragging = useRef(false);

  const market = view?.markets.find((m) => m.key === marketKey);
  const markets = view?.markets ?? [];
  const chartSymbol = market?.chartSymbol ?? FALLBACK_CHART_SYMBOL[marketKey] ?? "PYTH:ETHUSD";
  const chartTheme = isDark ? "dark" : "light";
  const onSelectMarket = (key: string) => router.push(`/trade/perps/${pairSlug(key)}`);
  const connect = () => void connectWallet();

  const startDrag = (clientY: number) => {
    dragStartY.current = clientY;
    isDragging.current = true;
    if (sheetRef.current) sheetRef.current.style.transition = "none";
  };

  const moveDrag = (clientY: number) => {
    if (!isDragging.current) return;
    const deltaY = clientY - dragStartY.current;
    if (deltaY > 0) {
      currentTranslateY.current = deltaY;
      if (sheetRef.current) sheetRef.current.style.transform = `translateY(${deltaY}px)`;
    }
  };

  const endDrag = () => {
    if (!isDragging.current) return;
    isDragging.current = false;
    if (sheetRef.current) {
      sheetRef.current.style.transition = "transform 0.3s ease-out";
      if (currentTranslateY.current > 150) {
        sheetRef.current.style.transform = "translateY(100%)";
        setTimeout(() => setSheetSide(null), 300);
      } else {
        sheetRef.current.style.transform = "translateY(0)";
      }
    }
    currentTranslateY.current = 0;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    startDrag(e.clientY);
    const onMouseMove = (ev: MouseEvent) => moveDrag(ev.clientY);
    const onMouseUp = () => {
      endDrag();
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  // Lock body scroll while the mobile order sheet is open.
  useEffect(() => {
    document.body.style.overflow = sheetSide ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [sheetSide]);

  const card = isDark ? "bg-[#222222] border border-[#333333]" : "bg-[#F7F7F7] border border-[#E2E2E2]";

  const protocolBox = (label: string) => (
    <div className={`rounded-lg p-4 flex gap-5 ${card}`}>
      <div className="flex flex-col gap-1">
        <div className={`font-medium text-[12px] leading-[18px] ${isDark ? "text-[#A0A0A0]" : "text-[#6B7280]"}`}>{label}</div>
        <Dropdown
          items={PROTOCOL_OPTIONS}
          selectedOption={PROTOCOL_OPTIONS[0]}
          setSelectedOption={() => {}}
          classname={`gap-2 font-semibold text-[12px] leading-[18px] ${isDark ? "text-[#FFFFFF]" : "text-[#111111]"}`}
          dropdownClassname="text-[12px] leading-[18px] font-medium"
        />
      </div>
    </div>
  );

  const pairInfo = (
    <PerpsPairInfo marketKey={marketKey} market={market} markets={markets} onSelectMarket={onSelectMarket} />
  );

  const accountPanel = (
    <PerpsAccountPanel account={view?.account} walletConnected={!!address} isLoading={isLoading} />
  );

  const formProps = { marketKey, view, address, connectWallet: connect };

  return (
    <main
      className={`w-full min-h-screen pt-1 px-1 pb-20 md:pb-1 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_316px] gap-1 ${isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"}`}
    >
      {/* Left column */}
      <div className="flex flex-col gap-1 min-w-0">
        {error && (
          <div className="rounded-lg border border-[#FC5457]/40 bg-[#FC5457]/10 px-4 py-2 text-[12px] font-medium text-[#FC5457]">
            Couldn&apos;t load perps data: {error}
          </div>
        )}
        {view && view.markets.length === 0 && (
          <div className="rounded-lg border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-4 py-2 text-[12px] font-medium text-[#F59E0B]">
            Phoenix markets aren&apos;t listed on this network yet — trading opens once the admin lists them.
          </div>
        )}

        {/* Pair info + protocol — xl+ */}
        <div className="hidden xl:flex gap-1 relative z-40">
          {pairInfo}
          {protocolBox("Protocol")}
        </div>

        {/* Trade / Chart tabs — below xl */}
        <div
          className={`xl:hidden flex items-center rounded-lg overflow-hidden p-1 ${isDark ? "bg-[#222222] border border-[#333333]" : "bg-white border border-[#E2E2E2]"}`}
        >
          {(["trade", "chart"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`flex-1 py-3 text-center font-semibold text-[12px] leading-[100%] rounded-lg transition-colors cursor-pointer ${
                mobileTab === t ? "bg-[#703AE6] text-white" : isDark ? "text-[#A7A7A7]" : "text-[#111111]"
              }`}
              onClick={() => setMobileTab(t)}
            >
              {t === "trade" ? "Trade" : "Chart"}
            </button>
          ))}
        </div>

        {/* xl+: chart + account panel side by side */}
        <div className="hidden xl:flex gap-1">
          <div className="flex-1 h-[541px] rounded-lg overflow-hidden">
            <TradingViewChart symbol={chartSymbol} theme={chartTheme} />
          </div>
          <div className={`w-58.5 h-[541px] p-2 rounded-lg ${card}`}>{accountPanel}</div>
        </div>

        {/* Below xl: tab-based content */}
        <div className="xl:hidden">
          {mobileTab === "chart" ? (
            <div className="flex flex-col gap-2">
              <div className="relative z-40">{pairInfo}</div>
              {protocolBox("Chart Protocol")}
              <div className="rounded-lg overflow-hidden h-[400px] md:h-[500px]">
                <TradingViewChart symbol={chartSymbol} theme={chartTheme} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="relative z-40">{pairInfo}</div>
              <div className={`p-2 rounded-xl ${card}`}>{accountPanel}</div>
            </div>
          )}
        </div>

        {/* Position tables */}
        <div className="min-w-0">
          <PositionTables view={view} address={address} connectWallet={connect} />
        </div>
      </div>

      {/* Right column: order form — md+ */}
      <div className="hidden md:block md:row-span-2">
        <PerpsOrderPlacementForm key={marketKey} {...formProps} />
      </div>

      {/* Mobile: sticky bottom buttons */}
      <div
        className={`md:hidden fixed bottom-0 left-0 right-0 z-[100] flex gap-3 px-4 py-3 ${isDark ? "bg-[#222222] border-t border-[#333333]" : "bg-white border-t border-[#E2E2E2]"}`}
      >
        <button
          type="button"
          onClick={() => setSheetSide("long")}
          className="flex-1 py-3 rounded-lg text-[14px] font-semibold text-white bg-[#24A0A9] active:opacity-80 cursor-pointer"
        >
          Buy / Long
        </button>
        <button
          type="button"
          onClick={() => setSheetSide("short")}
          className="flex-1 py-3 rounded-lg text-[14px] font-semibold text-white bg-[#FC5457] active:opacity-80 cursor-pointer"
        >
          Sell / Short
        </button>
      </div>

      {/* Mobile: order bottom sheet */}
      {sheetSide && (
        <div className="md:hidden fixed inset-0 z-[200] bg-black/50" onClick={() => setSheetSide(null)}>
          <div
            ref={sheetRef}
            className={`absolute bottom-0 left-0 right-0 max-h-[90vh] overflow-y-auto rounded-t-2xl transition-transform duration-300 ease-out scrollbar-hide ${isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex justify-center pt-3 pb-2 cursor-grab"
              onTouchStart={(e) => startDrag(e.touches[0].clientY)}
              onTouchMove={(e) => moveDrag(e.touches[0].clientY)}
              onTouchEnd={endDrag}
              onMouseDown={handleMouseDown}
            >
              <div className={`w-10 h-1 rounded-full ${isDark ? "bg-[#444444]" : "bg-[#D5D5D5]"}`} />
            </div>
            <div className="px-2 pb-4">
              <PerpsOrderPlacementForm key={`${marketKey}-${sheetSide}`} {...formProps} initialSide={sheetSide} />
            </div>
          </div>
        </div>
      )}
    </main>
  );
};

export default PerpsPage;
