"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/contexts/theme-context";
import { usePerpsHistory, usePerpsView } from "@/hooks/use-perps";
import ActivePositionsTable from "@/components/perps/position-tables/active-positions-table";
import OpenOrdersTable from "@/components/perps/position-tables/open-orders-table";
import TradeHistoryTable from "@/components/perps/position-tables/trade-history-table";
import { pairSlug } from "@/components/perps/perps-format";

const TABS = [
  { id: "positions", label: "Open Positions" },
  { id: "orders", label: "Open Orders" },
  { id: "history", label: "Perps History" },
] as const;

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Portfolio "Perps" tab — the margin's GMTrade positions and pending orders (valued like the oracle
 * values them on every health check) and its decoded GMTrade history. Closing / cancelling happens
 * on the Perps page, which this links to.
 */
export const PerpsSection = () => {
  const { isDark } = useTheme();
  const router = useRouter();
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("positions");
  const { view, isLoading } = usePerpsView();
  const history = usePerpsHistory(tab === "history");
  const positions = view?.positions ?? [];
  const orders = view?.orders ?? [];
  const pnl = positions.reduce((s, p) => s + p.pnlUsd, 0);
  const sizeUsd = positions.reduce((s, p) => s + p.sizeUsd, 0);
  const goTrade = (market: string) => router.push(`/trade/perps/${pairSlug(market)}`);

  const card = isDark ? "bg-[#1a1a1a] border-[#333]" : "bg-white border-[#E8E8E8]";
  const label = "text-[12px] font-medium text-[#777777]";
  const value = `text-[20px] font-bold ${isDark ? "text-white" : "text-[#111111]"}`;
  const stats = [
    { id: "value", label: "Perps Value", value: fmtUsd(view?.account.venueValueUsd ?? 0), hint: "Idle USDC + escrowed orders + position equity, as Vanna values it." },
    { id: "size", label: "Open Size", value: fmtUsd(sizeUsd), hint: "Total notional of open positions." },
    {
      id: "pnl",
      label: "Unrealized PnL",
      value: `${pnl >= 0 ? "+" : "−"}${fmtUsd(Math.abs(pnl))}`,
      color: pnl > 0 ? "text-[#24A0A9]" : pnl < 0 ? "text-[#FC5457]" : undefined,
      hint: "Mark-price PnL before fees.",
    },
    { id: "count", label: "Positions / Orders", value: `${positions.length} / ${orders.length}`, hint: "Open positions and pending orders." },
  ];

  return (
    <div className="w-full flex flex-col gap-[16px]">
      <div className={`grid grid-cols-2 sm:grid-cols-4 gap-4 rounded-[16px] border p-5 ${card}`}>
        {stats.map((s) => (
          <div key={s.id} className="flex flex-col gap-1" title={s.hint}>
            <span className={label}>{s.label}</span>
            <span className={`${value} ${s.color ?? ""}`}>{isLoading ? "…" : s.value}</span>
          </div>
        ))}
      </div>

      <div className={`flex items-center rounded-[8px] border p-1 gap-1 w-full sm:w-fit ${card}`}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex-1 sm:flex-none sm:px-4 rounded-[8px] py-[10px] text-[12px] font-semibold cursor-pointer transition ${
              tab === t.id ? "bg-[#f1ebfd] text-[#703ae6]" : isDark ? "text-white hover:bg-[#333]" : "text-[#111] hover:bg-[#f7f7f7]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "positions" && (
        <ActivePositionsTable positions={positions} onClose={(p) => goTrade(p.market)} closeDisabled={false} />
      )}
      {tab === "orders" && <OpenOrdersTable orders={orders} onCancel={(o) => goTrade(o.market)} cancelDisabled={false} />}
      {tab === "history" && <TradeHistoryTable rows={history.rows} loading={history.isLoading} />}
    </div>
  );
};
