"use client";

/**
 * Prediction Vaults: every Predict outcome pool and where its money sits after users buy YES / NO.
 * Each pool holds the YES and NO shares deposited into it; matched pairs (one YES + one NO = $1) are
 * merged into CASH, swapped to USDC and supplied to Vanna's USDC lending pool, where they earn.
 * Shows the totals, the split (in Vanna / waiting to merge / unmatched) and one row per pool.
 * Read-only: GET /api/analytics/predict-pools (live chain reads, nothing stored).
 */
import { useState } from "react";
import Link from "next/link";
import { useAnalyticsPredictPools, useAnalyticsProtocol } from "@/hooks/use-analytics";
import { poolRows } from "@/lib/analytics/pools";
import { num, pct, usd, usdC } from "@/lib/analytics/format";
import type { PredictPoolRow, PredictPoolStatus } from "@/lib/predict/pool-analytics.server";
import { Badge, Empty, Kpi, Notice, Panel, type Tone } from "../ui";
import { ViewHead } from "../shell";
import { HBars, Legend, SERIES } from "../charts";

const STATUS: Record<PredictPoolStatus, { label: string; tone: Tone; tip: string }> = {
  earning: { label: "Earning", tone: "ok", tip: "Its matched pairs are in Vanna's USDC pool, earning the pool's supply rate." },
  "merge-pending": { label: "Merge pending", tone: "accent", tip: "Matched YES + NO pairs are waiting for the keeper to merge them into Vanna's USDC pool." },
  "cannot-merge": { label: "Can't merge yet", tone: "warn", tip: "This market is part of a World Group, whose outcomes share one Group-owned CASH vault. The pool can't merge its pairs there yet, so they stay in the pool and don't earn." },
  "one-sided": { label: "Waiting for other side", tone: "neutral", tip: "The pool holds only YES or only NO: nothing to pair until the other side is bought." },
  empty: { label: "Empty", tone: "neutral", tip: "Pool created, nothing deposited yet." },
};

type Filter = "funded" | "all" | PredictPoolStatus;
const FILTERS: [Filter, string][] = [
  ["funded", "With funds"],
  ["earning", "Earning"],
  ["merge-pending", "Merge pending"],
  ["cannot-merge", "Can't merge"],
  ["all", "All pools"],
];

const shares = (v: number) => `${num(v, 2)}`;

