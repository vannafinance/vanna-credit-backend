"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { CollapsibleChart } from "@/components/ui/collapsible-chart";
import { Table } from "@/components/earn/table";
import { Carousel } from "@/components/ui/carousel";
import { vaultsTableHeadings, positionsTableHeadings } from "@/lib/constants/earn";
import { useUserStore } from "@/store/user";
import { useEarnVaultStore } from "@/store/earn-vault-store";
import { setSelectedPool } from "@/store/selected-pool-store";
import { usePoolData, useUserPositions, useEarnTransactions } from "@/hooks/use-earn";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useTheme } from "@/contexts/theme-context";
import { TOKENS, TOKEN_SYMBOLS, findToken, LENDING_TOKENS } from "@/lib/solana/tokens";
import type { SerializedPoolState } from "@/lib/solana/protocol-state";
import { POSITION_DUST, fmtUsd, sumEarnedUsd } from "@/components/earn/earn-utils";

// Chart data is derived entirely from the wallet's on-chain event history
// (lender_supply / lender_redeem events decoded by useEarnTransactions) plus
// current live state — never from browser storage. Clearing the browser's
// cache must not change what's shown here; the chain is the only source of truth.
const toChartPoints = (
  points: Array<{ timestamp: number; amount: number }>
): Array<{ date: string; amount: number }> => {
  if (points.length === 0) return [];
  const decimals = 2;
  const mapped = points
    .map((item) => ({
      date: new Date(item.timestamp).toISOString(),
      amount: parseFloat((item.amount || 0).toFixed(decimals)),
    }))
    .filter((item) => Number.isFinite(item.amount));

  if (mapped.length >= 2) return mapped;

  // A single real data point can't draw a line — duplicate it 60s earlier
  // so the chart renders a flat line at the true current value instead of
  // an empty state.
  const only = mapped[0];
  const prevTs = Math.max(points[0].timestamp - 60_000, points[0].timestamp - 1);
  return [
    { date: new Date(prevTs).toISOString(), amount: only.amount },
    only,
  ];
};

