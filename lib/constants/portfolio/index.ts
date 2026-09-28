// ============================================
// Portfolio Account Stats Constants
// ============================================
// Account-level summary across the wallet, the lending pools and the margin account. All four
// are on-chain-derived USD figures (no "portfolio balance" placeholders):
// - Net Worth       = wallet USD + supplied USD + margin equity (collateral − debt)
// - Total Supplied  = Σ lender positions (shares × projected exchange rate) × oracle price
// - Total Borrowed  = Σ margin debt (accrued) × oracle price
// - Net Earnings    = Σ earned lending interest from `computeEarnedInterest`; "—" / "partial"
//                     when the cost basis of any position can't be proven from on-chain history.
//
// The Stellar build also exported hardcoded demo series (`netEarningsData`, `netVolumeData`) —
// removed: they rendered as if real.
export const PORTFOLIO_STATS_ITEMS = [
  {
    id: "netWorth",
    name: "Net Worth",
    icon: "/margin/dollar.png",
    tooltip: "Wallet balance + supplied assets + margin account equity (collateral minus debt).",
  },
  {
    id: "totalSupplied",
    name: "Total Supplied",
    icon: "/margin/bag.png",
    tooltip: "Current value of your lending pool positions, including accrued interest.",
  },
  {
    id: "totalBorrowed",
    name: "Total Borrowed",
    icon: "/margin/retry.png",
    tooltip: "Outstanding margin debt, including accrued interest.",
  },
  {
    id: "netEarnings",
    name: "Net Earnings",
    icon: "/margin/health.png",
    tooltip: "Interest earned on supplied assets (current value minus net deposits), proven from on-chain history.",
  },
] as const;
