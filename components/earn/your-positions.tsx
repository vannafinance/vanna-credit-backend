'use client';

/**
 * "Your Positions" panel for the selected earn pool. Shows a my-supply value
 * chart built from the wallet's real on-chain supply/redeem events, plus tabbed
 * Current Position / Position History tables. Falls back to an illustrated empty
 * state when there's neither an active position nor any history.
 *
 * The supply chart accumulates a running USD balance from per-day signed
 * deltas (supply +, withdraw −), then overrides the final point with the live
 * current value so the tip always matches the on-chain balance. It is only
 * reconstructed when the event history provably covers the whole position
 * (computeEarnedInterest could prove the cost basis); otherwise just the live
 * value is drawn. A dust threshold distinguishes a real position from
 * share-rounding residue left after a full withdrawal.
 */
import { useState, useMemo, memo } from "react";
import { Chart } from "./chart";
import { Table } from "./table";
import { useTheme } from "@/contexts/theme-context";
import { usePoolData, useUserPositions, useEarnTransactions } from "@/hooks/use-earn";
import { useSelectedPoolStore } from "@/store/selected-pool-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { formatTokenAmount, formatUsdValue } from "@/lib/utils/format-amount";
import { explorerUrl } from "@/lib/solana/config";
import { TOKENS, tokenIcon } from "@/lib/solana/tokens";
import { POSITION_DUST, fmtUsd, resolveToken } from "./earn-utils";

const tabs = [
  { id: "current-positions", label: "Current Position" },
  { id: "positions-history", label: "Position History" },
];

const toIsoDate = (timestamp: number): string => {
  return new Date(timestamp).toISOString().split("T")[0];
};

