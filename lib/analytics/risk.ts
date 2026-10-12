/**
 * Pure risk logic: classify accounts and aggregate them. No network, no DOM, no invented inputs -
 * everything is derived from the `AccountRow`s the server read. Shared by the server (summary over
 * ALL accounts) and the browser (what-if, filtering already-fetched rows).
 */
import { LIQUIDATION_HEALTH_FACTOR } from "@/lib/solana/config";
import type {
  AccountFilter,
  AccountRow,
  AccountSortKey,
  AccountStatus,
  AccountsSummary,
  AssetTotal,
  Band,
  LeverageBin,
} from "./types";

/** The protocol's liquidation line (on-chain `BALANCE_TO_BORROW_THRESHOLD`). */
export const LIQUIDATION_LINE = LIQUIDATION_HEALTH_FACTOR;

/**
 * Display-only bands layered on the liquidation line. They are labels for reading the picture, not
 * protocol parameters: an account is "At risk" below WARNING_BELOW, "Critical" below CRITICAL_BELOW.
 */
export const DISPLAY_BANDS = { critical: 1.2, warning: 1.5 } as const;
export const BUFFER_ZONE_UPPER = 1.3;

export const STATUS_RANK: Record<AccountStatus, number> = {
  incomplete: 0,
  liquidatable: 1,
  critical: 2,
  warning: 3,
  healthy: 4,
  nodebt: 5,
  empty: 6,
};

const HEALTH_BANDS: Array<Omit<Band, "count" | "debtUsd" | "collateralUsd"> & { test: (h: number) => boolean }> = [
  { key: "lt1", label: "< 1.0", tone: "danger", test: (h) => h < 1.0 },
  { key: "1-1.1", label: "1.0–1.1", tone: "danger", test: (h) => h >= 1.0 && h <= LIQUIDATION_LINE },
  { key: "1.1-1.3", label: "1.1–1.3", tone: "critical", test: (h) => h > LIQUIDATION_LINE && h <= 1.3 },
  { key: "1.3-1.5", label: "1.3–1.5", tone: "warn", test: (h) => h > 1.3 && h < DISPLAY_BANDS.warning },
  { key: "1.5-2", label: "1.5–2.0", tone: "ok", test: (h) => h >= DISPLAY_BANDS.warning && h < 2 },
  { key: "2-5", label: "2.0–5.0", tone: "ok", test: (h) => h >= 2 && h < 5 },
  { key: "gt5", label: "> 5.0", tone: "ok", test: (h) => h >= 5 },
];

const LEVERAGE_BINS: Array<{ key: string; label: string; lo: number; hi: number }> = [
  { key: "1-1.25", label: "1–1.25×", lo: 1, hi: 1.25 },
  { key: "1.25-1.5", label: "1.25–1.5×", lo: 1.25, hi: 1.5 },
  { key: "1.5-2", label: "1.5–2×", lo: 1.5, hi: 2 },
  { key: "2-3", label: "2–3×", lo: 2, hi: 3 },
  { key: "3-5", label: "3–5×", lo: 3, hi: 5 },
  { key: "5-8", label: "5–8×", lo: 5, hi: 8 },
  { key: "8+", label: "8×+", lo: 8, hi: Infinity },
];

export const HEALTH_BAND_LABELS = HEALTH_BANDS.map((b) => ({ key: b.key, label: b.label, tone: b.tone }));

/** True when a row's health factor falls in the named health band (for table filtering from the chart). */
export function inBand(row: AccountRow, key: string): boolean {
  const band = HEALTH_BANDS.find((b) => b.key === key);
  return !!band && row.healthFactor !== null && band.test(row.healthFactor);
}

/** Status from the account's exact totals. `liquidatable` comes from the program's own wad comparison. */
export function classify(input: { valued: boolean; collateralUsd: number | null; debtUsd: number | null; healthFactor: number | null; liquidatable: boolean }): AccountStatus {
  if (!input.valued || input.collateralUsd === null || input.debtUsd === null) return "incomplete";
  if (input.collateralUsd === 0 && input.debtUsd === 0) return "empty";
  if (input.debtUsd === 0) return "nodebt";
  if (input.liquidatable) return "liquidatable";
  const hf = input.healthFactor ?? Infinity;
  return hf <= DISPLAY_BANDS.critical ? "critical" : hf < DISPLAY_BANDS.warning ? "warning" : "healthy";
}

