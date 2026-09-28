// Margin component constants
import { TOKENS } from "@/lib/solana/tokens";
import { SAFE_HEALTH_FACTOR } from "@/lib/solana/config";

// ============================================
// Positions Table Constants
// ============================================
export const TABLE_ROW_HEADINGS = [
  "Collateral Deposited",
  "Borrowed Assets",
  "Leverage Taken",
  "Health Factor",
  "Interest accrued till date",
  "Action",
] as const;

/** Icon per registry symbol (lib/solana/tokens.ts is the single source of truth). */
export const COIN_ICONS: Record<string, string> = Object.fromEntries(TOKENS.map((t) => [t.symbol, t.icon]));

// ============================================
// Collateral Box Constants
// ============================================
export const DEPOSIT_PERCENTAGES = [10, 25, 50, 100] as const;

export const PERCENTAGE_COLORS: Record<number, string> = {
  10: "bg-[#703AE6]",
  25: "bg-[#FC5457]",
  50: "bg-[#E63ABB]",
  100: "bg-[#FF007A]",
} as const;

// ============================================
// Leverage Collateral Constants
// ============================================
export const LEVERAGE_TABS = [
  {
    id: "leverage-assets",
    label: "Leverage your Assets",
    shortLabel: "Leverage",
  },
  {
    id: "repay-loan",
    label: "Repay Loan",
    shortLabel: "Repay",
  },
  {
    id: "transfer-collateral",
    label: "Transfer Collateral",
    shortLabel: "Transfer",
  },
] as const;

// ============================================
// Borrow Box Constants
// ============================================
/**
 * Fresh-account max leverage at the UI safety buffer: h / (h − 1) with h = SAFE_HEALTH_FACTOR
 * (1.15) → ≈7.66x (floored to 2 dp). Borrowed tokens count as collateral, so this is the most a
 * brand-new deposit can be levered while keeping HF >= 1.15. The live slider uses the
 * account-aware `maxLeverageForInput` (lib/margin/amounts.ts); this is the fallback.
 */
export const MAX_LEVERAGE = Math.floor((SAFE_HEALTH_FACTOR / (SAFE_HEALTH_FACTOR - 1)) * 100) / 100;

export const MODE_CONFIG = {
  Deposit: {
    maxItems: 1,
    showTotal: false,
    showInputBoxes: false,
  },
  Borrow: {
    maxItems: 2,
    showTotal: true,
    showInputBoxes: true,
  },
} as const;

// ============================================
// Info Card Format Mapping
// Maps field IDs to format types for easy configuration
// Components handle currency/coin names themselves
// ============================================
import { FormatType } from "@/lib/utils/format-value";

export const FIELD_FORMAT_MAP: Record<string, FormatType> = {
  // Number values (components add currency names)
  totalBorrowedValue: "number",
  totalCollateralValue: "number",
  totalValue: "number",
  debtLimit: "number",
  minDebt: "number",
  maxDebt: "number",
  depositAmount: "number",
  fees: "number",
  totalDeposit: "number",
  updatedCollateral: "number",
  updatedBorrowedAmount: "number",
  updatedHealthFactor: "health-factor",
  updatedLeverage: "leverage",
  
  // Percentage values
  borrowRate: "percentage",
  liquidationPremium: "percentage",
  liquidationFee: "percentage",
  
  // Leverage and multipliers
  leverage: "leverage",
  platformPoints: "points",
  
  // Health factors
  avgHealthFactor: "health-factor",
  netHealthFactor: "health-factor",
  
  // Time values
  timeToLiquidation: "time-minutes",
} as const;

/**
 * Fields that should use large format (K/M) for numbers
 */
export const LARGE_FORMAT_FIELDS = [
  "totalBorrowedValue",
  "totalCollateralValue",
  "debtLimit",
  "minDebt",
  "maxDebt",
] as const;

