"use client";

/**
 * Farm position chart — same card look as the Stellar `components/earn/chart.tsx` "farm" variant
 * (heading, value line, timeframe chips, chart area), rendering the real series when one is
 * provided and an honest empty state otherwise. The Earn chart is owned by the Earn port, so the
 * Farm pages use this copy; it shows the current position value only (no synthetic history).
 */
import { memo, useState } from "react";
import { useTheme } from "@/contexts/theme-context";
import { SvgChart } from "../ui/svg-chart";

const FILTER_OPTIONS = ["1 Week", "1 Month", "3 Months", "All Time"];

interface FarmChartProps {
  heading: string;
  /** Formatted headline value, or null for "—". */
  value?: string | null;
  /** Real series (ISO date + amount); empty/undefined → empty state. */
  data?: Array<{ date: string; amount: number }>;
  emptyMessage?: string;
  height?: number;
}

export const FarmChart = memo(function FarmChart({ heading, value = null, data, emptyMessage = "No data available", height = 203 }: FarmChartProps) {
  const { isDark } = useTheme();
  const [selectedFilter, setSelectedFilter] = useState("All Time");
  const hasData = Boolean(data && data.length > 0);

  return (
    <article
      className={`flex flex-col gap-1.5 sm:gap-2 rounded-2xl p-3 border transition-colors overflow-hidden ${
        isDark ? "bg-[#1A1A1A] border-[#2A2A2A] hover:border-[#333333]" : "bg-white border-[#E8E8E8] hover:border-[#E2E2E2]"
      }`}
    >
      <header className="w-full h-fit flex flex-col gap-1.5 flex-shrink-0">
        <div className="w-fit h-fit flex flex-col gap-1">
          <h2 className={`text-[13px] font-medium leading-[18px] ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}>{heading}</h2>
          <p className={`w-full text-[17px] sm:text-[21px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>{value ?? "—"}</p>
        </div>
        {/* Time filter chips row */}
        <nav className="flex items-center gap-1 flex-wrap" aria-label="Time Range Selection">
          {FILTER_OPTIONS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setSelectedFilter(item)}
              disabled={!hasData}
              className={`cursor-pointer px-2 py-0.5 rounded-md text-[10px] font-semibold border transition-colors whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50 ${
                selectedFilter === item
                  ? "bg-[#703AE6] text-white border-[#703AE6]"
                  : isDark
                    ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                    : "bg-[#F0F0F0] text-[#888888] border-[#E2E2E2] hover:text-[#555555]"
              }`}
              aria-pressed={selectedFilter === item}
            >
              {item}
            </button>
          ))}
        </nav>
      </header>
      <figure className="w-full" style={{ height: `${height}px`, minHeight: `${height}px` }}>
        {hasData ? (
          <SvgChart
            data={Object.fromEntries(data!.map((d) => [d.date, d.amount]))}
            gradientColors={["rgba(112,58,230,0.35)", "rgba(112,58,230,0)"]}
            lineColor="#703AE6"
            height={height}
            textColor={isDark ? "#A7A7A7" : "#777777"}
            gridColor={isDark ? "#2A2A2A" : "#EEEEEE"}
            chartId="farm-position"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2">
            <p className={`text-sm font-medium text-center px-4 ${isDark ? "text-gray-400" : "text-gray-500"}`}>{emptyMessage}</p>
          </div>
        )}
      </figure>
    </article>
  );
});