/** Derived figures for a valued account (null for the unvalued). */
export function derivedFigures(collateralUsd: number, debtUsd: number) {
  const equityUsd = collateralUsd - debtUsd;
  return {
    equityUsd,
    healthFactor: debtUsd > 0 ? collateralUsd / debtUsd : null,
    leverage: equityUsd > 0 ? collateralUsd / equityUsd : null,
    // Collateral value that can disappear (debt held constant) before the liquidation line.
    bufferPct: debtUsd > 0 ? Math.max(0, 1 - (LIQUIDATION_LINE * debtUsd) / collateralUsd) : null,
    bufferUsd: debtUsd > 0 ? collateralUsd - LIQUIDATION_LINE * debtUsd : null,
  };
}

const sum = <T,>(list: T[], f: (x: T) => number) => list.reduce((s, x) => s + f(x), 0);
const valuedRows = (rows: AccountRow[]) => rows.filter((r) => r.valued && r.collateralUsd !== null && r.debtUsd !== null);

export function summarize(rows: AccountRow[]): AccountsSummary {
  const valued = valuedRows(rows);
  const borrowers = valued.filter((r) => (r.debtUsd ?? 0) > 0);
  const debtTotal = sum(borrowers, (r) => r.debtUsd ?? 0);
  const liquidatable = borrowers.filter((r) => r.liquidatable);
  const atRisk = borrowers.filter((r) => (r.healthFactor ?? Infinity) < DISPLAY_BANDS.warning);
  const withLeverage = borrowers.filter((r) => r.leverage !== null);
  const levDebt = sum(withLeverage, (r) => r.debtUsd ?? 0);

  const healthBands: Band[] = HEALTH_BANDS.map((b) => {
    const list = borrowers.filter((r) => r.healthFactor !== null && b.test(r.healthFactor));
    return { key: b.key, label: b.label, tone: b.tone, count: list.length, debtUsd: sum(list, (r) => r.debtUsd ?? 0), collateralUsd: sum(list, (r) => r.collateralUsd ?? 0) };
  });
  const leverageBins: LeverageBin[] = LEVERAGE_BINS.map((b) => {
    const list = withLeverage.filter((r) => (r.leverage as number) >= b.lo && (r.leverage as number) < b.hi);
    return { key: b.key, label: b.label, count: list.length, debtUsd: sum(list, (r) => r.debtUsd ?? 0) };
  });

  const shares = [...borrowers].sort((a, b) => (b.debtUsd ?? 0) - (a.debtUsd ?? 0)).map((r) => (debtTotal > 0 ? (r.debtUsd ?? 0) / debtTotal : 0));

  const collateralBy = new Map<string, AssetTotal>();
  const debtBy = new Map<string, AssetTotal>();
  const blank = (symbol: string, kind: AssetTotal["kind"], underlying: string): AssetTotal => ({ symbol, kind, underlying, amount: 0, usd: 0, accounts: 0, amountAll: 0, accountsAll: 0 });
  // Token UNITS are counted over every account (a balance needs no price); USD only over valued ones.
  for (const r of rows) {
    for (const l of r.collateral) {
      const e = collateralBy.get(l.symbol) ?? blank(l.symbol, l.kind, l.underlying);
      e.amountAll += l.amount; e.accountsAll += 1;
      if (r.valued) { e.amount += l.amount; e.usd += l.usd; e.accounts += 1; }
      collateralBy.set(l.symbol, e);
    }
    for (const l of r.debts) {
      const e = debtBy.get(l.symbol) ?? blank(l.symbol, "debt", l.symbol);
      e.amountAll += l.amount; e.accountsAll += 1;
      if (r.valued) { e.amount += l.amount; e.usd += l.usd; e.accounts += 1; }
      debtBy.set(l.symbol, e);
    }
  }
  const statusCounts = { incomplete: 0, empty: 0, nodebt: 0, healthy: 0, warning: 0, critical: 0, liquidatable: 0 } as Record<AccountStatus, number>;
  for (const r of rows) statusCounts[r.status] += 1;

  const collateralUsd = sum(valued, (r) => r.collateralUsd ?? 0);
  const debtUsd = sum(valued, (r) => r.debtUsd ?? 0);
  return {
    total: rows.length,
    valued: valued.length,
    incomplete: rows.length - valued.length,
    borrowers: borrowers.length,
    collateralUsd,
    debtUsd,
    equityUsd: collateralUsd - debtUsd,
    liquidatableCount: liquidatable.length,
    liquidatableDebtUsd: sum(liquidatable, (r) => r.debtUsd ?? 0),
    liquidatableCollateralUsd: sum(liquidatable, (r) => r.collateralUsd ?? 0),
    atRiskCount: atRisk.length,
    atRiskDebtUsd: sum(atRisk, (r) => r.debtUsd ?? 0),
    atRiskCollateralUsd: sum(atRisk, (r) => r.collateralUsd ?? 0),
    badDebtUsd: sum(valued, (r) => Math.max((r.debtUsd ?? 0) - (r.collateralUsd ?? 0), 0)),
    underwaterCount: valued.filter((r) => (r.debtUsd ?? 0) > (r.collateralUsd ?? 0)).length,
    averageHealth: debtTotal > 0 ? sum(borrowers, (r) => r.collateralUsd ?? 0) / debtTotal : null,
    averageLeverage: levDebt > 0 ? sum(withLeverage, (r) => (r.leverage as number) * (r.debtUsd ?? 0)) / levDebt : null,
    bufferZoneDebtUsd: sum(borrowers.filter((r) => (r.healthFactor as number) > LIQUIDATION_LINE && (r.healthFactor as number) <= BUFFER_ZONE_UPPER), (r) => r.debtUsd ?? 0),
    healthBands,
    leverageBins,
    composition: {
      direct: sum(valued, (r) => r.composition.direct),
      receipt: sum(valued, (r) => r.composition.receipt),
      venue: sum(valued, (r) => r.composition.venue),
    },
    concentration: {
      top1: shares[0] ?? null,
      top3: shares.length ? shares.slice(0, 3).reduce((s, x) => s + x, 0) : null,
      hhi: shares.length ? shares.reduce((s, x) => s + x * x, 0) * 10000 : null,
    },
    collateralBy: [...collateralBy.values()].sort((a, b) => b.usd - a.usd || b.accountsAll - a.accountsAll),
    debtBy: [...debtBy.values()].sort((a, b) => b.usd - a.usd || b.accountsAll - a.accountsAll),
    statusCounts,
  };
}

