// Earn page constants (Solana port).
//
// The Stellar build shipped hardcoded demo series here (`depositData`, `netApyData`) and a
// hardcoded Stellar pool table / contract map (`tableBody`, `STELLAR_POOLS`, `STELLAR_ASSETS`).
// They were removed: every pool row is now built from the token registry
// (lib/solana/tokens.ts) + on-chain Reserve state, and there is no fabricated history.

export const FILTER_OPTIONS = ["1 Week", "1 Month", "3 Months", "All Time"];

// Vaults tab — pool-level aggregate stats. Ends with "Your Supply" (the
// amount + $ value the connected wallet has supplied to this specific pool).
export const vaultsTableHeadings = [
    { label: "Pool", id: "pool" },
    { label: "Assets Supplied", id: "assets-supplied" ,icon:true},
    { label: "Supply APY", id: "supply-apy" ,icon:true},
    { label: "Assets Borrowed", id: "assets-borrowed" ,icon:true},
    { label: "Borrow APY", id: "borrow-apy" ,icon:true},
    { label: "Utilization Rate", id: "utilization-rate" ,icon:true},
    { label: "Your Supply", id: "your-supply" ,icon:true},
  ]

// Positions tab — the user's own holdings, so "Assets Borrowed" (a pool-wide
// stat) is dropped; the row is already scoped to what the user supplied, so
// a separate "Your Supply" column would just repeat "Assets Supplied".
export const positionsTableHeadings = [
    { label: "Pool", id: "pool" },
    { label: "Assets Supplied", id: "assets-supplied" ,icon:true},
    { label: "Supply APY", id: "supply-apy" ,icon:true},
    { label: "Borrow APY", id: "borrow-apy" ,icon:true},
    { label: "Utilization Rate", id: "utilization-rate" ,icon:true},
  ]

// Back-compat alias — kept in case anything still imports the old name.
export const tableHeadings = vaultsTableHeadings