/** Memoized positions panel backed by live balances and on-chain history. */
export const YourPositions = memo(function YourPositions() {
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState<string>("current-positions");
  const [chartNow] = useState<number>(() => Date.now());

  const selectedAsset = useSelectedPoolStore((state) => state.selectedAsset);
  const token = resolveToken(selectedAsset) ?? TOKENS[0];
  const asset = token.symbol;

  const { pools } = usePoolData();
  const { positions } = useUserPositions();
  const { transactions, earned } = useEarnTransactions();

  const supplyAPY = (pools[asset]?.supplyApr ?? 0) * 100;

  const userPosition = positions[asset];
  const deposited = userPosition?.assets ?? 0;
  // Dust threshold: share-rounding residue left after a 100% withdrawal is not a real position.
  const hasPosition = deposited > POSITION_DUST;

  const tokenPrices = useTokenPrices([asset]);
  const price = tokenPrices[asset] ?? 0;
  const vTokenBalance = userPosition?.shares ?? 0;
  // Earned interest for this asset: null (→ "—") when the history can't prove the cost basis.
  const earnedEntry = earned?.[asset];
  const earnedTokens = earnedEntry ? earnedEntry.earned : null;

  const positionTableHeadings = [
    { label: "Pool", id: "pool" },
    { label: "Vault Shares", id: "shares" },
    { label: `${asset} Supplied`, id: "deposited" },
    { label: "USD Value", id: "usd-value" },
    { label: "APY", id: "apy" },
    { label: "Interest Earned", id: "earned" },
  ];

  const positionTableBody = hasPosition
    ? {
        rows: [
          {
            cell: [
              {
                icon: tokenIcon(asset),
                title: asset,
                tags: ["Vanna", "Vault"],
              },
              { title: `${formatTokenAmount(vTokenBalance)} v${asset}` },
              { title: `${formatTokenAmount(deposited)} ${asset}` },
              { title: price > 0 ? formatUsdValue(deposited * price) : "—" },
              { title: `${supplyAPY.toFixed(2)}%` },
              earnedTokens === null
                ? { title: "—", description: earnedEntry?.reason ?? "Reading history…" }
                : {
                    title: `${formatTokenAmount(Math.max(0, earnedTokens))} ${asset}`,
                    description: price > 0 ? fmtUsd(Math.max(0, earnedTokens) * price) : undefined,
                  },
            ],
          },
        ],
      }
    : { rows: [] };

  const historyTableHeadings = [
    { label: "Date", id: "date" },
    { label: "Type", id: "type" },
    { label: "Amount", id: "amount" },
    { label: "Status", id: "status" },
    { label: "Tx Hash", id: "txHash" },
  ];

  // Decoded LiquiditySupplied / LiquidityRedeemed events for this asset, newest first. Only
  // confirmed, successful transactions are indexed, so every row is "Success".
  const mergedHistory = useMemo(() => {
    return (transactions ?? [])
      .filter((tx) => tx.symbol === asset)
      .map((tx) => ({
        timestamp: tx.timestamp,
        type: tx.type,
        amount: tx.amount,
        hash: tx.signature,
        status: "success",
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [transactions, asset]);

  // Build chart from real user transactions so tooltip dates match actual activity. The
  // running principal is only trustworthy when the history covers the whole position
  // (earned cost basis proven); otherwise draw just the live value.
  const historyCoversPosition = earnedEntry ? earnedEntry.netDeposited !== null : false;
  const mySupplyChartData = useMemo(() => {
    if (!(price > 0)) return [];
    const currentUsdValue = parseFloat((deposited * price).toFixed(2));
    const txsAsc = historyCoversPosition
      ? [...mergedHistory].filter((tx) => tx.timestamp > 0).sort((a, b) => a.timestamp - b.timestamp)
      : [];

    if (txsAsc.length === 0) {
      if (currentUsdValue <= 0) return [];
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      return [
        { date: toIsoDate(yesterday.getTime()), amount: currentUsdValue },
        { date: toIsoDate(today.getTime()), amount: currentUsdValue },
      ];
    }

    const dayDeltaMap = new Map<string, number>();
    txsAsc.forEach((tx) => {
      const date = toIsoDate(tx.timestamp);
      const amountUsd = (parseFloat(tx.amount || "0") || 0) * price;
      const signedDelta = tx.type === "withdraw" ? -amountUsd : amountUsd;
      dayDeltaMap.set(date, (dayDeltaMap.get(date) ?? 0) + signedDelta);
    });

    const points: Array<{ date: string; amount: number }> = [];
    let running = 0;
    Array.from(dayDeltaMap.keys()).sort().forEach((date) => {
      running = Math.max(0, running + (dayDeltaMap.get(date) ?? 0));
      points.push({ date, amount: parseFloat(running.toFixed(2)) });
    });

    const todayIso = toIsoDate(chartNow);
    const hasToday = points.length > 0 && points[points.length - 1].date === todayIso;
    if (hasToday) {
      points[points.length - 1] = { date: todayIso, amount: currentUsdValue };
    } else {
      points.push({ date: todayIso, amount: currentUsdValue });
    }

    if (points.length < 2) {
      const firstDate = new Date(points[0]?.date ?? todayIso);
      firstDate.setDate(firstDate.getDate() - 1);
      points.unshift({ date: toIsoDate(firstDate.getTime()), amount: 0 });
    }

    return points;
  }, [mergedHistory, deposited, price, chartNow, historyCoversPosition]);

  const historyTableBody = useMemo(() => {
    if (mergedHistory.length === 0) return { rows: [] };
    return {
      rows: mergedHistory.map((tx) => ({
        cell: [
          {
            title: tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : "—",
            description: tx.timestamp ? new Date(tx.timestamp).toLocaleTimeString() : "",
          },
          {
            title: tx.type === "supply" ? "Supply" : "Withdraw",
            badge: tx.type === "supply" ? "green" : "orange",
          },
          {
            icon: tokenIcon(asset),
            title: `${formatTokenAmount(parseFloat(tx.amount) || 0)} ${asset}`,
            description: price > 0 ? fmtUsd((parseFloat(tx.amount) || 0) * price) : "",
          },
          { title: "Success", badge: "green" },
          tx.hash
            ? {
                title: `${tx.hash.slice(0, 8)}...${tx.hash.slice(-4)}`,
                clickable: "link",
                link: explorerUrl("tx", tx.hash),
              }
            : { title: "—" },
        ],
      })),
    };
  }, [mergedHistory, asset, price]);

  const hasAnyHistory = mergedHistory.length > 0;

  return (
    <section
      className={`w-full h-full flex flex-col gap-[16px] rounded-[16px] border-[1px] p-[16px] ${
        isDark ? "bg-[#111111]" : "bg-[#F7F7F7]"
      }`}
      aria-label="Your Positions Overview"
    >
      {/* Supply chart — shows user's deposit value over time */}
      <figure className="w-full">
        <Chart
          type="my-supply"
          currencyTab={true}
          height={320}
          containerWidth="w-full"
          customData={mySupplyChartData}
        />
      </figure>

      {/* Position table or empty state */}
      <article aria-label="My Position">
        {!hasPosition && !hasAnyHistory ? (
          <div className={`w-full rounded-2xl border p-6 flex flex-col items-center justify-center gap-4 text-center ${
            isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]"
          }`}>
            <div className={`w-14 h-14 rounded-full flex items-center justify-center ${
              isDark ? "bg-[#2A2A2A]" : "bg-[#F4F0FD]"
            }`}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="#703AE6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 17l10 5 10-5" stroke="#703AE6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 12l10 5 10-5" stroke="#703AE6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div className="flex flex-col gap-1">
              <p className={`text-[15px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                No active position
              </p>
              <p className={`text-[13px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
                Supply liquidity to start earning {asset} interest
              </p>
            </div>
            <div className={`w-full rounded-xl p-4 flex items-center justify-between ${
              isDark ? "bg-[#222222]" : "bg-[#F7F4FE]"
            }`}>
              <div className="flex flex-col gap-0.5 text-left">
                <span className={`text-[11px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>Current Supply APY</span>
                <span className="text-[20px] font-bold text-[#703AE6]">
                  {supplyAPY.toFixed(2)}%
                </span>
              </div>
              <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
                isDark ? "bg-[#2A2A2A]" : "bg-white"
              }`}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="#703AE6" strokeWidth="1.8"/>
                  <path d="M12 6v6l4 2" stroke="#703AE6" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
                <span className={`text-[12px] font-semibold ${isDark ? "text-[#A7A7A7]" : "text-[#555555]"}`}>
                  Accrues every second
                </span>
              </div>
            </div>
          </div>
        ) : (
          <Table
            filterDropdownPosition="right"
            heading={{
              heading: "My Position",
              tabsItems: tabs,
              tabType: "solid",
            }}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            tableHeadings={activeTab === "current-positions" ? positionTableHeadings : historyTableHeadings}
            tableBody={activeTab === "current-positions" ? positionTableBody : historyTableBody}
            tableBodyBackground={isDark ? "bg-[#111111]" : "bg-white"}
            filters={{ customizeDropdown: true }}
          />
        )}
      </article>
    </section>
  );
});