/**
 * Fields shown with full (7dp) decimal precision
 * instead of InfoCard's default 2dp — for exchange-rate-shaped values close
 * to 1.0 (e.g. underlying-per-vToken), 2dp rounds away the entire signal
 * (1.0047294 displayed as "1.00" looked identical to an unmoved 1:1 rate).
 */
export const PRECISE_NUMBER_FIELDS = ["tokenPerVToken"] as const;

/**
 * Fields rendered as USD currency. InfoCard auto-prefixes "$" to these.
 * Keep this list in sync with any new dollar-valued field IDs.
 */
export const USD_FIELDS = [
  "totalBorrowedValue",
  "totalCollateralValue",
  "totalValue",
  "debtLimit",
  "minDebt",
  "maxDebt",
  "depositAmount",
  "fees",
  "totalDeposit",
  "updatedCollateral",
] as const;

// ============================================
// Account Stats Constants
// ============================================
export const ACCOUNT_STATS_ITEMS = [
  {
    id: "netHealthFactor",
    name: "Net Health Factor",
    icon: "/margin/health.png",
  },
  {
    id: "collateralLeftBeforeLiquidation",
    name: "Collateral Left Before Liquidation",
    icon: "/margin/liquidation.png",
  },
  {
    id: "netAvailableCollateral",
    name: "Net Available Collateral",
    icon: "/margin/dollar.png",
  },
  {
    id: "netAmountBorrowed",
    name: "Net amount Borrowed",
    icon: "/margin/retry.png",
  },
  {
    id: "netLeverageTaken",
    name: "Net Leverage Taken",
    icon: "/margin/bag.png",
  },
] as const;

// ============================================
// Margin Account Info Constants
// ============================================
export const MARGIN_ACCOUNT_INFO_ITEMS = [
  {
    id: "totalBorrowedValue",
    name: "Total Borrowed value",
  },
  {
    id: "totalCollateralValue",
    name: "Net Available Collateral",
  },
  {
    id: "totalValue",
    name: "Total Value",
  },
  {
    id: "avgHealthFactor",
    name: "Net Health Factor",
  },
  {
    id: "borrowRate",
    name: "Net Borrow Rate",
  },
] as const;

export const MARGIN_ACCOUNT_MORE_DETAILS_ITEMS = [
  {
    id: "liquidationPremium",
    name: "Liquidation premium",
  },
  {
    id: "liquidationFee",
    name: "Liquidation Fee",
  },
  {
    id: "debtLimit",
    name: "Debt Limit",
  },
  {
    id: "minDebt",
    name: "Min Debt",
  },
  {
    id: "maxDebt",
    name: "Max Debt",
  },
] as const;

// Items shown in the "ORACLES AND LTS" expandable section
export const MARGIN_ORACLE_LTS_ITEMS = [
  { id: "oracleContract", name: "Oracle (Pyth Receiver)" },
  { id: "liquidationThreshold", name: "Liquidation Threshold" },
  { id: "riskEngine", name: "Vanna Program" },
] as const;

// ============================================
// Carousel Constants
// ============================================
export const CAROUSEL_ITEMS = [
  {
    icon: "/assets/mdi_learn-outline.png",
    title: "Multicollateral Loans",
    description:
      "Don't want to sell your SOL, LSTs and stablecoins? Borrow against them! Add multiple collaterals at the same time and draw a loan from Vanna's lending pools — then do whatever you want with that loan.",
  },
  {
    icon: "/assets/mdi_learn-outline.png",
    title: "Flexible Borrowing",
    description:
      "Access instant liquidity without selling your assets. Use your crypto holdings as collateral and maintain your long-term positions while getting the funds you need today.",
  },
  {
    icon: "/assets/mdi_learn-outline.png",
    title: "Maximize Capital",
    description:
      "Leverage your portfolio to its full potential. Borrow against multiple assets simultaneously and use the funds for trading, investing, or any other purpose you choose.",
  },
] as const;

// ============================================
// Balance Type Constants
// ============================================
export const BALANCE_TYPE_OPTIONS = ["WB", "MB"] as const;
