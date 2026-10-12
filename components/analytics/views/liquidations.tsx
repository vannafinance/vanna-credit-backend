"use client";

/** Liquidations: who can be liquidated now, how close others are, what has been liquidated, and the settings behind it. */
import { useAnalyticsAccounts, useAnalyticsEvents, useAnalyticsProtocol, useAnalyticsSummary } from "@/hooks/use-analytics";
import { LIQUIDATION_LINE } from "@/lib/analytics/risk";
import { hfText, pct, pct1, short, usd } from "@/lib/analytics/format";
import { AccountsMonitor } from "../accounts-monitor";
import { HBars, Legend, StackBar, TONE_VAR } from "../charts";
import Link from "next/link";
import { Empty, Kpi, Notice, Panel, Addr, ForkTime, YouPill } from "../ui";
import { ViewHead } from "../shell";

const WAIT = "Waiting for accounts";

/** "5.0% for 15 assets, 7.0% for NVDAx, TSLAx" - assets grouped by their on-chain liquidator bonus. */
const bonusGroups = (assets: Array<{ symbol: string; liquidationBonusBps: number }>) => {
  const by = new Map<number, string[]>();
  for (const a of assets) by.set(a.liquidationBonusBps, [...(by.get(a.liquidationBonusBps) ?? []), a.symbol]);
  return [...by.entries()].map(([bps, syms]) => `${pct(bps / 10000, 1)} for ${syms.length > 4 ? `${syms.length} assets` : syms.join(", ")}`).join(" · ");
};

function Closest() {
  const { data } = useAnalyticsAccounts({ filter: "withdebt", sort: "buffer", dir: "asc", q: "", page: 1, per: 6, band: null, you: null });
  const rows = data?.rows ?? [];
  return (
    <Panel title="Closest to being liquidated" sub="Accounts with debt, riskiest first · a longer bar means more room" tip="buffer">
      {rows.length === 0 ? <Empty title="No account has debt" text="Nothing to rank yet." /> : (
        <HBars rows={rows.map((r) => ({
          key: r.address,
          name: <span title={r.owner}>{short(r.owner, 4, 4)}<YouPill value={r.owner} /></span>,
          segments: [{ value: r.bufferPct ?? 0, color: r.liquidatable ? TONE_VAR.danger : r.status === "healthy" ? TONE_VAR.ok : TONE_VAR.warn, tip: `Can lose ${pct1(r.bufferPct)} of its collateral value (${usd(r.bufferUsd)}) before liquidation\nHealth ${hfText(r.healthFactor)}` }],
          valueText: `Health ${hfText(r.healthFactor)}`,
        }))} />
      )}
    </Panel>
  );
}