// Format a raw token amount into a compact human-readable string (e.g. 1250000 → "1.3M")
const formatTokenAmount = (amount: number): string => {
  if (amount <= 0) return "0";
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(2)}K`;
  if (amount < 0.01) return amount.toFixed(6).replace(/\.?0+$/, "");
  return amount.toFixed(2);
};

/** "$x" for a known price, "—" when the oracle has no price for the asset (never a made-up $1). */
const usdOrDash = (amount: number, price: number): string => (price > 0 ? fmtUsd(amount * price) : "—");

// Build a single pool table row from live on-chain pool stats (lib/solana/protocol-state
// via GET /api/pools). APYs are the program's own rate curve evaluated at the current
// utilization (labelled APY, as the Stellar UI did).
const buildPoolRow = (
  assetSymbol: string,
  pool: SerializedPoolState | undefined,
  price: number,
  // How much of THIS specific pool's asset the connected wallet has supplied
  // — 0 when they have no position here. Rendered the same two-line way as
  // "Assets Supplied" (amount on top, $ value below) so "Your Supply" reads
  // consistently instead of collapsing to a bare icon or dash.
  yourSupplyAmount: number | null
) => {
  if (!pool?.initialised) {
    return {
      cell: [
        { chain: assetSymbol, title: assetSymbol, tag: "Not initialised" },
        { title: "—", tag: "—" },
        { title: "—", tag: "—" },
        { title: "—", tag: "—" },
        { title: "—", tag: "—" },
        { title: "—", tag: "—" },
        { title: "—", tag: "—" },
      ],
    };
  }
  const supplyAPY = pool.supplyApr * 100;
  const borrowAPY = pool.borrowApr * 100;
  const utilizationRate = pool.utilization * 100;

  return {
    cell: [
      { chain: assetSymbol, title: assetSymbol, tag: pool.status },
      {
        title: `${formatTokenAmount(pool.totalSupplied)} ${assetSymbol}`,
        tag: usdOrDash(pool.totalSupplied, price),
      },
      {
        title: `${supplyAPY.toFixed(2)}%`,
        tag: `${supplyAPY.toFixed(2)}%`,
      },
      {
        title: `${formatTokenAmount(pool.totalBorrowed)} ${assetSymbol}`,
        tag: usdOrDash(pool.totalBorrowed, price),
      },
      {
        title: `${borrowAPY.toFixed(2)}%`,
        tag: `${borrowAPY.toFixed(2)}%`,
      },
      {
        title: `${utilizationRate.toFixed(2)}%`,
        tag: `${utilizationRate.toFixed(2)}%`,
      },
      yourSupplyAmount === null
        ? { title: "—", tag: "Connect wallet" }
        : {
            title: `${formatTokenAmount(yourSupplyAmount)} ${assetSymbol}`,
            tag: usdOrDash(yourSupplyAmount, price),
          },
    ],
  };
};

// Build a positions row showing user's supplied amount for an asset. No
// "Assets Borrowed" column here — this table is already scoped to the user's
// own supplied positions, so a pool-wide borrow figure doesn't apply.
const buildPositionRow = (
  assetSymbol: string,
  supplied: number,
  pool: SerializedPoolState | undefined,
  price: number
) => {
  const supplyAPY = (pool?.supplyApr ?? 0) * 100;
  const borrowAPY = (pool?.borrowApr ?? 0) * 100;
  const utilizationRate = (pool?.utilization ?? 0) * 100;

  return {
    cell: [
      { chain: assetSymbol, title: assetSymbol, tag: pool?.status ?? "Active" },
      {
        title: `${formatTokenAmount(supplied)} ${assetSymbol}`,
        tag: usdOrDash(supplied, price),
      },
      {
        title: `${supplyAPY.toFixed(2)}%`,
        tag: `${supplyAPY.toFixed(2)}%`,
      },
      {
        title: `${borrowAPY.toFixed(2)}%`,
        tag: `${borrowAPY.toFixed(2)}%`,
      },
      {
        title: `${utilizationRate.toFixed(2)}%`,
        tag: `${utilizationRate.toFixed(2)}%`,
      },
    ],
  };
};

type VaultTableCell = {
  chain?: string;
  title?: string;
  tag?: string;
  onlyIcons?: string[];
};

export default function Earn() {
  const userAddress = useUserStore((state) => state.address);
  const setSelectedVault = useEarnVaultStore((state) => state.set);
  const router = useRouter();
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState("vaults");

  // Live data from the chain (revalidated on every throttled slot tick)
  const { pools } = usePoolData();
  const { positions: userPositions } = useUserPositions();
  const { transactions: earnTx, history: earnHistory, earned, isLoading: earnTxLoading } = useEarnTransactions();
  const tokenPrices = useTokenPrices([...TOKEN_SYMBOLS]);

  // Set default pool selection on mount
  useEffect(() => {
    const first = TOKENS[0].symbol;
    setSelectedPool(first, { id: first, chain: first, title: first, tag: "Active" });
  }, []);

  // Deep-link into the Positions tab (e.g. from Portfolio's Lender "Current
  // Positions" row) via /earn?tab=positions. Read directly off the URL
  // instead of next/navigation's useSearchParams so this doesn't force a
  // Suspense boundary on an otherwise fully client-rendered page.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab === "positions") queueMicrotask(() => setActiveTab("positions"));
  }, []);

  /** Current supplied value per registry symbol (UI units), dust filtered. */
  const suppliedBySymbol = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of TOKENS) {
      const amt = userPositions[t.symbol]?.assets ?? 0;
      out[t.symbol] = amt > POSITION_DUST ? amt : 0;
    }
    return out;
  }, [userPositions]);

  const totalDepositedUSD = useMemo(
    () => TOKENS.reduce((sum, t) => sum + suppliedBySymbol[t.symbol] * (tokenPrices[t.symbol] ?? 0), 0),
    [suppliedBySymbol, tokenPrices],
  );
  // True when a supplied asset has no oracle price, so the USD total can't include it.
  const depositTotalMissingPrice = TOKENS.some((t) => suppliedBySymbol[t.symbol] > 0 && !(tokenPrices[t.symbol] > 0));

  // Net earnings = current share value − net principal (Σ supplied − Σ redeemed, both in real
  // underlying units from the lender_supply / lender_redeem events). computeEarnedInterest
  // returns null — never 0 — for an asset whose cost basis the history can't prove (a previous
  // Stellar bug defaulted missing history to 0 and showed 100% of the deposit as yield);
  // sumEarnedUsd keeps those out of the total and flags the total as partial.
  const earnedSummary = useMemo(() => sumEarnedUsd(earned, tokenPrices), [earned, tokenPrices]);

  // Overall Deposit history: replay the wallet's real supply/withdraw events
  // chronologically to get genuine historical principal, priced at TODAY's
  // oracle prices (same simplification the headline figure uses, so the chart's
  // last point always matches it). Only replayed when the scan reached the
  // wallet's oldest signature — otherwise the starting principal is unknown and
  // the curve would be wrong, so just the live value is drawn.
  const liveDepositData = useMemo(() => {
    if (earnTxLoading || earnTx.length === 0 || !earnHistory?.complete) {
      return toChartPoints([{ timestamp: Date.now(), amount: totalDepositedUSD }]);
    }

    const sorted = [...earnTx].sort((a, b) => a.timestamp - b.timestamp);
    const running: Record<string, number> = {};
    const points = sorted.map((tx) => {
      const amt = parseFloat(tx.amount) || 0;
      running[tx.symbol] = (running[tx.symbol] ?? 0) + (tx.type === "supply" ? amt : -amt);
      let usd = 0;
      TOKENS.forEach((t) => {
        usd += Math.max(0, running[t.symbol] ?? 0) * (tokenPrices[t.symbol] ?? 0);
      });
      return { timestamp: tx.timestamp, amount: usd };
    });

    // Final point: the live headline total (includes accrued yield beyond
    // raw principal), so the chart never disagrees with the stat above it.
    points.push({ timestamp: Date.now(), amount: totalDepositedUSD });
    return toChartPoints(points);
  }, [earnTx, earnHistory, earnTxLoading, tokenPrices, totalDepositedUSD]);

  // Net Earnings has no cheap, honest historical reconstruction (it needs
  // each pool's exchange rate at every past moment, which we don't record) —
  // rather than fabricate a curve, show the one real, correctly-computed
  // number as a flat line at its true current value.
  const liveEarnedYieldData = useMemo(
    () => (earnedSummary.usd === null ? [] : toChartPoints([{ timestamp: Date.now(), amount: earnedSummary.usd }])),
    [earnedSummary.usd]
  );

  // ─── Vaults Table ────────────────────────────────────────────────────────────
  // One row per Earn pool the app offers (lendable registry tokens: SOL, USDC, USDT), from live
  // pool-level Reserve state. Positions below still list every token, so an existing position in
  // a pool the app no longer offers stays visible (its detail page is withdraw-only).
  const liveVaultsTableBody = useMemo(() => ({
    rows: LENDING_TOKENS.map((t) =>
      buildPoolRow(t.symbol, pools[t.symbol], tokenPrices[t.symbol] ?? 0, userAddress ? suppliedBySymbol[t.symbol] : null),
    ),
  }), [pools, suppliedBySymbol, tokenPrices, userAddress]);

  // ─── Positions Table ─────────────────────────────────────────────────────────
  // Shows only the assets where the user has a meaningful (non-dust) supply.
  const livePositionsTableBody = useMemo(() => {
    if (!userAddress) return { rows: [] };
    const rows = TOKENS
      .filter((t) => suppliedBySymbol[t.symbol] > 0)
      .map((t) => buildPositionRow(t.symbol, suppliedBySymbol[t.symbol], pools[t.symbol], tokenPrices[t.symbol] ?? 0));
    return { rows };
  }, [userAddress, suppliedBySymbol, pools, tokenPrices]);

  // Tab-based table data
  const getTableDataForTab = (tabId: string) => {
    if (tabId === "vaults") return liveVaultsTableBody;
    if (tabId === "positions") return livePositionsTableBody;
    return { rows: [] };
  };

  // ─── Row Click Handler ────────────────────────────────────────────────────────
  // Looks up cells by column id (rather than a fixed numeric index) since the
  // Vaults and Positions tabs render different heading sets (e.g. Positions
  // has no "Assets Borrowed" column) — a fixed index would silently read the
  // wrong cell depending on which tab was active when the row was clicked.
  const handleRowClick = useCallback(
    (row: { cell?: VaultTableCell[] }) => {
      const cells = row.cell ?? [];
      const token = findToken(cells[0]?.title ?? "");
      if (!token) return;
      const headings = activeTab === "positions" ? positionsTableHeadings : vaultsTableHeadings;
      const cellFor = (headingId: string): VaultTableCell | undefined => {
        const idx = headings.findIndex((h) => h.id === headingId);
        return idx === -1 ? undefined : cells[idx];
      };

      setSelectedPool(token.symbol, {
        id: token.symbol,
        chain: token.symbol,
        title: token.symbol,
        tag: cells[0]?.tag || "Active",
      });

      const vaultData = {
        id: token.symbol,
        chain: token.symbol,
        title: token.symbol,
        tag: cells[0]?.tag ?? "Active",
        assetsSupplied: { title: cellFor("assets-supplied")?.title || "", tag: cellFor("assets-supplied")?.tag || "" },
        supplyApy: { title: cellFor("supply-apy")?.title || "", tag: cellFor("supply-apy")?.tag || "" },
        assetsBorrowed: { title: cellFor("assets-borrowed")?.title || "", tag: cellFor("assets-borrowed")?.tag || "" },
        borrowApy: { title: cellFor("borrow-apy")?.title || "", tag: cellFor("borrow-apy")?.tag || "" },
        utilizationRate: { title: cellFor("utilization-rate")?.title || "", tag: cellFor("utilization-rate")?.tag || "" },
      };

      setSelectedVault({ selectedVault: vaultData });
      router.push(`/earn/${token.symbol}`);
    },
    [router, setSelectedVault, activeTab]
  );

  const earnCarouselItems = [
    {
      icon: "",
      title: "Earn Yield on Your Assets",
      description:
        "Supply liquidity to Vanna vaults and earn yield from margin borrowers. No lockups — withdraw anytime while liquidity is available.",
    },
    {
      icon: "",
      title: "Multi-Collateral Vaults",
      description:
        "Deposit multiple assets as collateral and borrow against them. Diversify risk while maximizing capital efficiency.",
    },
    {
      icon: "",
      title: "Transparent & On-Chain",
      description:
        "Every rate, balance and position shown here is read directly from the Vanna lending program on Solana.",
    },
  ];

  const netEarningsStat =
    earnedSummary.usd === null
      ? "—"
      : `$${earnedSummary.usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${earnedSummary.partial ? " (partial)" : ""}`;

  const noteClass = `text-[11px] font-medium px-1 pt-1 ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`;

  return (
    <main className="w-full px-4 sm:px-10 lg:px-30 pb-8 lg:pb-0">
      {/* Promotional Carousel */}
      <section className="w-full pt-4 sm:pt-6 pb-4">
        <Carousel items={earnCarouselItems} autoplayInterval={5000} />
      </section>

      {/* Stats with expandable charts — below carousel, side by side */}
      {userAddress && (
        <section className="w-full pb-4 flex flex-col lg:flex-row gap-3" aria-label="Protocol Dashboard">
          <article className="flex-1 min-w-0">
            <CollapsibleChart
              label="Overall Deposit"
              // Headline reads the LIVE total (same source as the Positions
              // table) so it updates instantly on deposit/withdraw.
              statValue={`$${totalDepositedUSD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              chartProps={{
                type: "overall-deposit",
                customData: liveDepositData,
                defaultTimeframe: "3 Months",
              }}
            />
            {depositTotalMissingPrice && (
              <p className={noteClass}>Excludes assets with no oracle price right now.</p>
            )}
          </article>
          <article className="flex-1 min-w-0">
            {earnedSummary.usd === null ? (
              // Unknown ≠ zero: no chart, no "$0.00" — an honest "—" with the reason.
              <div className={`w-full h-full min-h-[120px] rounded-2xl p-3 border flex flex-col gap-1 ${
                isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"
              }`}>
                <h2 className={`text-[13px] font-medium ${isDark ? "text-[#A7A7A7]" : "text-[#777777]"}`}>Net Earnings</h2>
                <p className={`text-[17px] sm:text-[21px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>—</p>
                <p className={`text-[12px] font-medium ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
                  {earnTxLoading
                    ? "Reading your supply history from chain…"
                    : "Earned interest can't be proven from your on-chain history (positions opened outside the scanned history)."}
                </p>
              </div>
            ) : (
              <>
                <CollapsibleChart
                  label="Net Earnings"
                  // Renders the same way "Overall Deposit" does at $0.00 — a flat
                  // chart, not a special empty-state card — so a brand-new
                  // account looks consistent across both cards.
                  statValue={netEarningsStat}
                  chartProps={{
                    type: "net-apy",
                    customData: liveEarnedYieldData,
                    defaultTimeframe: "3 Months",
                  }}
                />
                {earnedSummary.partial && (
                  <p className={noteClass}>
                    Partial — excludes {earnedSummary.unknownSymbols.join(", ")} (cost basis not provable from on-chain history).
                  </p>
                )}
              </>
            )}
          </article>
        </section>
      )}

      {/* Pool Table — full width */}
      <section className="w-full pb-8" aria-label="Vaults and Positions">
        <Table
          filterDropdownPosition="right"
          filters={{
            filters: ["Deposit"],
            allChainDropdown: true,
            supplyApyTab: true,
          }}
          heading={{
            tabsItems: [
              { id: "vaults", label: "Vaults" },
              { id: "positions", label: "Positions" },
            ],
            tabType: "underline",
          }}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          tableHeadings={activeTab === "positions" ? positionsTableHeadings : vaultsTableHeadings}
          tableBody={getTableDataForTab(activeTab)}
          onRowClick={handleRowClick}
          hoverBackground="hover:bg-[#F1EBFD]"
        />
      </section>
    </main>
  );
}
