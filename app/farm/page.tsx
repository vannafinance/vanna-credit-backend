"use client";

import { FarmTable } from "@/components/farm/farm-table";
import { AccountStats } from "@/components/farm/account-stats";
import { Carousel } from "@/components/ui/carousel";
import {
  FARM_STATS_ITEMS,
  singleAssetTableHeadings,
  positionsTableHeadings,
} from "@/lib/constants/farm";
import { useUserStore } from "@/store/user";
import { useState, useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useFarmStore, type FarmRowData } from "@/store/farm-store";
import { useFarmPools, useFarmPositions } from "@/lib/farm/use-farm";
import { formatMetric, formatTokenMetric, type FarmPoolConfig } from "@/lib/farm/pools";
import { useMarginHistory } from "@/hooks/use-margin";
import { explorerUrl } from "@/lib/solana/config";
import { isFarmListed } from "@/lib/solana/farm";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { HEALTH_FACTOR_INFINITY_SENTINEL } from "@/lib/margin-health";
import { BASIS_VAULTS, fmtPct, fmtSignedPct, fmtUsdCompact } from "@/lib/farm/basis-vaults";

function fmtUsd(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `$${safe.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type FarmTableRow = FarmRowData & { id: string };

/** Vaults sub-tabs: single-asset Kamino Lend vaults (no LP — Kamino Liquidity rejects CPI) and the
 * delta-neutral basis vaults (UI preview with sample data, see lib/farm/basis-vaults.ts). */
const VAULT_TAB = "lending-single-assets";
const DELTA_NEUTRAL_TAB = "delta-neutral";

/** Delta-neutral table columns. */
const deltaNeutralTableHeadings = [
  { label: "Vault", id: "vault", icon: true },
  { label: "Protocol", id: "protocol", icon: true },
  { label: "TVL / Cap", id: "tvl-cap", icon: true },
  { label: "Vault APY", id: "vault-apy", icon: true },
  { label: "Funding Now", id: "funding-now", icon: true },
  { label: "Earnings", id: "earnings", icon: true },
  { label: "Holding", id: "holding", icon: true },
];

const FARM_STATS_WITH_HF = [
  ...FARM_STATS_ITEMS,
  { id: "netHealthFactor", name: "Net Health Factor", icon: "/margin/health.png", tooltip: "Same number as on Margin. Liquidatable at 1.10 or below." },
];

export default function FarmPage() {
  const [activePositionFilterTab, setActivePositionFilterTab] = useState<string>("current-position");
  const [activeTab, setActiveTab] = useState<string>("vaults");
  const [vaultCategory, setVaultCategory] = useState<string>(VAULT_TAB);
  const deltaNeutral = activeTab === "vaults" && vaultCategory === DELTA_NEUTRAL_TAB;
  // "Back to pools" from a basis vault returns to /farm?category=delta-neutral.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("category") === DELTA_NEUTRAL_TAB) setVaultCategory(DELTA_NEUTRAL_TAB);
  }, []);
  const userAddress = useUserStore((state) => state.address);

  // Pools: Kamino's live main-market metrics. Positions: the margin account's Kamino cTokens.
  const { pools } = useFarmPools();
  const { positions } = useFarmPositions(userAddress);
  const positionByPool = useMemo(() => new Map(positions.map((p) => [p.poolId, p])), [positions]);

  const holdingCell = useCallback(
    (pool: FarmPoolConfig) => {
      const position = positionByPool.get(pool.id);
      return position
        ? { title: `${position.underlying.toFixed(4)} ${pool.symbol}`, tag: fmtUsd(position.liquidityUsd) }
        : { title: `0 ${pool.symbol}`, tag: "$0.00" };
    },
    [positionByPool]
  );

  // Single-asset table. Column order matches singleAssetTableHeadings:
  //   Asset · Protocol · Total Deposits · Total Borrow · Supply APY · Borrow APY · Utilization · Holding
  const singleAssetTableBody = useMemo(() => {
    const rows: FarmTableRow[] = pools.filter((pool) => isFarmListed(pool.symbol)).map((pool) => ({
      id: pool.id,
      cell: [
        { chain: pool.symbol, title: pool.symbol, tags: [pool.protocol, "Supply"] },
        { title: pool.protocol },
        { title: formatTokenMetric(pool.totalSupply, pool.symbol), tag: formatMetric(pool.totalSupplyUsd, "usd") },
        { title: formatTokenMetric(pool.totalBorrow, pool.symbol), tag: formatMetric(pool.totalBorrowUsd, "usd") },
        { title: formatMetric(pool.supplyApy, "pct") },
        { title: formatMetric(pool.borrowApy, "pct") },
        { title: formatMetric(pool.utilization, "pct") },
        holdingCell(pool),
      ],
    }));
    return { rows };
  }, [pools, holdingCell]);

  // Delta-neutral table — sample vault figures; nobody holds shares until the vault program ships.
  const deltaNeutralTableBody = useMemo(() => {
    const rows: FarmTableRow[] = BASIS_VAULTS.map((v) => ({
      id: v.id,
      cell: [
        { icon: v.icon, title: v.name, tags: ["Basis", "1x hedge"] },
        { title: "Jupiter · GMTrade" },
        { title: fmtUsdCompact(v.tvl), tag: v.tvl / v.cap > 0.9 ? "Almost full" : `${Math.round((v.tvl / v.cap) * 100)}% of ${fmtUsdCompact(v.cap)}` },
        { title: fmtPct(v.apy7), tag: `30D ${fmtPct(v.apy30)}` },
        { title: fmtSignedPct(v.fundingNow), tag: v.perp },
        { title: "—" },
        { title: `0 ${v.share}`, tag: "$0.00" },
      ],
    }));
    return { rows };
  }, []);

  // Positions table — the margin account's real Kamino positions.
  const positionsTableBody = useMemo(() => {
    const rows: FarmTableRow[] = [];
    positions.forEach((position) => {
      const pool = pools.find((p) => p.id === position.poolId);
      if (!pool) return;
      rows.push({
        id: pool.id,
        cell: [
          { chain: pool.symbol, title: pool.symbol, tags: [pool.protocol] },
          { title: pool.protocol },
          { title: `${position.underlying.toFixed(4)} ${pool.symbol}`, tag: fmtUsd(position.liquidityUsd) },
          { title: formatMetric(pool.supplyApy, "pct") },
        ],
      });
    });
    return { rows };
  }, [positions, pools]);

  // Position history — farm-deposit / farm-withdraw events decoded from the margin account's
  // on-chain history (never a browser-local log).
  const { rows: marginHistory } = useMarginHistory();
  const historyTableBody = useMemo(() => {
    const rows: FarmTableRow[] = marginHistory
      .filter((r) => r.type === "farm-deposit" || r.type === "farm-withdraw")
      .map((r, i) => ({
        id: r.symbol.toLowerCase() || `history-${i}`,
        cell: [
          { chain: r.symbol, title: r.symbol, tags: [r.type === "farm-deposit" ? "Supply" : "Withdraw"] },
          { title: "Kamino", description: r.timestamp ? new Date(r.timestamp).toLocaleString() : "" },
          { title: `${Number(r.amount).toFixed(4)} ${r.symbol}` },
          { title: `${r.signature.slice(0, 8)}...`, clickable: "link", link: explorerUrl("tx", r.signature) },
        ],
      }));
    return { rows };
  }, [marginHistory]);

  // Header stats — from real positions only. Earnings / net APY / rewards can't be derived
  // honestly without a cost basis per position, so they stay "–" rather than guessed.
  // Net Health Factor is the margin account's own (same as the Margin page).
  const { snapshot } = useAccountSnapshot(userAddress);
  const farmStatsValues = useMemo(() => {
    const totalUsd = positions.reduce((sum, p) => sum + (Number.isFinite(p.liquidityUsd) ? p.liquidityUsd : 0), 0);
    const hf = snapshot?.avgHealthFactor;
    return {
      depositTVL: fmtUsd(totalUsd),
      earnings: null,
      netFarmApy: null,
      pendingRewards: null,
      netHealthFactor: !hf ? "—" : hf >= HEALTH_FACTOR_INFINITY_SENTINEL ? "∞" : hf.toFixed(2),
    };
  }, [positions, snapshot]);

  // Get filter tab type options based on active tab
  const filterTabTypeOptions = useMemo(() => {
    if (activeTab === "positions") {
      return [
        { id: "current-position", label: "Current Position" },
        { id: "position-history", label: "Position History" }
      ];
    }
    return [
      { id: VAULT_TAB, label: "Lending/Single Assets" },
      { id: DELTA_NEUTRAL_TAB, label: "Delta-Neutral" },
    ];
  }, [activeTab]);

  const currentActiveFilterTab = useMemo(() => {
    if (activeTab === "positions") return activePositionFilterTab;
    return vaultCategory;
  }, [activeTab, activePositionFilterTab, vaultCategory]);

  const handleFilterTabChange = useCallback((tabId: string) => {
    if (activeTab === "positions") setActivePositionFilterTab(tabId);
    else setVaultCategory(tabId);
  }, [activeTab]);

  const router = useRouter();
  const setFarmData = useFarmStore((state) => state.set);

  const handleRowClick = useCallback((row: FarmTableRow, rowIndex: number) => {
    const rowId = row.id || `row-${rowIndex}`;
    if (deltaNeutral) {
      router.push(`/farm/basis/${rowId}`);
      return;
    }
    setFarmData({ selectedRow: row, tabType: "single" });
    router.push(`/farm/${rowId}`);
  }, [router, setFarmData, deltaNeutral]);

  const tableData = useMemo(() => {
    if (activeTab === "positions") {
      const history = activePositionFilterTab === "position-history";
      return {
        headings: positionsTableHeadings,
        body: history ? historyTableBody : positionsTableBody,
        emptyMessage: history ? "No farm activity yet" : "No farm positions yet",
      };
    }
    if (deltaNeutral) return { headings: deltaNeutralTableHeadings, body: deltaNeutralTableBody, emptyMessage: "No vaults available" };
    return { headings: singleAssetTableHeadings, body: singleAssetTableBody, emptyMessage: "No vaults available" };
  }, [activeTab, activePositionFilterTab, deltaNeutral, singleAssetTableBody, deltaNeutralTableBody, positionsTableBody, historyTableBody]);

  const deltaNeutralCarouselItems = [
    {
      icon: "",
      title: "Delta-neutral Vaults",
      description:
        "Deposit from your margin account. Each vault buys spot on Jupiter and holds an equal 1x short on GMTrade, and earns the funding.",
    },
    {
      icon: "",
      title: "Earn Funding, Not Direction",
      description: "Long spot and short perp cancel out the price move; the vault keeps the funding shorts are paid.",
    },
    {
      icon: "",
      title: "Coming Soon",
      description: "Vault figures shown are a preview with sample data. Deposits open when the vault program ships.",
    },
  ];
  const farmCarouselItems = [
    {
      icon: "",
      title: "Farm DeFi Yields",
      description:
        "Supply SOL, USDC and USDT to Kamino straight from your margin account and earn Kamino's supply yield.",
    },
    {
      icon: "",
      title: "Single-Asset Kamino Vaults",
      description:
        "Deposit or borrow on the Margin page, then supply your margin balance to Kamino in one click.",
    },
    {
      icon: "",
      title: "Powered by Vanna Protocol",
      description:
        "Kamino cTokens stay in your Vanna margin account and count toward its health factor.",
    },
  ];

  return (
    <main className="w-full px-4 sm:px-10 lg:px-30 pb-8 lg:pb-0">
      {/* Carousel */}
      <section className="w-full pt-4 sm:pt-6 pb-4">
        <Carousel key={deltaNeutral ? "dn" : "lend"} items={deltaNeutral ? deltaNeutralCarouselItems : farmCarouselItems} autoplayInterval={5000} />
      </section>

      {/* Farm stats — only shown when wallet connected */}
      {userAddress && FARM_STATS_ITEMS.length > 0 && (
        <section className="w-full mb-6">
          <AccountStats
            items={FARM_STATS_WITH_HF}
            values={farmStatsValues}
            gridCols="grid-cols-4"
          />
        </section>
      )}

      {/* Pool Table */}
      <section className="w-full pb-8">
      <FarmTable
        paginate={false}
        filterDropdownPosition="left"
        heading={{
          tabsItems: [
            { label: "Vaults", id: "vaults" },
            { label: "Positions", id: "positions" }
          ],
          tabType: "underline"
        }}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        filters={{
          allChainDropdown: true,
          filters: activeTab === "positions"
            ? []
            : ["Vaults"],
          supplyApyTab: activeTab === "positions" ? false : true,
          supplyApyLabel: deltaNeutral ? "Vault APY" : "Total Borrow",
          filterTabType: activeTab === "positions" ? "solid" : "ghost"
        }}
        filterTabTypeOptions={filterTabTypeOptions}
        activeFilterTab={currentActiveFilterTab}
        onFilterTabTypeChange={handleFilterTabChange}
        tableHeadings={tableData.headings}
        tableBody={tableData.body}
        onRowClick={handleRowClick}
        emptyMessage={tableData.emptyMessage}
      />
      </section>
    </main>
  );
}