export function LiquidationsView() {
  const { data: sum } = useAnalyticsSummary();
  const { data: protocol } = useAnalyticsProtocol();
  const { data: ev } = useAnalyticsEvents(["Liquidated"], 25);
  const s = sum?.summary ?? null;
  const ok = !!s && s.valued > 0;
  const liquidated = ev?.events ?? [];
  const rest = ok ? Math.max(0, s!.debtUsd - s!.liquidatableDebtUsd - s!.bufferZoneDebtUsd) : 0;
  const segs = ok ? [
    { label: "Can be liquidated", value: s!.liquidatableDebtUsd, color: "var(--danger-bar)", tip: `Can be liquidated\n${usd(s!.liquidatableDebtUsd)}` },
    { label: `Close to the line (${LIQUIDATION_LINE.toFixed(2)}–1.30)`, value: s!.bufferZoneDebtUsd, color: "var(--warn-bar)", tip: `Health ${LIQUIDATION_LINE.toFixed(2)}–1.30\n${usd(s!.bufferZoneDebtUsd)}` },
    { label: "Safe", value: rest, color: "var(--ok-bar)", tip: `Health above 1.30\n${usd(rest)}` },
  ] : [];

  return (
    <>
      <ViewHead title="Liquidations" blurb="Who can be liquidated now, how close others are, and what has been liquidated." />
      <div className="an-kpi-grid">
        <Kpi label="Can be liquidated now" tip="liquidatable" value={ok ? String(s!.liquidatableCount) : "-"} na={!ok} tone={ok && s!.liquidatableCount ? "danger" : ""} sub={ok ? `Out of ${s!.valued} accounts` : WAIT} />
        <Kpi label="Liquidatable debt" tip="eligibleDebt" value={ok ? usd(s!.liquidatableDebtUsd) : "-"} na={!ok} sub={ok ? `Backed by ${usd(s!.liquidatableCollateralUsd)} of collateral` : WAIT} />
        <Kpi label="Bad debt (estimated)" tip="shortfall" value={ok ? usd(s!.badDebtUsd) : "-"} na={!ok} tone={ok && s!.badDebtUsd > 0 ? "danger" : ""} sub={ok ? `${s!.underwaterCount} account${s!.underwaterCount === 1 ? " owes" : "s owe"} more than ${s!.underwaterCount === 1 ? "it holds" : "they hold"}` : WAIT} />
        <Kpi label="Liquidations recorded" tip="coverage" value={ev ? String(ev.counts.Liquidated ?? 0) : "-"} na={!ev}
          sub={ev?.coverage ? `In the last ${ev.coverage.transactionsScanned} program transactions` : "In recent activity"} />
      </div>

      {ok && s!.liquidatableCount > 0
        ? <AccountsMonitor band={null} onClearBand={() => undefined} title="Accounts that can be liquidated" fixedFilter="liquidatable" />
        : <Panel title="Accounts that can be liquidated">{ok ? <Notice>No account can be liquidated right now. {s!.borrowers} of {s!.valued} accounts have debt, and all are above the liquidation line.</Notice> : <Empty title={WAIT} />}</Panel>}

      <div className="an-grid-2" style={{ alignItems: "start" }}>
        <Closest />
        <Panel title="Debt by risk" sub="How much debt sits close to liquidation" tip="shortfall">
          {!ok ? <Empty title={WAIT} text="This appears once accounts have been found and valued." />
            : s!.debtUsd > 0 ? <><StackBar segments={segs} tall /><div className="an-mt"><Legend items={segs.map((x) => ({ label: `${x.label} · ${usd(x.value)}`, color: x.color }))} /></div></>
            : <Notice><strong>No outstanding debt</strong> among the accounts found.</Notice>}
        </Panel>
      </div>

      <Panel title="Past liquidations" sub={ev?.coverage ? `Recorded in the last ${ev.coverage.transactionsScanned} program transactions · older history is not covered` : "Recorded in recent activity"} flush>
        {liquidated.length ? (
          <div className="an-table-wrap"><table className="an-t">
            <thead><tr><th>When</th><th>Account</th><th>Liquidator</th><th className="an-r">Debt repaid</th><th className="an-r">Collateral</th><th className="an-r">Health at the time</th><th>Transaction</th></tr></thead>
            <tbody>{liquidated.map((e) => (
              <tr key={e.id}>
                <td className="an-nowrap"><ForkTime t={e.time} /></td>
                <td title={e.marginAccount ?? ""}>{short(e.marginAccount, 5, 5)}<YouPill value={e.marginAccount} /></td>
                <td>{e.actor ? <><Addr value={e.actor} /><YouPill value={e.actor} /></> : "-"}</td>
                <td className="an-r">{usd(e.debtValueUsd)}</td><td className="an-r">{usd(e.collateralValueUsd)}</td><td className="an-r">{hfText(e.healthFactor)}</td>
                <td><Addr value={e.signature} /></td>
              </tr>
            ))}</tbody></table></div>
        ) : <Empty title={ev ? "No liquidations in recent activity" : "Loading…"} text={ev ? "None of the transactions read so far was a liquidation. Older history is not covered." : "Recent transactions are still being read."} />}
      </Panel>

      <Panel title="Liquidation settings" sub={`An account can be liquidated when its health is ${LIQUIDATION_LINE.toFixed(2)} or lower`} tip="liqBonus">
        {protocol?.assets?.length ? (
          <p className="an-panel-foot" style={{ padding: 0, margin: 0 }}>
            Liquidator bonus: {bonusGroups(protocol.assets)}. <Link href="/analytics/collateral">See every asset&apos;s settings</Link>
          </p>
        ) : <Empty title="Loading settings…" text="Read from the chain." />}
      </Panel>
    </>
  );
}