// ---- filtering / sorting (server-side paging uses the same functions) -------------------------

export function matchesFilter(row: AccountRow, filter: AccountFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "nodebt": return row.status === "nodebt" || row.status === "empty";
    case "atrisk": return row.status === "critical" || row.status === "warning";
    case "liquidatable": return row.status === "liquidatable";
    case "withdebt": return row.valued && (row.debtUsd ?? 0) > 0;
    case "healthy": return row.status === "healthy";
    case "incomplete": return row.status === "incomplete";
  }
}

/** The number an account is sorted on, or null when it has none (no debt, or not valued). */
const SORT_VALUE: Record<AccountSortKey, (r: AccountRow) => number | null> = {
  health: (r) => r.healthFactor,
  debt: (r) => r.debtUsd,
  collateral: (r) => r.collateralUsd,
  equity: (r) => r.equityUsd,
  leverage: (r) => r.leverage,
  buffer: (r) => r.bufferPct,
  status: (r) => STATUS_RANK[r.status],
};

/**
 * Accounts with a value come first in the chosen direction. Accounts without one always come after them in
 * either direction: valued ones with nothing to show (no debt) first, then accounts that could not be valued.
 */
export function sortRows(rows: AccountRow[], key: AccountSortKey, dir: 1 | -1): AccountRow[] {
  const f = SORT_VALUE[key] ?? SORT_VALUE.health;
  const group = (r: AccountRow) => (f(r) !== null ? 0 : r.status === "incomplete" ? 2 : 1);
  return [...rows].sort((a, b) => {
    const g = group(a) - group(b);
    if (g) return g;
    const d = group(a) === 0 ? ((f(a) as number) - (f(b) as number)) * dir : 0;
    return d || a.owner.localeCompare(b.owner);
  });
}

export function searchRows(rows: AccountRow[], query: string): AccountRow[] {
  const q = query.trim().toLowerCase();
  return q ? rows.filter((r) => `${r.owner} ${r.address}`.toLowerCase().includes(q)) : rows;
}

/** True when every reason an account could not be valued is about prices. */
export const onlyPriceReasons = (row: { reasons: Array<{ code: string }> }) =>
  row.reasons.length > 0 && row.reasons.every((r) => r.code === "missing_price");

