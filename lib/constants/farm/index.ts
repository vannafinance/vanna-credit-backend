// Farm table headings + header stat definitions.
//
// The Stellar build also shipped hardcoded demo data here (`farmTableBody`, `singleAssetTableBody`,
// `FARM_STATS_VALUES`, `farmStatsData`, `farmLiquidationStatsData`, margin/leverage demo stats)
// that rendered as if real (e.g. "$342.8M TVL", "24.31% APR"). All removed: the Farm pages build
// their rows from lib/farm/pools.ts (metrics null → "—") and farmService.

export const farmTableHeadings = [
  { label: "Pool", id: "pool", icon: true },
  { label: "DEX", id: "dex", icon: true },
  { label: "DEX LP TVL", id: "dex-lp-tvl", icon: true },
  { label: "DEX TVL Token 0", id: "dex-tvl-token-0", icon: true },
  { label: "DEX TVL Token 1", id: "dex-tvl-token-1", icon: true },
  { label: "Pool APR", id: "pool-apr", icon: true },
  { label: "Fees", id: "fees", icon: true },
  { label: "Holding", id: "holding", icon: true },
];

// Single Asset Table Data
export const singleAssetTableHeadings = [
  { label: "Asset", id: "asset", icon: true },
  { label: "Protocol", id: "protocol", icon: true },
  { label: "Total Deposits", id: "total-deposits", icon: true },
  { label: "Total Borrow", id: "total-borrow", icon: true },
  { label: "Supply APY", id: "supply-apy", icon: true },
  { label: "Borrow APY", id: "borrow-apy", icon: true },
  { label: "Utilization", id: "utilization", icon: true },
  { label: "Holding", id: "holding", icon: true },
];

// The Positions tab shows the user's own positions, not pool totals — so the
// pool columns (Total Borrow / Borrow APY / Utilization) don't apply. Each row
// is a single "Holdings" value (the position amount) with its breakdown as a
// wrapping subtext, plus APY. Keeping it to four columns avoids the long LP
// composition string overflowing into the next column.
export const positionsTableHeadings = [
  { label: "Asset", id: "asset", icon: true },
  { label: "Protocol", id: "protocol", icon: true },
  { label: "Holdings", id: "holdings", icon: true },
  { label: "APY", id: "apy", icon: true },
];

// Portfolio "Spot" tab — margin-account token balances held directly (not
// lent out, not deposited as LP). Simpler shape than positionsTableHeadings:
// no APY column since spot holdings don't earn yield, just a USD value.
export const spotBalancesTableHeadings = [
  { label: "Asset", id: "asset", icon: true },
  { label: "Venue", id: "venue", icon: true },
  { label: "Balance", id: "balance", icon: true },
  { label: "Value (USD)", id: "value", icon: true },
];

export const FARM_STATS_ITEMS = [
  {
    id: "depositTVL",
    name: "Your Deposit TVL",
    icon: "/margin/bag.png",
  },
  {
    id: "earnings",
    name: "Your Earnings",
    icon: "/margin/dollar.png",
  },
  {
    id: "netFarmApy",
    name: "Net Farm APY",
    icon: "/margin/health.png",
  },
  {
    id: "pendingRewards",
    name: "Pending Rewards",
    icon: "/margin/retry.png",
  },
];
