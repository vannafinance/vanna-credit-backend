"use client";

/**
 * What-if Calculator - the only place scenario controls live. Read-only: it reprices a SAVED baseline
 * of valued accounts under assumptions the user sets, on demand. It never sends a transaction, never
 * changes chain state and never asks for a wallet signature.
 */
import { useMemo, useState } from "react";
import { useAnalyticsProtocol, useScenarioBaseline } from "@/hooks/use-analytics";
import { poolRows } from "@/lib/analytics/pools";
import { simulate, simulateWithdrawal, WHATIF_MODEL, type SimulationResult } from "@/lib/analytics/whatif";
import { clock, hfText, num, pct, short, usd, usdC } from "@/lib/analytics/format";
import { reasonText } from "@/lib/analytics/reasons";
import { AssetCell, Badge, Empty, Icon, InfoTip, Notice, Panel } from "../ui";
import { ViewHead } from "../shell";

type Tab = "price" | "withdrawal";
const PRESETS = [-10, -20, -30, -50];

function Side({ label, c, d, h, e, bad, tone }: { label: string; c: number; d: number; h: number | null; e: number; bad: number; tone?: boolean }) {
  return (
    <div className={`an-side ${tone ? "an-after" : ""}`}>
      <div className="an-lbl">{label}</div>
      <div className="an-big">{h === null ? "No debt" : hfText(h)}</div>
      <div className="an-muted">average health</div>
      <dl className="an-kv an-mt"><div><dt>Collateral</dt><dd>{usd(c)}</dd></div><div><dt>Debt</dt><dd>{usd(d)}</dd></div><div><dt>Can be liquidated</dt><dd>{e} account{e === 1 ? "" : "s"}</dd></div><div><dt>Bad debt (estimated)</dt><dd>{usd(bad)}</dd></div></dl>
    </div>
  );
}

