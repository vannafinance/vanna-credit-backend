"use client";

import { useParams, useRouter } from "next/navigation";
import { useTheme } from "@/contexts/theme-context";
import Image from "next/image";
import { useMemo, useState } from "react";
import { iconPaths } from "@/lib/constants";
import { AccountStatsGhost } from "@/components/farm/account-stats-ghost";
import { FarmChart } from "@/components/farm/farm-chart";
import { FarmTable } from "@/components/farm/farm-table";
import { Form } from "@/components/farm/form";
import { FarmStatsCard } from "@/components/farm/stats";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import { StatsCard } from "@/components/ui/stats-card";
import { ChevronLeftIcon } from "@/components/icons";
import { useUserStore } from "@/store/user";
import { useFarmPool, useFarmPositions } from "@/lib/farm/use-farm";
import { formatMetric, formatTokenMetric, poolTitle, type FarmPoolConfig } from "@/lib/farm/pools";
import { useMarginHistory } from "@/hooks/use-margin";
import { explorerUrl } from "@/lib/solana/config";
import { formatUsdValue } from "@/lib/utils/format-amount";

const UI_TABS = [
  { id: "all-transactions", label: "All Transactions" },
  { id: "analytics", label: "Analytics" },
];

// Position History columns (same set the Stellar Earn/Farm history tables used).
const historyTableHeadings = [
  { label: "Date", id: "date" },
  { label: "Type", id: "type" },
  { label: "Amount", id: "amount" },
  { label: "Status", id: "status" },
  { label: "Tx Hash", id: "txHash" },
];

const positionHeadings = [
  { label: "Asset", id: "asset" },
  { label: "Protocol", id: "protocol" },
  { label: "Supplied", id: "value" },
  { label: "APY", id: "supply-apy" },
];

/** Header stats strip — Kamino's own main-market figures (null → "—"); nothing is estimated. */
function headerStats(pool: FarmPoolConfig) {
  return [
    { id: "supplyApy", name: "Supply APY", amount: formatMetric(pool.supplyApy, "pct") },
    { id: "borrowApy", name: "Borrow APY", amount: formatMetric(pool.borrowApy, "pct") },
    { id: "utilization", name: "Utilization Rate", amount: formatMetric(pool.utilization, "pct") },
    { id: "totalSupply", name: "Total Pool Supply", amount: formatMetric(pool.totalSupplyUsd, "usd") },
  ];
}

function analyticsItems(pool: FarmPoolConfig) {
  const src = "Kamino main market (mainnet)";
  return [
    { heading: "Supply APY", mainInfo: formatMetric(pool.supplyApy, "pct"), subInfo: "Annual yield on supplied assets", tooltip: src },
    { heading: "Borrow APY", mainInfo: formatMetric(pool.borrowApy, "pct"), subInfo: "Annual cost to borrow on Kamino", tooltip: src },
    { heading: "Utilization", mainInfo: formatMetric(pool.utilization, "pct"), subInfo: "Borrowed / Total Supply", tooltip: src },
    { heading: "Total Supply", mainInfo: formatTokenMetric(pool.totalSupply, pool.symbol), subInfo: formatMetric(pool.totalSupplyUsd, "usd"), tooltip: src },
    { heading: "Total Borrow", mainInfo: formatTokenMetric(pool.totalBorrow, pool.symbol), subInfo: formatMetric(pool.totalBorrowUsd, "usd"), tooltip: src },
  ];
}

