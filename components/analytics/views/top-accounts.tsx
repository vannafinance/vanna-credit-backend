"use client";

/** Top accounts: how concentrated the debt is, the largest borrowers, and a feed of recent activity. */
import { useState } from "react";
import { useAnalyticsAccounts, useAnalyticsEvents, useAnalyticsSummary } from "@/hooks/use-analytics";
import { hfText, levText, num, pct1, short, usd } from "@/lib/analytics/format";
import type { ProgramEvent } from "@/lib/analytics/server/events";
import { Addr, Badge, Empty, Kpi, Panel, StatusBadge, ForkTime } from "../ui";
import { ViewHead } from "../shell";

const WAIT = "Waiting for accounts";
const FEED: Array<[string, string, string[]]> = [
  ["all", "All", ["Borrowed", "DebtRepaid", "CollateralDeposited", "CollateralWithdrawn", "MarginCreated", "Liquidated", "LiquiditySupplied", "LiquidityRedeemed"]],
  ["borrow", "Borrow & repay", ["Borrowed", "DebtRepaid"]],
  ["collateral", "Collateral", ["CollateralDeposited", "CollateralWithdrawn"]],
  ["lending", "Lending", ["LiquiditySupplied", "LiquidityRedeemed"]],
  ["accounts", "New & liquidated", ["MarginCreated", "Liquidated"]],
];
const LABEL: Record<string, string> = {
  Borrowed: "Borrowed", DebtRepaid: "Repaid debt", CollateralDeposited: "Added collateral", CollateralWithdrawn: "Withdrew collateral",
  MarginCreated: "Opened a margin account", Liquidated: "Liquidated", LiquiditySupplied: "Supplied to a pool", LiquidityRedeemed: "Withdrew from a pool",
};
const TONE: Record<string, "ok" | "warn" | "danger" | "accent" | "neutral"> = {
  Borrowed: "warn", DebtRepaid: "ok", CollateralDeposited: "ok", CollateralWithdrawn: "warn", MarginCreated: "accent", Liquidated: "danger", LiquiditySupplied: "ok", LiquidityRedeemed: "warn",
};

function detail(e: ProgramEvent): string {
  if (e.name === "Liquidated") return `Debt repaid ${usd(e.debtValueUsd)} · collateral ${usd(e.collateralValueUsd)} · health ${hfText(e.healthFactor)}`;
  if (e.amount !== null && e.symbol) return `${num(e.amount)} ${e.symbol}${e.healthFactor !== null ? ` · health after ${hfText(e.healthFactor)}` : ""}`;
  return e.healthFactor !== null ? `Health after ${hfText(e.healthFactor)}` : "";
}

export function TopAccountsView() {
  const { data: sum } = useAnalyticsSummary();
  const [page, setPage] = useState(1);
  const [feed, setFeed] = useState("all");
  const { data } = useAnalyticsAccounts({ filter: "withdebt", sort: "debt", dir: "desc", q: "", page, per: 10, band: null, you: null });
  const names = FEED.find((f) => f[0] === feed)![2];
  const { data: ev } = useAnalyticsEvents(names, 40);
  const s = sum?.summary ?? null;
  const ok = !!s && s.borrowers > 0;
  const c = s?.concentration;

  return (
    <>
      <ViewHead title="Top accounts" blurb="How concentrated the debt is, who owes the most, and what has been happening." />
      <div className="an-kpi-grid an-cols-3">
        <Kpi label="Largest borrower" value={ok && c?.top1 != null ? pct1(c.top1) : "-"} na={!ok} sub={ok ? "Share of all debt owed by one account" : WAIT} />
        <Kpi label="Top 3 borrowers" value={ok && c?.top3 != null ? pct1(c.top3) : "-"} na={!ok} sub={ok ? `${s!.borrowers} account${s!.borrowers === 1 ? "" : "s"} with debt in total` : WAIT} />
        <Kpi label="Concentration index" tip="hhi" value={ok && c?.hhi != null ? Math.round(c.hhi).toLocaleString("en-US") : "-"} na={!ok} sub={ok ? "0 = spread out · 10,000 = one borrower" : WAIT} />
      </div>

      <section className="an-panel an-flush">
        <div className="an-panel-head"><div><h2 className="an-panel-title">Largest borrowers</h2><p className="an-panel-sub">Accounts that could be valued, by debt</p></div></div>
        <div className="an-table-wrap"><table className="an-t">
          <thead><tr><th>#</th><th>Wallet</th><th className="an-r">Debt</th><th className="an-r">Share of debt</th><th className="an-r">Health</th><th className="an-r">Leverage</th><th>Status</th></tr></thead>
          <tbody>
            {(data?.rows ?? []).length ? data!.rows.map((r, i) => (
              <tr key={r.address}>
                <td className="an-muted">{(data!.page - 1) * data!.per + i + 1}</td>
                <td><Addr value={r.owner} /></td>
                <td className="an-r">{usd(r.debtUsd)}</td>
                <td className="an-r">{s && s.debtUsd > 0 ? pct1((r.debtUsd ?? 0) / s.debtUsd) : "-"}</td>
                <td className="an-r">{hfText(r.healthFactor)}</td>
                <td className="an-r">{levText(r.leverage)}</td>
                <td><StatusBadge row={r} /></td>
              </tr>
            )) : <tr><td colSpan={7}><Empty title={data ? "No account has debt" : "Loading…"} text={data ? "Borrowers appear here once an account that can be valued owes money." : undefined} /></td></tr>}
          </tbody>
        </table></div>
        {data && data.pages > 1 && (
          <div className="an-table-foot"><span>{(data.page - 1) * data.per + 1}–{Math.min(data.filteredTotal, data.page * data.per)} of {data.filteredTotal}</span>
            <span className="an-pager"><button className="an-btn an-sm" disabled={page === 1} onClick={() => setPage(page - 1)}>←</button><button className="an-btn an-sm" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>→</button></span></div>
        )}
      </section>

      <Panel title="Recent activity" sub={ev?.coverage ? `From the last ${ev.coverage.transactionsScanned} program transactions · older history is not covered` : "From recent program transactions"} tip="coverage"
        actions={<div className="an-seg" role="group" aria-label="Activity type">{FEED.map(([k, l]) => <button key={k} aria-pressed={feed === k} onClick={() => setFeed(k)}>{l}</button>)}</div>}>
        {ev?.events.length ? (
          <div className="an-feed">{ev.events.map((e) => (
            <div className="an-feed-item" key={e.id}>
              <div className={`an-feed-icon an-${TONE[e.name] ?? "neutral"}`}>{e.name === "Liquidated" ? "!" : e.name === "Borrowed" ? "↓" : e.name === "DebtRepaid" ? "↑" : "•"}</div>
              <div className="an-feed-main"><b>{LABEL[e.name] ?? e.name}</b><p>{e.marginAccount ? `Account ${short(e.marginAccount, 5, 5)}` : e.actor ? `Wallet ${short(e.actor, 5, 5)}` : ""}{detail(e) ? ` · ${detail(e)}` : ""}</p></div>
              <div className="an-feed-meta"><ForkTime t={e.time} /><br /><Badge tone={TONE[e.name] ?? "neutral"}>{LABEL[e.name] ?? e.name}</Badge></div>
            </div>
          ))}</div>
        ) : <Empty title={ev ? "No activity of this kind in recent transactions" : "Loading…"} text={ev ? "Try another type, or wait for the scan to read more transactions." : undefined} />}
      </Panel>
    </>
  );
}