export function WhatIfView() {
  const { data, isLoading, refetch, isFetching } = useScenarioBaseline();
  const { data: protocol } = useAnalyticsProtocol();
  const baseline = data?.baseline ?? null;
  const [tab, setTab] = useState<Tab>("price");
  const [shocks, setShocks] = useState<Record<string, number>>({});
  const [result, setResult] = useState<{ run: SimulationResult; at: number; baselineAt: number } | null>(null);
  const [error, setError] = useState("");
  const [wd, setWd] = useState({ symbol: "", percent: 20 });

  // The assets present in the baseline: only these can be shocked.
  const assets = useMemo(() => {
    const set = new Set<string>();
    for (const a of baseline?.covered ?? []) { a.collateral.forEach((l) => set.add(l.underlying)); a.debts.forEach((l) => set.add(l.symbol)); }
    return [...set].filter((s) => s !== "Phoenix").sort();
  }, [baseline]);

  const run = () => {
    if (!baseline) return;
    try {
      const out = simulate(baseline.covered.map((c) => ({ owner: c.owner, address: c.address, collateral: c.collateral, debts: c.debts, collateralUsd: c.collateralUsd, debtUsd: c.debtUsd })), shocks);
      setResult({ run: out, at: Date.now(), baselineAt: baseline.asOf }); setError("");
    } catch (e) { setResult(null); setError(e instanceof Error ? e.message : "Could not run the scenario."); }
  };

  const pools = poolRows(protocol);
  const poolSel = pools.find((p) => p.symbol === (wd.symbol || pools[0]?.symbol)) ?? null;
  const w = poolSel ? simulateWithdrawal(poolSel.pool, wd.percent) : null;
  const total = baseline ? baseline.covered.length + baseline.excluded.length : 0;
  const worst = result ? [...result.run.covered].sort((a, b) => (a.result.health ?? Infinity) - (b.result.health ?? Infinity)).slice(0, 8) : [];

  return (
    <>
      <ViewHead title="What-if Calculator" blurb="Reprice the accounts with your own assumptions. Read-only - nothing is sent to the chain." />
      <div className="an-row" style={{ gap: 8 }}><span className="an-sim-banner"><Icon name="warning" />Simulated</span><span className="an-muted" style={{ fontSize: 13 }}>Results below are calculated estimates under the assumptions you set, not predictions and not measured facts. <InfoTip k="simulation" /></span></div>
      <div className="an-tabs" role="tablist">
        {([["price", "Price changes"], ["withdrawal", "Liquidity withdrawal"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === "price" && (
        <div className="an-calc">
          <div className="an-calc-inputs">
            <Panel title="Your assumptions" sub="Percent change in price, applied to collateral and debt in that asset">
              {isLoading ? <Empty title="Loading the baseline…" /> : !baseline || assets.length === 0
                ? <Notice tone="warn">There is nothing to reprice yet: none of the {baseline?.covered.length ?? 0} accounts that could be valued holds collateral or debt. Accounts that do are waiting for a fresh price. Try again shortly, or press Re-read baseline.</Notice>
                : <>
                  {assets.map((s) => (
                    <div className="an-shock-row" key={s}>
                      <AssetCell symbol={s} sub="" size="sm" />
                      <input type="range" min={-100} max={100} step={1} value={shocks[s] ?? 0} aria-label={`${s} price change`} onChange={(e) => setShocks({ ...shocks, [s]: Number(e.target.value) })} />
                      <output className={(shocks[s] ?? 0) < 0 ? "an-neg" : (shocks[s] ?? 0) > 0 ? "an-pos" : ""}>{(shocks[s] ?? 0) > 0 ? "+" : ""}{shocks[s] ?? 0}%</output>
                    </div>
                  ))}
                  <div className="an-field an-mt"><div className="an-lbl">Quick scenario inputs <span className="an-muted" style={{ textTransform: "none", letterSpacing: 0 }}>(not measured facts)</span></div>
                    <div className="an-preset-row">
                      {PRESETS.map((p) => <button key={p} className="an-chip" onClick={() => setShocks(Object.fromEntries(assets.filter((s) => !/USD/.test(s)).map((s) => [s, p])))}>Non-stable assets {p}%</button>)}
                      <button className="an-chip" onClick={() => { setShocks({}); setResult(null); }}>Reset</button>
                    </div></div>
                  <button className="an-btn an-primary an-mt" onClick={run}>Calculate</button>
                  {error && <p className="an-panel-foot" style={{ color: "var(--danger)" }}>{error}</p>}
                </>}
            </Panel>
            {baseline && (
              <Panel title="Baseline" sub="The saved starting point for every run">
                <dl className="an-kv"><div><dt>Read at</dt><dd>{clock(baseline.asOf)}</dd></div><div><dt>Accounts covered</dt><dd>{baseline.covered.length} of {total}</dd></div><div><dt>Model</dt><dd>{WHATIF_MODEL}</dd></div></dl>
                <button className="an-btn an-sm an-mt" disabled={isFetching} onClick={() => { void refetch(); setResult(null); }}>{isFetching ? "Reading…" : "Re-read baseline"}</button>
              </Panel>
            )}
          </div>

          <div className="an-calc-results">
            {!result ? <Panel title="Results"><Empty title="Set your assumptions, then press Calculate" text="Nothing is pre-calculated. Every figure here is computed from the baseline when you ask." icon="calculator" /></Panel> : (
              <>
                <Panel title="Before and after" sub={`Simulated · ${result.run.covered.length} accounts · baseline ${clock(result.baselineAt)} · calculated ${clock(result.at)}`}
                  actions={<Badge tone="warn">Simulated</Badge>}>
                  {Object.keys(result.run.shocks).length === 0 ? <Notice>No price change set, so the result equals the baseline.</Notice> : <p className="an-muted" style={{ marginBottom: 10 }}>Assumed: {Object.entries(result.run.shocks).map(([s, p]) => `${s} ${p > 0 ? "+" : ""}${p}%`).join(" · ")}</p>}
                  <div className="an-compare">
                    <Side label="Before" c={result.run.baseline.collateral} d={result.run.baseline.debt} h={result.run.baseline.averageHealth} e={result.run.baseline.eligibleCount} bad={result.run.baseline.shortfall} />
                    <span className="an-arrow"><Icon name="arrow" /></span>
                    <Side label="After (simulated)" c={result.run.result.collateral} d={result.run.result.debt} h={result.run.result.averageHealth} e={result.run.result.eligibleCount} bad={result.run.result.shortfall} tone />
                  </div>
                  <p className="an-panel-foot">Prices change instantly and everywhere at once. Interest, liquidations actually happening, and recovery of bad debt are <b>not</b> modelled. &quot;Can be liquidated&quot; is eligibility; &quot;bad debt&quot; is debt that collateral no longer covers - they are different things. <InfoTip k="eligibility" /></p>
                </Panel>
                <Panel title="Accounts closest to the line after the change" flush>
                  <div className="an-table-wrap"><table className="an-t">
                    <thead><tr><th>Wallet</th><th className="an-r">Health before</th><th className="an-r">Health after</th><th className="an-r">Debt</th><th className="an-r">Bad debt after</th><th>After</th></tr></thead>
                    <tbody>{worst.map((a) => (
                      <tr key={a.address}><td title={a.owner}>{short(a.owner, 5, 5)}</td><td className="an-r">{hfText(a.baseline.health)}</td><td className="an-r">{hfText(a.result.health)}</td><td className="an-r">{usd(a.result.debt)}</td><td className="an-r">{usd(a.result.shortfall)}</td>
                        <td>{a.result.shortfall > 0 ? <Badge tone="danger">Bad debt</Badge> : a.result.eligible ? <Badge tone="danger">Can be liquidated</Badge> : <Badge tone="ok">Above the line</Badge>}</td></tr>
                    ))}</tbody></table></div>
                </Panel>
              </>
            )}
            {baseline && baseline.excluded.length > 0 && (
              <Panel title="Left out of the baseline" sub={`${baseline.excluded.length} of ${total} accounts - results describe the ${baseline.covered.length} covered accounts only`}>
                <div className="an-table-wrap"><table className="an-t"><thead><tr><th>Wallet</th><th>Why</th></tr></thead>
                  <tbody>{baseline.excluded.slice(0, 12).map((x) => <tr key={x.address}><td title={x.owner}>{short(x.owner, 5, 5)}</td><td>{x.reasons.length ? x.reasons.map(reasonText).join(" ") : x.venueHeld ? "Holds a Phoenix perps account, which is valued as one lump, so its positions can't be repriced individually." : "Not valued."}</td></tr>)}</tbody></table></div>
                {baseline.excluded.length > 12 && <p className="an-panel-foot">…and {baseline.excluded.length - 12} more with the same kinds of reasons.</p>}
              </Panel>
            )}
          </div>
        </div>
      )}

      {tab === "withdrawal" && (
        <div className="an-calc">
          <div className="an-calc-inputs">
            <Panel title="Your assumption" sub="Share of a pool's supplied assets that lenders try to withdraw at once" tip="simulation">
              {pools.length === 0 ? <Empty title="Loading pools…" /> : (
                <>
                  <div className="an-field"><div className="an-lbl">Pool</div>
                    <select className="an-select" value={poolSel?.symbol ?? ""} onChange={(e) => setWd({ ...wd, symbol: e.target.value })}>{pools.map((p) => <option key={p.symbol}>{p.symbol}</option>)}</select></div>
                  <div className="an-field an-mt"><div className="an-lbl">Withdrawal: {wd.percent}% of supplied</div>
                    <input type="range" min={0} max={100} step={1} value={wd.percent} aria-label="Withdrawal percent" onChange={(e) => setWd({ ...wd, percent: Number(e.target.value) })} /></div>
                </>
              )}
            </Panel>
          </div>
          <div className="an-calc-results">
            {poolSel && w ? (
              <Panel title="What the pool could pay out" sub="Simulated · pool balances as read from the chain" actions={<Badge tone="warn">Simulated</Badge>}>
                <dl className="an-kv">
                  <div><dt>Supplied by lenders</dt><dd>{num(poolSel.pool.totalSupplied)} {poolSel.symbol}</dd></div>
                  <div><dt>Cash available now</dt><dd>{num(poolSel.pool.availableLiquidity)} {poolSel.symbol}{poolSel.usdCash !== null ? ` · ${usdC(poolSel.usdCash)}` : ""}</dd></div>
                  <div><dt>Requested to withdraw</dt><dd>{num(w.requested)} {poolSel.symbol}</dd></div>
                  <div><dt>Could be paid immediately</dt><dd>{num(w.executed)} {poolSel.symbol}</dd></div>
                  <div><dt>Couldn&apos;t be paid</dt><dd style={{ color: w.unfilled > 0 ? "var(--danger)" : undefined }}>{num(w.unfilled)} {poolSel.symbol} {w.requested > 0 ? `(${pct(w.unfilled / w.requested, 1)} of the request)` : ""}</dd></div>
                </dl>
                <p className="an-panel-foot">Balances and prices are held fixed. No interest-rate or health change is predicted.</p>
              </Panel>
            ) : <Panel title="Results"><Empty title="Pick a pool" icon="pools" /></Panel>}
          </div>
        </div>
      )}
    </>
  );
}