/** The label shown for one account: an unvalued account says WHY (price vs. something the dashboard cannot read). */
export const statusLabelOf = (row: { status: AccountStatus; reasons: Array<{ code: string }> }): string =>
  row.status === "incomplete" ? (onlyPriceReasons(row) ? "No price" : "Can't read") : STATUS_LABEL[row.status];

/** Plain-language account status labels (the UI owns wording; this is the single mapping). */
export const STATUS_LABEL: Record<AccountStatus, string> = {
  incomplete: "Not valued",
  empty: "No debt",
  nodebt: "No debt",
  healthy: "Safe",
  warning: "At risk",
  critical: "At risk",
  liquidatable: "Liquidatable",
};

/** Where an account's collateral is deployed (from its composition). */
export function protocolsOf(row: AccountRow): string[] {
  const out: string[] = [];
  if (row.composition.receipt > 0) out.push("Kamino");
  if (row.composition.venue > 0 || row.venueHeld) out.push("Phoenix perps");
  if (row.composition.direct > 0) out.push("Held in account");
  return out;
}

export interface LiquidationPrice {
  symbol: string;
  /** "down": the account is liquidated if this asset FALLS to `price`; "up": if it RISES (it is net debt). */
  direction: "down" | "up";
  price: number;
  /** Fractional change from the current price (−0.25 = −25%). */
  change: number;
}

/**
 * Per-asset liquidation price, CALCULATED from the account's own lines: the price at which health
 * reaches the liquidation line if only that asset moves and everything else (including a Phoenix
 * lump value) stays put. Null when no single-asset move gets there. A calculation, not a forecast.
 */
export function liquidationPrices(row: AccountRow, prices: Record<string, number | null | undefined>): LiquidationPrice[] {
  if (!row.valued || row.collateralUsd === null || row.debtUsd === null || row.debtUsd <= 0 || row.liquidatable) return [];
  const L = LIQUIDATION_LINE;
  const symbols = [...new Set([...row.collateral.filter((l) => l.kind !== "venue").map((l) => l.underlying), ...row.debts.map((d) => d.symbol)])];
  const out: LiquidationPrice[] = [];
  for (const s of symbols) {
    const price = prices[s];
    if (!price || price <= 0) continue;
    const Cs = row.collateral.filter((l) => l.kind !== "venue" && l.underlying === s).reduce((a, l) => a + l.usd, 0);
    const Ds = row.debts.filter((d) => d.symbol === s).reduce((a, d) => a + d.usd, 0);
    const denom = Cs - L * Ds;
    if (Math.abs(denom) < 1e-12) continue;
    const f = (L * (row.debtUsd - Ds) - (row.collateralUsd - Cs)) / denom;
    if (!(f > 0)) continue;
    if (denom > 0 && f < 1) out.push({ symbol: s, direction: "down", price: price * f, change: f - 1 });
    if (denom < 0 && f > 1) out.push({ symbol: s, direction: "up", price: price * f, change: f - 1 });
  }
  return out.sort((a, b) => Math.abs(a.change) - Math.abs(b.change));
}

/** Where one account stands among all the accounts the dashboard has valued. */
export interface Standing {
  /** 1 = owes the most. Null when the account has no debt or is not valued. */
  debtRank: number | null;
  /** Accounts with debt (the denominator for the debt rank). */
  borrowers: number;
  /** Share of all debt this account owes (0..1), or null. */
  debtShare: number | null;
  /** 1 = closest to liquidation among accounts with debt. Null without debt. */
  healthRank: number | null;
  /** All accounts found, valued or not. */
  accounts: number;
}

export function standingOf(rows: AccountRow[], row: AccountRow): Standing {
  const borrowers = rows.filter((r) => r.valued && (r.debtUsd ?? 0) > 0);
  const mine = row.valued && (row.debtUsd ?? 0) > 0;
  const totalDebt = borrowers.reduce((a, r) => a + (r.debtUsd ?? 0), 0);
  return {
    debtRank: mine ? 1 + borrowers.filter((r) => (r.debtUsd ?? 0) > (row.debtUsd ?? 0)).length : null,
    borrowers: borrowers.length,
    debtShare: mine && totalDebt > 0 ? (row.debtUsd ?? 0) / totalDebt : null,
    healthRank: mine && row.healthFactor !== null ? 1 + borrowers.filter((r) => (r.healthFactor ?? Infinity) < (row.healthFactor ?? Infinity)).length : null,
    accounts: rows.length,
  };
}
