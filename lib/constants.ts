import { DEPOSIT_SYMBOLS, LENDING_SYMBOLS, TOKENS, TOKEN_SYMBOLS } from "@/lib/solana/tokens";

export const navbarItems = [
  { title: "Portfolio", link: "/portfolio", group: "primary" },
  { title: "Earn", link: "/earn", group: "primary" },
  { title: "Margin", link: "/", group: "bordered" },
  { title: "Trade", link: "/trade", group: "bordered" },
  { title: "Farm", link: "/farm", group: "bordered" },
  { title: "Copilot", link: "/copilot", group: "secondary" },
];

export const tradeItems = [
  { title: "Spot", link: "/trade/spot" },
  { title: "Perps", link: "/trade/perps" },
];

/**
 * Asset dropdown options everywhere in the app — straight from the token registry
 * (lib/solana/tokens.ts), never a hardcoded list.
 */
export const DropdownOptions: string[] = [...TOKEN_SYMBOLS];

/**
 * Borrowable assets (Margin page Borrow / Dual Borrow dropdowns) — only the tokens with an Earn
 * pool the app offers (`lendable` in the registry): SOL, USDC, USDT. Staking tokens are
 * collateral-only.
 */
export const BorrowDropdownOptions: string[] = [...LENDING_SYMBOLS];

/**
 * Margin collateral deposit pickers (Leverage "Deposit", Transfer Collateral "MB"): every registry
 * token flagged `depositable` (SOL, USDC, JitoSOL, JupSOL, JupUSD and the xStocks; not USDT).
 */
export const CollateralDropdownOptions: string[] = [...DEPOSIT_SYMBOLS];

/** Icon path per symbol (registry icons). */
export const iconPaths: Record<string, string> = Object.fromEntries(
  TOKENS.flatMap((t) => [
    [t.symbol, t.icon],
    [t.symbol.toUpperCase(), t.icon],
  ]),
);
