/**
 * Alerts derived live from data the dashboard already has — nothing stored, nothing simulated, and no
 * notification channels (there is no delivery integration, so none is claimed).
 *
 * Priorities: P0 act now · P1 critical · P2 warning · P3 for information.
 */
import { DISPLAY_BANDS, LIQUIDATION_LINE } from "./risk";
import { usd } from "./format";
import type { AccountView, AccountsSummary, Coverage } from "./types";
import type { ProtocolOverview } from "./server/store";

export type Priority = "P0" | "P1" | "P2" | "P3";
export interface Alert { id: string; priority: Priority; title: string; detail: string; metric: string; link?: string; yours?: boolean }

export const UTILIZATION_WARN = 0.85;
export const UTILIZATION_CRITICAL = 0.95;

export function deriveAlerts(input: {
  summary: AccountsSummary | null;
  protocol: ProtocolOverview | undefined;
  you: AccountView | null;
  coverage: Coverage | null;
  serviceError: boolean;
}): Alert[] {
  const out: Alert[] = [];
  const { summary: s, protocol: p, you, coverage } = input;

  if (input.serviceError) out.push({ id: "service", priority: "P1", title: "The analytics service can't be reached", detail: "Numbers on this page may be out of date until it is back.", metric: "Service" });

  if (you) {
    if (!you.valued) out.push({ id: "you-unvalued", priority: "P2", yours: true, title: "Your account can't be valued right now", detail: "A price it depends on hasn't been updated recently.", metric: "Your account", link: "/analytics" });
    else if (you.liquidatable) out.push({ id: "you-liq", priority: "P0", yours: true, title: "Your account can be liquidated now", detail: `Health ${you.healthFactor?.toFixed(2)} is at or below the liquidation line (${LIQUIDATION_LINE.toFixed(2)}).`, metric: "Health", link: "/analytics" });
    else if (you.healthFactor !== null && you.healthFactor < 1.2) out.push({ id: "you-crit", priority: "P1", yours: true, title: "Your account is close to liquidation", detail: `Health ${you.healthFactor.toFixed(2)} — the liquidation line is ${LIQUIDATION_LINE.toFixed(2)}.`, metric: "Health", link: "/analytics" });
    else if (you.healthFactor !== null && you.healthFactor < DISPLAY_BANDS.warning) out.push({ id: "you-warn", priority: "P2", yours: true, title: "Your account health is getting low", detail: `Health ${you.healthFactor.toFixed(2)} (below ${DISPLAY_BANDS.warning.toFixed(2)}).`, metric: "Health", link: "/analytics" });
  }

  if (s && s.valued > 0) {
    if (s.liquidatableCount > 0) out.push({ id: "liq", priority: "P1", title: `${s.liquidatableCount} account${s.liquidatableCount === 1 ? "" : "s"} can be liquidated now`, detail: `${usd(s.liquidatableDebtUsd)} of debt is backed by ${usd(s.liquidatableCollateralUsd)} of collateral.`, metric: "Liquidations", link: "/analytics/liquidations" });
    if (s.badDebtUsd > 0) out.push({ id: "bad", priority: "P1", title: "Some debt is no longer covered by collateral", detail: `${usd(s.badDebtUsd)} estimated across ${s.underwaterCount} account${s.underwaterCount === 1 ? "" : "s"}.`, metric: "Bad debt", link: "/analytics/liquidations" });
    const warnOnly = s.atRiskCount - s.liquidatableCount;
    if (warnOnly > 0) out.push({ id: "risk", priority: "P2", title: `${warnOnly} more account${warnOnly === 1 ? " is" : "s are"} close to the liquidation line`, detail: `Health is under ${DISPLAY_BANDS.warning.toFixed(2)}; ${usd(s.atRiskCollateralUsd - s.liquidatableCollateralUsd)} of collateral.`, metric: "Accounts at risk", link: "/analytics" });
  }
  if (s && s.incomplete > 0) out.push({ id: "unvalued", priority: "P3", title: `${s.incomplete} account${s.incomplete === 1 ? " is" : "s are"} not valued`, detail: "They are left out of the totals (a price they need has not updated, or they use something this dashboard cannot read yet).", metric: "Accounts", link: "/analytics" });

  if (p) {
    const old = Object.entries(p.prices).filter(([, v]) => v.stale && v.usd !== null);
    const lending = Object.values(p.pools).filter((x) => x.initialised).map((x) => x.symbol);
    const lendingOld = old.filter(([sym]) => lending.includes(sym));
    if (lendingOld.length) out.push({ id: "prices-lend", priority: "P1", title: `Prices not updated: ${lendingOld.map(([k]) => k).join(", ")}`, detail: "Lending pool assets can't be valued, and the program rejects borrows and withdrawals that need these prices.", metric: "Prices", link: "/analytics/prices" });
    const rest = old.filter(([sym]) => !lending.includes(sym));
    if (rest.length) out.push({ id: "prices-other", priority: "P2", title: `Prices not updated: ${rest.map(([k]) => k).join(", ")}`, detail: "Accounts holding these can't be valued until they update.", metric: "Prices", link: "/analytics/prices" });
    for (const pool of Object.values(p.pools).filter((x) => x.initialised)) {
      if (pool.utilization >= UTILIZATION_CRITICAL) out.push({ id: `util-${pool.symbol}`, priority: "P1", title: `${pool.symbol} pool is almost fully borrowed`, detail: `${(pool.utilization * 100).toFixed(1)}% utilization — little cash is left to withdraw.`, metric: "Utilization", link: "/analytics/pools" });
      else if (pool.utilization >= UTILIZATION_WARN) out.push({ id: `util-${pool.symbol}`, priority: "P2", title: `${pool.symbol} pool utilization is high`, detail: `${(pool.utilization * 100).toFixed(1)}% of the pool is borrowed.`, metric: "Utilization", link: "/analytics/pools" });
    }
  }
  if (coverage && !coverage.complete) out.push({ id: "scan", priority: "P3", title: "Still looking for accounts", detail: `${coverage.accountsFound} found so far; ${coverage.transactionsPending} older transactions left to read.`, metric: "Coverage" });

  const rank: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}
