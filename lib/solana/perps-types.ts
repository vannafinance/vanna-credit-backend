/**
 * The Perps page's data model — what `hooks/use-perps.ts` hands the UI. Kept in its own module so
 * components can import types without pulling the Solana service layer.
 *
 * Perps run on Phoenix through the margin account's own Phoenix trader (cross margin); see
 * lib/solana/perps.ts. Immediate-or-cancel market orders only (filled inside the transaction, so
 * there are never pending orders), USDC collateral (as phUSD) only.
 */

export type PerpSide = "long" | "short";

export interface PerpMarketInfo {
  /** "SOL" | "ETH" | "BTC" | "TSLA" | "META" — the key the actions take. */
  key: string;
  /** "ETH-PERP". */
  name: string;
  /** Position in the oracle's market book. */
  leg: number;
  /** Index price the protocol values positions at (Scope / Pyth), USD. */
  indexPrice: number | null;
  /** Phoenix's mark price (orders fill near it), USD. */
  markPrice: number;
  /** True when that price is fresh enough for the program's checks. */
  priceFresh: boolean;
  /** Leverage cap, e.g. 5. */
  maxLeverage: number;
  tradingEnabled: boolean;
  /** Phoenix taker fee on this market (fraction of the notional, e.g. 0.00035), from its orderbook. */
  takerFee: number;
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
  /** Kept for older callers: the index price (see `indexPrice`). */
  markPrice: number;
  /** Index price the oracle values the position at (what the health factor uses), USD. */
  indexPrice: number;
  /** Taker fee to close the whole position at the index price (the oracle deducts it), USD. */
  closeFeeUsd: number;
  collateralUsdc: number;
  leverage: number;
  /** Index-price PnL before fees and funding. */
  pnlUsd: number;
  pnlPercent: number;
  /** Funding owed (negative) or earned since the position was opened, USD. */
  fundingUsd: number;
  /** What Vanna counts for this position: PnL + funding − the taker fee to close. */
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
  /** The Phoenix account as Vanna values it (collateral + position equity), USD. */
  venueValueUsd: number;
  /** USDC (as phUSD) sitting in the Phoenix trader account. */
  idleUsdc: number;
  /** How much Phoenix would pay out right now without queueing it (its withdraw budget). */
  withdrawableNowUsdc: number;
  /** Margin account totals (all holdings incl. perps), USD. */
  totalCollateralUsd: number;
  totalDebtUsd: number;
  /** null = no debt (infinite). Liquidatable at ≤ 1.10. */
  healthFactor: number | null;
  /** Every token collateral line counted in the health factor (the Phoenix venue excluded), USD. */
  collateralRows: { symbol: string; usd: number }[];
  /** Every debt line, USD. */
  debtRows: { symbol: string; usd: number }[];
  /** On-chain (oracle) USD price per registry symbol, as the health factor uses them. */
  prices: Record<string, number>;
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

export interface WithdrawPerpCollateralRequest {
  /** USDC to move from Phoenix back to the margin; omit for everything. */
  amount?: number;
}

export interface CancelPerpRequest {
  market: string;
  side: PerpSide;
}

/** One on-chain Phoenix action of the margin (decoded from its transactions). */
export interface PerpHistoryRow {
  signature: string;
  /** Unix seconds. */
  timestamp: number;
  /** "open" market order, "close" reduce-only order, "deposit" USDC into Phoenix, "settle" USDC
   * back to the margin ("cancel" / "setup" are kept for older rows). */
  /** "nofill": an immediate-or-cancel order that found nothing inside its price limit. */
  action: "open" | "close" | "cancel" | "settle" | "setup" | "deposit" | "nofill";
  market: string | null;
  side: PerpSide | null;
  /** Order size, USD (open / close). */
  sizeUsd: number | null;
  /** USDC moved into Phoenix (deposit) or back to the margin (settle). */
  usdc: number | null;
}