export default function FarmDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const router = useRouter();
  const { isDark } = useTheme();

  const [activeUiTab, setActiveUiTab] = useState<string>("all-transactions");
  const [activeTab, setActiveTab] = useState<string>("current-position");

  const userAddress = useUserStore((state) => state.address);
  const { pool, isLoading } = useFarmPool(id);
  const { positions } = useFarmPositions(userAddress);
  const position = pool ? positions.find((p) => p.poolId === pool.id) ?? null : null;

  // Current Position — the margin account's Kamino cTokens for this vault, in underlying terms.
  const currentPositionBody = useMemo(() => {
    if (!pool || !position) return { rows: [] };
    return {
      rows: [
        {
          cell: [
            { chain: pool.symbol, title: pool.symbol, tags: ["Vault"] },
            { title: pool.protocol },
            { title: `${position.underlying.toFixed(4)} ${pool.symbol}`, tag: formatUsdValue(position.liquidityUsd) },
            { title: formatMetric(pool.supplyApy, "pct") },
          ],
        },
      ],
    };
  }, [pool, position]);

  // Position History — this vault's farm-deposit / farm-withdraw events from on-chain history.
  const { rows: marginHistory } = useMarginHistory();
  const historyBody = useMemo(() => {
    if (!pool) return { rows: [] };
    return {
      rows: marginHistory
        .filter((r) => (r.type === "farm-deposit" || r.type === "farm-withdraw") && r.symbol === pool.symbol)
        .map((r) => ({
          cell: [
            { title: new Date(r.timestamp).toLocaleDateString(), description: new Date(r.timestamp).toLocaleTimeString() },
            { title: r.type === "farm-deposit" ? "Supply" : "Withdraw", badge: r.type === "farm-deposit" ? "green" : "orange" },
            { title: `${Number(r.amount).toFixed(4)} ${r.symbol}` },
            { title: "Success", badge: "green" },
            { title: `${r.signature.slice(0, 8)}...${r.signature.slice(-4)}`, clickable: "link", link: explorerUrl("tx", r.signature) },
          ],
        })),
    };
  }, [marginHistory, pool]);

  // Unknown pool → honest state instead of silently falling back to some default pool.
  if (!pool) {
    return (
      <main className="flex flex-col gap-5 px-4 sm:px-10 lg:px-30 pt-4 sm:pt-5 pb-16">
        <nav aria-label="Breadcrumb">
          <button type="button" onClick={() => router.push("/farm")}
            className={`w-fit h-fit flex gap-2 items-center cursor-pointer text-[15px] font-medium hover:text-[#703AE6] transition-colors ${isDark ? "text-white" : "text-[#5A5555]"}`}
          >
            <ChevronLeftIcon />
            Back to pools
          </button>
        </nav>
        <section className={`w-full rounded-2xl border p-8 flex flex-col items-center justify-center gap-2 text-center ${isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"}`}>
          <h1 className={`text-[18px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
            {isLoading ? "Loading pool…" : "Pool not found"}
          </h1>
          {!isLoading && (
            <p className={`text-[13px] font-medium ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
              &ldquo;{id}&rdquo; isn&apos;t a Farm vault.
            </p>
          )}
        </section>
      </main>
    );
  }

  const title = poolTitle(pool);
  const tags = ["Vault", pool.protocol];
  const emptyPositionMessage = "No position in this vault yet";
  const emptyHistoryMessage = "No activity in this vault yet";

  return (
    <main className="flex flex-col gap-5">
      {/* Header */}
      <header className="pt-4 sm:pt-5 px-4 sm:px-10 lg:px-30 w-full">
        <div className="w-full flex flex-col sm:flex-row justify-between gap-4">
          <div className="flex flex-col gap-3">
            <nav aria-label="Breadcrumb">
              <button type="button" onClick={() => router.push("/farm")}
                className={`w-fit h-fit flex gap-2 items-center cursor-pointer text-[15px] font-medium hover:text-[#703AE6] transition-colors ${isDark ? "text-white" : "text-[#5A5555]"}`}
              >
                <ChevronLeftIcon />
                Back to pools
              </button>
            </nav>
            <div className="flex gap-2 items-center">
              <Image src={iconPaths[pool.symbol] ?? "/coins/default.svg"} alt={`${title}-icon`} width={24} height={24} className="w-6 h-6 sm:w-7 sm:h-7 shrink-0 rounded-full" />
              <h1 className={`text-[18px] sm:text-[20px] font-bold shrink-0 ${isDark ? "text-white" : "text-[#181822]"}`}>{title}</h1>
              <div className="flex gap-1 items-center shrink-0">
                {tags.map((tag, i) => (
                  <span key={i} className="text-[10px] sm:text-[12px] font-semibold text-center rounded px-1.5 py-0.5 bg-[#703AE6] text-white">{tag}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="px-4 sm:px-10 lg:px-30" aria-label="Pool Statistics">
        <AccountStatsGhost items={headerStats(pool)} />
      </section>

      {/* Main content */}
      <section className="px-4 sm:px-10 lg:px-30 pt-1 pb-24 xl:pb-16 w-full">
        <div className="flex flex-col xl:flex-row gap-4 w-full">

          {/* Article — left/main content */}
          <article className="flex-1 min-w-0 flex flex-col gap-3">
            <nav className="w-full">
              <AnimatedTabs tabs={UI_TABS} activeTab={activeUiTab} onTabChange={setActiveUiTab} type="border"
                containerClassName={`w-full rounded-xl border p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E5E7EB]"}`}
                tabClassName="!flex-1 !px-2 text-[12px]"
              />
            </nav>
            {activeUiTab === "all-transactions" ? (
              <div className={`w-full flex flex-col gap-6 rounded-2xl border p-4 sm:p-6 ${isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"}`}>
                {/* Current value only — no synthetic time series. */}
                <FarmChart
                  heading="My Vault Position"
                  value={position ? formatUsdValue(position.liquidityUsd) : null}
                  emptyMessage={emptyPositionMessage}
                />
                <FarmTable filterDropdownPosition="right" tableBodyBackground={isDark ? "bg-[#222222]" : "bg-white"}
                  heading={{ heading: "All Transactions", tabsItems: [{ id: "current-position", label: "Current Position" }, { id: "position-history", label: "Position History" }], tabType: "solid" }}
                  activeTab={activeTab} onTabChange={setActiveTab} filters={{ filters: ["All"], customizeDropdown: true }}
                  tableHeadings={activeTab === "current-position" ? positionHeadings : historyTableHeadings}
                  tableBody={activeTab === "current-position" ? currentPositionBody : historyBody}
                  emptyMessage={activeTab === "current-position" ? emptyPositionMessage : emptyHistoryMessage}
                />
              </div>
            ) : (
              <div className={`w-full flex flex-col gap-6 rounded-2xl border p-4 sm:p-6 ${isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"}`}>
                <h2 className={`text-[21px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>Statistics</h2>
                <article className="w-full grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4">
                  {analyticsItems(pool).map((item, idx) => (<StatsCard key={idx} heading={item.heading} mainInfo={item.mainInfo} subInfo={item.subInfo} tooltip={item.tooltip} />))}
                </article>
              </div>
            )}
          </article>

          {/* Aside — right sticky panel */}
          <aside className="w-full xl:w-[420px] shrink-0 flex flex-col gap-3 xl:sticky xl:top-4 xl:self-start">
            <Form pool={pool} />

            {/* Vault stats card — Kamino's figures, with honest "—" when unavailable. */}
            <FarmStatsCard
              items={[
                { heading: "Total Value Locked", value: formatMetric(pool.totalSupplyUsd, "usd") },
                { heading: "Supply APY", value: formatMetric(pool.supplyApy, "pct") },
                { heading: "Your Position", value: position ? formatUsdValue(position.liquidityUsd) : "—" },
                { heading: "Receipt", value: pool.receiptSymbol },
              ]}
            />

            {/* How it works */}
            <div className={`w-full rounded-2xl border p-4 flex flex-col gap-3 ${isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]"}`}>
              <p className={`text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>How it works</p>
              <div className="flex flex-col gap-3">
                {[
                  { step: "1", title: "Choose a vault", desc: "Pick the asset to supply to Kamino" },
                  { step: "2", title: "Deposit and set leverage", desc: "Deposit from your wallet (or use margin balance) and borrow the same asset from Vanna — all in one transaction" },
                  { step: "3", title: "Earn Kamino supply yield", desc: "The cTokens stay in your margin account and count toward its health factor" },
                  { step: "4", title: "Withdraw anytime", desc: "Redeem back into your margin account, then repay or withdraw on the Margin page" },
                ].map((item) => (
                  <div key={item.step} className="flex gap-3 items-start">
                    <div className="w-6 h-6 rounded-full bg-[#703AE6]/10 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[11px] font-bold text-[#703AE6]">{item.step}</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <p className={`text-[12px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>{item.title}</p>
                      <p className={`text-[11px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
