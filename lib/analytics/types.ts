/**
 * Analytics API contract. Everything here is JSON-safe (numbers/strings/booleans) and shared by the
 * server readers (`lib/analytics/server/*`), the pure risk logic (`lib/analytics/risk.ts`) and the UI.
 *
 * Rules the data obeys:
 *  - every figure is read from the fork's on-chain accounts (or computed from those reads);
 *  - what could not be read is `null` / listed in `reasons` - never 0, never a placeholder;
 *  - reasons are structured codes, not sentences: wording belongs to the UI.
 */

export type AccountStatus =
  | "incomplete" // cannot be valued right now (see reasons)
  | "empty" // no collateral, no debt
  | "nodebt" // holds collateral, owes nothing
  | "healthy"
  | "warning"
  | "critical"
  | "liquidatable";

export type PositionKind = "direct" | "receipt" | "venue";

export type IncompleteReason =
  | { code: "missing_price"; symbols: string[] }
  | { code: "unknown_asset"; assetIndexes: number[] }
  | { code: "venue_unreadable" }
  | { code: "receipt_unreadable"; symbols: string[] };

export interface CollateralLine {
  symbol: string;
  mint: string;
  assetIndex: number;
  kind: PositionKind;
  /** Registry symbol this line is priced off (a Kamino receipt → its underlying). */
  underlying: string;
  /** Token units. 0 for the Phoenix venue line, which is one lump value. */
  amount: number;
  usd: number;
}

export interface DebtLine {
  symbol: string;
  mint: string;
  assetIndex: number;
  /** Token units owed, accrued to the fork clock, rounded up like the program. */
  amount: number;
  usd: number;
  borrowApr: number | null;
}

export interface AccountRow {
  owner: string;
  address: string;
  status: AccountStatus;
  /** False when the account cannot be valued; its totals are then null and it is left out of aggregates. */
  valued: boolean;
  reasons: IncompleteReason[];
  /**
   * Assets whose on-chain price had not been updated within its allowed age when this account was read.
   * The account is still valued at that last on-chain price (as the Margin page does: the fork keeper
   * refreshes prices in between, and dropping the account would make every figure vanish and reappear),
   * so this is a note, not a reason the account cannot be valued.
   */
  stalePrices?: string[];
  collateralUsd: number | null;
  debtUsd: number | null;
  equityUsd: number | null;
  /** null = no debt (infinite) or not valued. */
  healthFactor: number | null;
  leverage: number | null;
  /** Share of collateral value that can disappear before liquidation. */
  bufferPct: number | null;
  bufferUsd: number | null;
  liquidatable: boolean;
  collateral: CollateralLine[];
  debts: DebtLine[];
  composition: { direct: number; receipt: number; venue: number };
  /** The account holds a Phoenix venue line (valued as one lump; individual trades are not decomposed). */
  venueHeld: boolean;
  /** Wall-clock ms when this row was read. */
  readAt: number;
}

/** What the accounts API returns per row: the account plus the server's own measurements over time. */
export interface AccountView extends AccountRow {
  /** Health-factor readings taken by THIS server on its refresh passes (oldest first). Not chain history. */
  hfTrend: number[];
  /** Unix time of the earliest scanned transaction that touched the account - not its creation time. */
  firstSeenTime: number | null;
}

export interface Coverage {
  /** Margin accounts found so far. */
  accountsFound: number;
  /** Program transactions inspected to find them. */
  transactionsScanned: number;
  /** Transactions that would not load after several tries and were skipped. */
  transactionsSkipped: number;
  /** Older transactions not yet inspected. 0 = the scan window is fully covered. */
  transactionsPending: number;
  /** Unix seconds of the oldest inspected transaction (null = none yet). */
  oldestScannedTime: number | null;
  /** True once the configured look-back window is fully covered. */
  complete: boolean;
  /** True when program transactions older than the scanned window exist (null = not checked yet). */
  olderActivityExists: boolean | null;
  /** Maximum transactions the scan will look back through. */
  windowLimit: number;
}

export interface Band {
  key: string;
  label: string;
  tone: "danger" | "critical" | "warn" | "ok";
  count: number;
  debtUsd: number;
  collateralUsd: number;
}

export interface LeverageBin {
  key: string;
  label: string;
  count: number;
  debtUsd: number;
}

export interface AssetTotal {
  symbol: string;
  kind: PositionKind | "debt";
  underlying: string;
  amount: number;
  usd: number;
  accounts: number;
  /** Token units across ALL accounts, including those waiting for a fresh price (a balance needs no price). */
  amountAll: number;
  accountsAll: number;
}

export interface AccountsSummary {
  total: number;
  valued: number;
  incomplete: number;
  /** Accounts (valued) with debt. */
  borrowers: number;
  collateralUsd: number;
  debtUsd: number;
  equityUsd: number;
  liquidatableCount: number;
  liquidatableDebtUsd: number;
  liquidatableCollateralUsd: number;
  atRiskCount: number;
  atRiskDebtUsd: number;
  atRiskCollateralUsd: number;
  badDebtUsd: number;
  underwaterCount: number;
  /** Debt-weighted: Σcollateral / Σdebt over accounts with debt. */
  averageHealth: number | null;
  averageLeverage: number | null;
  /** Debt within the buffer zone just above liquidation. */
  bufferZoneDebtUsd: number;
  healthBands: Band[];
  leverageBins: LeverageBin[];
  composition: { direct: number; receipt: number; venue: number };
  concentration: { top1: number | null; top3: number | null; hhi: number | null };
  collateralBy: AssetTotal[];
  debtBy: AssetTotal[];
  /** Counts per row status, over every account (including incomplete). */
  statusCounts: Record<AccountStatus, number>;
}

/** Row sort/filter keys understood by /api/analytics/accounts. */
export type AccountSortKey = "health" | "debt" | "collateral" | "equity" | "leverage" | "buffer" | "status";
export type AccountFilter = "all" | "liquidatable" | "atrisk" | "healthy" | "nodebt" | "incomplete" | "withdebt";
