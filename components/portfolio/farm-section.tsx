"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Table } from "@/components/earn/table";
import { useTheme } from "@/contexts/theme-context";
import { positionsTableHeadings } from "@/lib/constants/farm";
import { transactionTableHeadings } from "@/components/earn/acitivity-tab";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore } from "@/store/margin-account-info-store";
import { useFarmStore } from "@/store/farm-store";
import { useMarginHistory } from "@/hooks/use-margin";
import { useFarmPools, useFarmPositions } from "@/lib/farm/use-farm";
import { formatMetric } from "@/lib/farm/pools";
import { explorerUrl } from "@/lib/solana/config";

const fmtUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Portfolio "Farm" tab — the margin account's real Kamino Lend (single-asset) farm positions,
 * from the same hooks as the Farm page: positions are the margin-held cTokens valued at the
 * reserve's exchange rate (exactly like the health factor values them), APY is Kamino's own
 * supply APY. Position History = decoded on-chain farm-deposit / farm-withdraw events. P&L has no
 * on-chain cost-basis source, so it is not shown rather than guessed.
 */
export const FarmSection = () => {
  const { isDark } = useTheme();
  const [activeFilterTab, setActiveFilterTab] = useState("current-position");
  const router = useRouter();
  const setFarmData = useFarmStore((s) => s.set);

  const totalCollateralValue = useMarginAccountInfoStore((s) => s.totalCollateralValue);
  const userAddress = useUserStore((s) => s.address);
  const { pools } = useFarmPools();
  const { positions } = useFarmPositions(userAddress);
  const { rows: marginHistory } = useMarginHistory();

  const rows = useMemo(
    () =>
      positions.map((position) => {
        const pool = pools.find((p) => p.id === position.poolId);
        return {
          id: position.poolId,
          cell: [
            { chain: position.symbol, title: position.symbol, tags: ["Kamino", "Supply"] },
            { title: "Kamino" },
            {
              title: `${position.underlying.toFixed(4)} ${position.symbol}`,
              description: `${position.receipts.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${position.receiptSymbol} · ${fmtUsd(position.liquidityUsd)}`,
            },
            { title: formatMetric(pool?.supplyApy ?? null, "pct") },
          ],
          usd: position.liquidityUsd,
        };
      }),
    [positions, pools],
  );

  const totalFarmUsd = rows.reduce((sum, r) => sum + r.usd, 0);
  const weightedApy = totalFarmUsd > 0
    ? rows.reduce((sum, r) => {
        const apy = pools.find((p) => p.id === r.id)?.supplyApy;
        return apy === null || apy === undefined ? sum : sum + apy * r.usd;
      }, 0) / totalFarmUsd
    : null;

  const FARMING_INFO_STATS: { label: string; value: string; positive: boolean | null }[] = [
    { label: "Total Farm Value", value: fmtUsd(totalFarmUsd), positive: null },
    { label: "Active Vaults", value: String(rows.length), positive: null },
    { label: "Weighted Supply APY", value: formatMetric(weightedApy, "pct"), positive: weightedApy !== null && weightedApy > 0 ? true : null },
    { label: "Share of Margin Account", value: totalCollateralValue > 0 ? `${((totalFarmUsd / totalCollateralValue) * 100).toFixed(1)}%` : "—", positive: null },
  ];

  const historyRows = useMemo(
    () =>
      marginHistory
        .filter((r) => r.type === "farm-deposit" || r.type === "farm-withdraw")
        .map((r) => ({
          cell: [
            { title: new Date(r.timestamp).toLocaleDateString(), description: new Date(r.timestamp).toLocaleTimeString() },
            { title: r.type === "farm-deposit" ? "Supply" : "Withdraw", badge: r.type === "farm-deposit" ? "green" : "orange" },
            { title: `${Number(r.amount).toFixed(4)} ${r.symbol}`, description: "Kamino" },
            { title: "Success", badge: "green" },
            { title: `${r.signature.slice(0, 8)}...${r.signature.slice(-4)}`, clickable: "link", link: explorerUrl("tx", r.signature) },
          ],
        })),
    [marginHistory],
  );

  const filterTabTypeOptions = [
    { id: "current-position", label: "Current Position" },
    { id: "position-history", label: "Position History" },
  ];

  const tableData = useMemo(
    () =>
      activeFilterTab === "position-history"
        ? { headings: transactionTableHeadings, body: { rows: historyRows } }
        : { headings: positionsTableHeadings, body: { rows: rows.map(({ cell }) => ({ cell })) } },
    [activeFilterTab, historyRows, rows],
  );

  const handleRowClick = useCallback(
    (_row: unknown, rowIndex: number) => {
      const row = rows[rowIndex];
      if (!row) return;
      setFarmData({ tabType: "single" });
      router.push(`/farm/${row.id}`);
    },
    [rows, router, setFarmData],
  );

  return (
    <div className="w-full h-fit flex flex-col gap-[20px]">
      {/* Info + analytics-placeholder row (mirrors the Lender tab's layout) */}
      <div className="w-full flex flex-col lg:flex-row gap-4 sm:gap-[20px]">
        {/* Farming Info panel */}
        <div className={`w-full lg:w-[422px] flex-shrink-0 flex flex-col rounded-xl border overflow-hidden ${
          isDark ? "bg-[#222222] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"
        }`}>
          <div className={`px-5 pt-5 pb-4 border-b flex-shrink-0 ${isDark ? "border-[#2A2A2A]" : "border-[#e5e7eb]"}`}>
            <h3 className={`text-[16px] font-bold ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>Farming Info</h3>
          </div>
          <div className="flex flex-col overflow-y-auto px-5 pb-5">
            {FARMING_INFO_STATS.map(({ label, value, positive }) => (
              <div key={label} className="flex justify-between items-center py-[10px]">
                <span className={`text-[14px] font-medium tracking-[0.01em] whitespace-pre-line ${isDark ? "text-[#919191]" : "text-[#777777]"}`}>
                  {label}
                </span>
                <span className={`text-[14px] font-semibold flex-shrink-0 ${
                  positive === true ? "text-[#16a34a]"
                  : positive === false ? "text-[#dc2626]"
                  : isDark ? "text-white" : "text-[#1A1A1A]"
                }`}>
                  {value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Analytics placeholder — no value-over-time model for farm positions yet.
            Matches the Lender tab's honest "Coming soon". */}
        <div className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-1 rounded-[16px] border p-5 min-h-[180px] ${
          isDark ? "bg-[#1a1a1a] border-[#333]" : "bg-white border-[#E8E8E8]"
        }`}>
          <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#1A1A1A]"}`}>Farm Equity</span>
          <span className="text-[12px] font-medium text-[#777777]">Coming soon</span>
        </div>
      </div>

      {/* Positions Table — real Kamino farm positions held by the margin account.
          Rendered whenever a wallet is connected, regardless of whether the
          Current Position tab happens to be empty — Position History can
          still have entries (e.g. a fully-closed position) even when there's
          nothing open right now, and the Table component's own empty state
          ("No data available") covers the genuinely-empty case for both tabs. */}
      {!userAddress ? (
        <div className={`w-full rounded-[16px] border px-5 py-10 text-center text-[14px] font-medium ${
          isDark ? "bg-[#222222] border-[#2A2A2A] text-[#777777]" : "bg-[#F7F7F7] border-[#E8E8E8] text-[#777777]"
        }`}>
          Connect your wallet to see farm positions.
        </div>
      ) : (
        <Table
          filterDropdownPosition="left"
          heading={{ heading: "Positions Table", tabType: "solid" }}
          filters={{ allChainDropdown: true, filters: [], filterTabType: "solid" }}
          filterTabTypeOptions={filterTabTypeOptions}
          activeFilterTab={activeFilterTab}
          onFilterTabTypeChange={setActiveFilterTab}
          tableHeadings={tableData.headings}
          tableBody={tableData.body}
          onRowClick={activeFilterTab === "position-history" ? undefined : handleRowClick}
        />
      )}
    </div>
  );
};