export function PredictionVaultsView() {
  const { data, isError } = useAnalyticsPredictPools();
  const { data: protocol } = useAnalyticsProtocol();
  const [filter, setFilter] = useState<Filter>("funded");
  const t = data?.totals;
  const usdcPool = poolRows(protocol).find((r) => r.symbol === "USDC");
  const usdcSupplied = usdcPool?.usdSupplied ?? null;
  const share = t && usdcSupplied ? t.usdcInVanna / usdcSupplied : null;
  const unmatchedYes = t ? t.yes - t.pairs : 0;
  const unmatchedNo = t ? t.no - t.pairs : 0;
  const pairsMergeable = t ? t.pairs - t.pairsBlocked : 0;

  const rows = (data?.pools ?? []).filter((r) => (filter === "all" ? true : filter === "funded" ? r.status !== "empty" : r.status === filter));
  const count = (f: Filter) => (data?.pools ?? []).filter((r) => (f === "all" ? true : f === "funded" ? r.status !== "empty" : r.status === f)).length;

  // Where the money is, in dollars: each matched pair is worth $1 of CASH; unmatched shares are not
  // worth a fixed amount until the event resolves, so they're shown as share counts, not in this bar.
  const split = t
    ? [
        {
          key: "money",
          name: "Prediction money",
          segments: [
            { value: t.usdcInVanna, color: SERIES[1], tip: `In Vanna's USDC pool ${usd(t.usdcInVanna)}` },
            { value: pairsMergeable, color: SERIES[0], tip: `Waiting to merge ${usd(pairsMergeable)}` },
            { value: t.pairsBlocked, color: SERIES[3], tip: `Can't merge yet (World Group markets) ${usd(t.pairsBlocked)}` },
          ],
          valueText: usdC(t.usdcInVanna + t.pairs),
        },
      ]
    : [];

  return (
    <>
      <ViewHead title="Prediction Vaults" blurb="Every Predict pool: what users' YES and NO shares hold, and how much has gone into Vanna's USDC pool." />
      <div className="an-kpi-grid an-cols-5">
        <Kpi label="In Vanna's USDC pool" value={t ? usd(t.usdcInVanna) : usd(0)} na={!t} accent
          sub={share !== null ? `${pct(share)} of the USDC pool's ${usdC(usdcSupplied)}` : "Merged pairs, supplied as USDC"} />
        <Kpi label="Waiting to merge" value={t ? usd(t.pairs) : usd(0)} na={!t} tone={t && t.pairsBlocked > 0 ? "warn" : ""}
          sub={t ? `${num(t.pairs, 2)} matched pairs · ${usd(t.pairsBlocked)} can't merge yet` : "Matched YES + NO pairs"} />
        <Kpi label="YES shares in pools" value={t ? shares(t.yes) : "0"} na={!t} sub={t ? `${shares(unmatchedYes)} without a NO to pair` : "Deposited YES"} />
        <Kpi label="NO shares in pools" value={t ? shares(t.no) : "0"} na={!t} sub={t ? `${shares(unmatchedNo)} without a YES to pair` : "Deposited NO"} />
        <Kpi label="Pools" value={t ? String(t.pools) : "0"} na={!t}
          sub={t ? `${t.withFunds} with funds · ${t.mergeablePools} can merge, ${t.groupPools} can't yet` : "Created by the outcome pool program"} />
      </div>

      {!data ? (
        <Empty title={isError ? "Couldn't load prediction pools" : "Loading prediction pools…"} icon="pools" />
      ) : (
        <>
          <Panel title="Where prediction money sits" sub="Matched pairs are worth $1 each. Unmatched shares aren't included: their value depends on the result.">
            {t && t.usdcInVanna + t.pairs > 0 ? (
              <>
                <HBars rows={split} />
                <div className="an-mt">
                  <Legend items={[{ label: "In Vanna's USDC pool", color: SERIES[1] }, { label: "Waiting to merge", color: SERIES[0] }, { label: "Can't merge yet (World Group)", color: SERIES[3] }]} />
                </div>
              </>
            ) : (
              <Notice>No matched pairs yet: buying YES and NO on the same market creates them.</Notice>
            )}
            {t && t.pairsBlocked > 0 && (
              <p className="an-panel-foot">
                {usd(t.pairsBlocked)} of matched pairs sit in World Group markets, whose outcomes share one Group-owned CASH vault. The pool can&apos;t merge them yet, so they don&apos;t earn.
              </p>
            )}
          </Panel>

          <section className="an-panel an-flush">
            <div className="an-panel-head">
              <div>
                <h2 className="an-panel-title">Pools</h2>
                <p className="an-panel-sub">One pool per outcome market · shares are in outcome tokens, USDC in dollars</p>
              </div>
              <div className="an-seg" role="group" aria-label="Filter pools">
                {FILTERS.map(([k, l]) => (
                  <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                    {l} <span className="an-muted">{count(k)}</span>
                  </button>
                ))}
              </div>
            </div>
            {!rows.length ? (
              <Empty title="No pools here" text="Try another filter." icon="pools" />
            ) : (
              <div className="an-table-wrap">
                <table className="an-t">
                  <thead>
                    <tr>
                      <th>Market</th>
                      <th className="an-r">YES in pool</th>
                      <th className="an-r">NO in pool</th>
                      <th className="an-r">Matched pairs</th>
                      <th className="an-r">In Vanna USDC pool</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r: PredictPoolRow) => (
                      <tr key={r.marketId}>
                        <td>
                          <Link href={r.href} className="an-strong">{r.outcome || r.event}</Link>
                          <small>{r.outcome ? r.event : ""}{!r.listed ? `${r.outcome ? " · " : ""}not listed on Predict` : ""}</small>
                        </td>
                        <td className="an-r"><b>{shares(r.yes)}</b><small>{r.yes > r.pairs ? `${shares(r.yes - r.pairs)} unmatched` : "all matched"}</small></td>
                        <td className="an-r"><b>{shares(r.no)}</b><small>{r.no > r.pairs ? `${shares(r.no - r.pairs)} unmatched` : "all matched"}</small></td>
                        <td className="an-r"><b>{shares(r.pairs)}</b><small>{usd(r.pairs)}</small></td>
                        <td className="an-r"><b>{usd(r.usdcInVanna)}</b><small>{r.mergeable ? "Can merge" : "Can't merge yet"}</small></td>
                        <td><span title={STATUS[r.status].tip}><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge></span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
