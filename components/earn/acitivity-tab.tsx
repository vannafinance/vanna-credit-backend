'use client';

/**
 * "Activity" tab for an earn pool: shows the pool's composition and the
 * connected wallet's transaction feed, decoded from the program's own Anchor
 * events (no indexer — see lib/solana/history.ts).
 */
import { useMemo } from "react";
import { Table } from "./table";
import { useTheme } from "@/contexts/theme-context";
import { usePoolData, useEarnTransactions } from "@/hooks/use-earn";
import { useSelectedPoolStore } from "@/store/selected-pool-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useUserStore } from "@/store/user";
import { explorerUrl } from "@/lib/solana/config";
import { TOKENS, tokenIcon } from "@/lib/solana/tokens";
import { resolveToken } from "./earn-utils";

const distributionHeadings = [
  { label: "Bucket", id: "user-id" },
  { label: "Assets", id: "supplied-assets" },
  { label: "Share of Supply (%)", id: "supply-percent" },
];

/** Empty, mutable table-body scaffold for transaction rows; populated per-render. */
export const transactionTableBody = {
  rows: [] as {
    cell: {
      title?: string;
      description?: string;
      badge?: string;
      icon?: string;
      clickable?: string;
      link?: string;
      percentage?: number;
    }[];
  }[],
};

/** Column definitions for the recent-transactions table (shared with other earn views). */
export const transactionTableHeadings = [
  { label: "Date", id: "date" },
  { label: "Type", id: "type" },
  { label: "Amount", id: "amount" },
  { label: "Status", id: "status" },
  { label: "Tx Hash", id: "txHash" },
];

/**
 * Renders the pool's composition (idle liquidity vs. borrowed, from the projected
 * Reserve) + the connected wallet's decoded supply/withdraw events for the
 * selected pool, with USD values derived from oracle prices.
 */
export const ActivityTab = () => {
  const { isDark } = useTheme();
  const { transactions: recentTransactions, isLoading: historyLoading, history } = useEarnTransactions();
  const { pools } = usePoolData();
  const selectedAsset = useSelectedPoolStore((state) => state.selectedAsset);
  const token = resolveToken(selectedAsset) ?? TOKENS[0];
  const symbol = token.symbol;
  const tokenPrices = useTokenPrices([symbol]);
  const price = tokenPrices[symbol] ?? 0;
  const usd = (n: number) => (price > 0 ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");

  const filteredTransactions = useMemo(() => {
    return (recentTransactions ?? [])
      .filter((tx) => tx.symbol === symbol)
      .map((tx) => ({
        type: tx.type,
        amount: tx.amount,
        timestamp: tx.timestamp,
        hash: tx.signature,
        // Only confirmed, successful transactions carry decoded events.
        status: "success" as const,
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [recentTransactions, symbol]);

  // Pool composition for the currently viewed pool: where the supplied assets are right now.
  // (A per-holder distribution needs a token-holder index, which this network's RPC does not
  // serve — getTokenLargestAccounts is unsupported — so it is not shown rather than faked.)
  const compositionBody = useMemo(() => {
    const pool = pools[symbol];
    if (!pool?.initialised || pool.totalSupplied <= 0) return { rows: [] };
    const idle = pool.availableLiquidity;
    const borrowed = pool.totalBorrowed;
    const total = pool.totalSupplied;
    const pct = (n: number) => (total > 0 ? Math.min(100, (n / total) * 100) : 0);
    return {
      rows: [
        {
          cell: [
            { icon: tokenIcon(symbol), title: "Available liquidity" },
            {
              icon: tokenIcon(symbol),
              title: `${idle.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${symbol}`,
              description: usd(idle),
            },
            { percentage: pct(idle) },
          ],
        },
        {
          cell: [
            { icon: tokenIcon(symbol), title: "Borrowed by margin accounts" },
            {
              icon: tokenIcon(symbol),
              title: `${borrowed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${symbol}`,
              description: usd(borrowed),
            },
            { percentage: pct(borrowed) },
          ],
        },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pools, symbol, price]);

  // Format transactions for table
  const txTableBody = useMemo(() => {
    if (filteredTransactions.length === 0) {
      return {
        rows: [
          {
            cell: [
              { title: "-", description: historyLoading ? "Loading…" : "No transactions yet" },
              { title: "-" },
              { title: "-" },
              { title: "-" },
              { title: "-" },
            ],
          },
        ],
      };
    }

    return {
      rows: filteredTransactions.map((tx) => ({
        cell: [
          {
            title: new Date(tx.timestamp).toLocaleDateString(),
            description: new Date(tx.timestamp).toLocaleTimeString(),
          },
          {
            title: tx.type === 'supply' ? 'Pool Deposit' : 'Pool Withdraw',
            badge: tx.type === 'supply' ? 'green' : 'orange',
          },
          {
            icon: tokenIcon(symbol),
            title: `${(parseFloat(tx.amount) || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${symbol}`,
            description: usd((parseFloat(tx.amount) || 0) * price),
          },
          {
            title: tx.status,
            badge: 'green',
          },
          {
            title: tx.hash ? `${tx.hash.slice(0, 8)}...${tx.hash.slice(-4)}` : "—",
            clickable: tx.hash ? "link" : undefined,
            link: tx.hash ? explorerUrl("tx", tx.hash) : undefined,
          },
        ],
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredTransactions, symbol, price, historyLoading]);

  const userAddress = useUserStore((s) => s.address);

  return (
    <section
      className={`w-full h-fit rounded-[20px] border-[1px] p-[24px] flex flex-col gap-[24px] ${
        isDark ? "bg-[#111111] border-[#333333]" : "bg-[#F7F7F7] border-gray-200"
      }`}
      aria-label="Activity Overview"
    >
      {/* Pool Composition */}
      <article aria-label="Pool Composition">
        <Table
          showPieChart={true}
          tableBodyBackground={isDark ? "bg-[#222222]" : "bg-white"}
          heading={{ heading: "Pool Composition" }}
          tableHeadings={distributionHeadings}
          tableBody={compositionBody}
        />
      </article>

      {/* Recent Transactions */}
      <article aria-label="Recent Transactions">
        <div className="flex justify-between items-center mb-4">
          <h3 className={`text-lg font-semibold ${isDark ? "text-white" : "text-gray-900"}`}>
            Your Recent Transactions
          </h3>
          <span className={`text-sm ${isDark ? "text-gray-400" : "text-gray-500"}`}>
            {filteredTransactions.length} transactions
          </span>
        </div>
        <Table
          filterDropdownPosition="right"
          tableBodyBackground={isDark ? "bg-[#222222]" : "bg-white"}
          heading={{ heading: "" }}
          filters={{ filters: ["Deposits", "Withdrawals"], customizeDropdown: true }}
          tableHeadings={transactionTableHeadings}
          tableBody={txTableBody}
        />
      </article>

      {/* Explorer Link */}
      <div className={`text-center py-4 rounded-xl ${isDark ? "bg-[#1a1a1a]" : "bg-gray-100"}`}>
        {userAddress ? (
          <a
            href={explorerUrl("address", userAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#703AE6] hover:underline text-sm font-medium"
          >
            View all your transactions on Solana Explorer →
          </a>
        ) : (
          <span className={`text-sm font-medium ${isDark ? "text-gray-400" : "text-gray-500"}`}>
            Connect your wallet to see your supply / withdraw activity.
          </span>
        )}
        {history && !history.complete && (
          <p className={`text-xs mt-1 ${isDark ? "text-gray-500" : "text-gray-500"}`}>
            Showing activity from your latest {history.scanned} transactions.
          </p>
        )}
      </div>
    </section>
  );
};
