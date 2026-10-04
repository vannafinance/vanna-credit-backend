/**
 * The Perps page's data model — what `hooks/use-perps.ts` hands the UI. Kept in its own module so
 * components can import types without pulling the Solana service layer.
 *
 * Perps run on GMTrade (GMX-Solana) through the margin account's venue account; see
 * lib/solana/perps.ts. Market orders only (the validator refuses limit / trigger orders), USDC
 * collateral only, one pending order per market and side.
 */

export type PerpSide = "long" | "short";

export interface PerpMarketInfo {
  /** "ETH" | "BTC" | "SOL" — the key the actions take. */
  key: string;
  /** "ETH-PERP". */
  name: string;
  /** Leg in the oracle's market book. */
  leg: number;
  /** Index price the protocol values positions at (Scope / Pyth), USD. */
  indexPrice: number | null;
  /** True when that price is fresh enough for the program's checks. */
  priceFresh: boolean;
  /** Leverage cap, e.g. 5. */
  maxLeverage: number;
  tradingEnabled: boolean;
  /** TradingView symbol for the chart. */
  chartSymbol: string;
  icon: string;
}

export interface PerpPosition {
  market: string;
  marketName: string;
  side: PerpSide;
  sizeUsd: number;
  sizeTokens: number;
  entryPrice: number;
  markPrice: number;
  collateralUsdc: number;
  leverage: number;
  /** Mark-price PnL before fees. */
  pnlUsd: number;
  pnlPercent: number;
  /** What Vanna counts: collateral + PnL − pending borrowing / funding fees − close fee, ≥ 0. */
  equityUsd: number;
  /** Index price at which this position's equity reaches zero (fees ignored). */
  zeroEquityPrice: number;
  /** Price at which the whole margin account becomes liquidatable (HF 1.10), this market moving alone. */
  liquidationPrice: number | null;
}

export interface PerpOrder {
  market: string;
  marketName: string;
  side: PerpSide;
  /** "open" = MarketIncrease, "close" = MarketDecrease. */
  kind: "open" | "close";
  sizeUsd: number;
  collateralUsdc: number;
  /** USDC held in the order's escrow. */
  escrowedUsdc: number;
}

export interface PerpsAccount {
  /** Wallet connected and a margin account exists. */
  hasMargin: boolean;
  /** USDC in the margin vault — what a new order can use as collateral. */
  marginUsdc: number;
  /** The whole venue account as Vanna values it (idle + escrow + equity), USD. */
  venueValueUsd: number;
  /** USDC sitting in the venue account, not yet settled back to the margin. */
  idleUsdc: number;
  /** Margin account totals (all holdings incl. perps), USD. */
  totalCollateralUsd: number;
  totalDebtUsd: number;
  /** null = no debt (infinite). Liquidatable at ≤ 1.10. */
  healthFactor: number | null;
}

export interface PerpsView {
  markets: PerpMarketInfo[];
  positions: PerpPosition[];
  orders: PerpOrder[];
  account: PerpsAccount;
}

export interface OpenPerpRequest {
  market: string;
  side: PerpSide;
  /** USDC from the margin account used as collateral (UI units). */
  collateral: number;
  /** Size = collateral × leverage. 1 ≤ leverage ≤ market cap. */
  leverage: number;
  /** Price protection for the market order, bps (default 100 = 1%). */
  slippageBps?: number;
}

export interface ClosePerpRequest {
  market: string;
  side: PerpSide;
  /** USD size to close; omit for a full close. */
  sizeUsd?: number;
  slippageBps?: number;
}

export interface CancelPerpRequest {
  market: string;
  side: PerpSide;
}
