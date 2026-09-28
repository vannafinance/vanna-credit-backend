"use client";

import { useMemo, useState } from "react";
import { Table } from "@/components/earn/table";
import { transactionTableHeadings } from "@/components/earn/acitivity-tab";
import { useTheme } from "@/contexts/theme-context";
import { spotBalancesTableHeadings } from "@/lib/constants/farm";
import { useUserStore } from "@/store/user";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { useMarginHistory } from "@/hooks/use-margin";
import { explorerUrl } from "@/lib/solana/config";
import { findToken } from "@/lib/solana/tokens";

const SPOT_TABS = [
  { id: "balances", label: "Spot Balances" },
  { id: "history", label: "Spot History" },
];

const POSITION_DUST = 1e-6;

const fmtUsd = (n: number): string =>
  `$${(n < 0 ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Portfolio "Spot" tab — the margin account's plain token balances (deposited, borrowed or
 * swapped in via Jupiter), valued with the on-chain Pyth prices the health factor uses. Kamino
 * cTokens are farm positions and live under the Farm tab. Spot History = the margin account's
 * Jupiter swaps (`margin_execute`), decoded from on-chain events.
 */
export const SpotSection = () => {
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState("balances");
  const userAddress = useUserStore((s) => s.address);
  const { snapshot } = useAccountSnapshot(userAddress);
  const { rows: marginHistory, isLoading: historyLoading } = useMarginHistory();

  const rows = useMemo(() => {
    const collateral = snapshot?.collateralBalances ?? {};
    return Object.entries(collateral)
      .filter(([symbol, bal]) => findToken(symbol) && (parseFloat(bal.amount) || 0) > POSITION_DUST)
      .map(([symbol, bal]) => {
        const amount = parseFloat(bal.amount) || 0;
        const usd = parseFloat(bal.usdValue) || 0;
        return {
          cell: [
            { chain: symbol, title: symbol },
            { title: "Margin Account" },
            { title: `${amount.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}` },
            { title: fmtUsd(usd) },
          ],
          usd,
        };
      });
  }, [snapshot?.collateralBalances]);

  const totalSpotUsd = rows.reduce((s, r) => s + r.usd, 0);

  const historyEntries = useMemo(() => marginHistory.filter((r) => r.type === "swap"), [marginHistory]);
  const historyTableBody = useMemo(
    () => ({
      rows: historyEntries.map((ev) => ({
        cell: [
          {
            title: ev.timestamp ? new Date(ev.timestamp).toLocaleDateString() : "—",
            description: ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : "",
          },
          { title: "Swap", badge: "green" },
          {
            title: `${(parseFloat(ev.amount) || 0).toFixed(4)} ${ev.symbol} to ${(parseFloat(ev.toAmount ?? "0") || 0).toFixed(4)} ${ev.toSymbol ?? ""}`,
            description: "Jupiter",
          },
          { title: "Success", badge: "green" },
          {
            title: `${ev.signature.slice(0, 8)}...${ev.signature.slice(-4)}`,
            clickable: "link",
            link: explorerUrl("tx", ev.signature),
          },
        ],
      })),
    }),
    [historyEntries],
  );
  const historyFetching = false;

  const isHistoryTab = activeTab === "history";

  const tableData = useMemo(() => {
    if (isHistoryTab) {
      return { headings: transactionTableHeadings, body: historyTableBody };
    }
    return {
      headings: spotBalancesTableHeadings,
      body: { rows: rows.map(({ cell }) => ({ cell })) },
    };
  }, [isHistoryTab, historyTableBody, rows]);

  return (
    <div className="w-full h-fit flex flex-col gap-[16px]">
      <div className={`w-full rounded-[16px] overflow-hidden border ${
        isDark ? "border-[#2D2D2D] bg-[#222222]" : "border-[#E8E8E8] bg-[#f7f7f7]"
      }`}>
        <div className="flex flex-col gap-2 px-5 py-4">
          <span className={`text-[13px] font-medium ${isDark ? "text-[#A0A0A0]" : "text-[#777777]"}`}>
            Total Spot Balance
          </span>
          <span className={`text-[20px] font-bold ${isDark ? "text-white" : "text-[#111]"}`}>
            {fmtUsd(totalSpotUsd)}
          </span>
        </div>
      </div>

      {!userAddress ? (
        <div className={`w-full rounded-[16px] border px-5 py-10 text-center text-[14px] font-medium ${
          isDark ? "bg-[#222222] border-[#2A2A2A] text-[#777777]" : "bg-[#F7F7F7] border-[#E8E8E8] text-[#777777]"
        }`}>
          Connect your wallet to see spot balances.
        </div>
      ) : (
        // Rendered whenever a wallet is connected, even with zero current spot
        // balances — Spot History can still have entries (e.g. swapped back
        // out already), and the Table component's own empty state covers the
        // genuinely-empty case for both tabs.
        <>
          {isHistoryTab && historyLoading && historyEntries.length === 0 && (
            <div className={`text-[12px] px-1 ${isDark ? "text-[#A0A0A0]" : "text-[#777]"}`}>
              Loading spot history…
            </div>
          )}
          {isHistoryTab && !historyLoading && historyFetching && historyEntries.length > 0 && (
            <div className={`text-[11px] px-1 ${isDark ? "text-[#666]" : "text-[#999]"}`}>
              Refreshing history…
            </div>
          )}
          <Table
            filterDropdownPosition="left"
            heading={{ tabsItems: SPOT_TABS, tabType: "solid" }}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            filters={{ allChainDropdown: false, filters: [], filterTabType: "solid" }}
            tableHeadings={tableData.headings}
            tableBody={tableData.body}
          />
        </>
      )}
    </div>
  );
};
