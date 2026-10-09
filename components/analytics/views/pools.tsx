"use client";

/** Lending Pools: reserve table, selected-pool inspector and the on-chain rate model. */
import { useState } from "react";
import { useAnalyticsProtocol } from "@/hooks/use-analytics";
import { poolRows, poolTotals, type PoolRow } from "@/lib/analytics/pools";
import { ago, finite, num, pct, usd, usdC } from "@/lib/analytics/format";
import { TOKENS } from "@/lib/solana/tokens";
import { Addr, AssetCell, Badge, Empty, InfoTip, Kpi, Notice, Panel, ForkTime } from "../ui";
import { ViewHead } from "../shell";
import { Gauge, HBars, Legend, LineChart, Meter, SERIES } from "../charts";
import type { ProtocolOverview } from "@/lib/analytics/server/store";

const decimals = (symbol: string) => TOKENS.find((t) => t.symbol === symbol)?.decimals ?? 9;
const capText = (cap: number | null) => (cap === null ? "No limit set" : num(cap));

function Inspector({ row, data }: { row: PoolRow; data: ProtocolOverview }) {
  const detail = data.poolDetail[row.symbol];
  const p = row.pool;
  const fees = detail ? Number(BigInt(detail.accruedProtocolFees)) / 10 ** decimals(row.symbol) : null;
  const curve = detail?.curve ?? [];
  const marker = curve.length ? { x: p.utilization, y: p.borrowApr, label: `Now ${pct(p.utilization)} → ${pct(p.borrowApr)} APR` } : null;
  const fact = (k: React.ReactNode, v: React.ReactNode) => <div><dt>{k}</dt><dd>{v}</dd></div>;
  return (
    <section className="an-panel">
      <div className="an-panel-head"><AssetCell symbol={row.symbol} /></div>
      <div className="an-grid-main" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1.5fr)", gap: 24 }}>
        <div className="an-gauge-wrap" style={{ gap: 14, alignContent: "start" }}>
          <Gauge value={p.utilization} label="Utilization" />
          <div className="an-mini-stats" style={{ width: "100%" }}>
            <div><span className="an-k">Supplied</span><span className="an-v">{usdC(row.usdSupplied)}</span></div>
            <div><span className="an-k">Borrowed</span><span className="an-v">{usdC(row.usdBorrowed)}</span></div>
            <div><span className="an-k">Available</span><span className="an-v">{usdC(row.usdCash)}</span></div>
          </div>
        </div>
        <div>
          <div className="an-panel-title" style={{ marginBottom: 2 }}>How the borrow rate changes</div>
          <p className="an-panel-sub" style={{ marginBottom: 8 }}>Interest rate for borrowers at each level of utilization</p>
          {curve.length ? <LineChart points={curve.map((c) => ({ x: c.utilization, y: c.annualRate, tip: `Utilization ${pct(c.utilization, 0)}\nBorrow APR ${pct(c.annualRate)}` }))}
            xFmt={(v) => pct(v, 0)} yFmt={(v) => pct(v, v < 0.1 ? 1 : 0)} marker={marker} ariaLabel={`${row.symbol} borrow APR by utilization`} xTicks={[0, 0.25, 0.5, 0.75, 1]} />
            : <Empty title="Rate model not available" text="The pool's rate settings could not be read from the chain." />}
        </div>
      </div>
      <div className="an-grid-2 an-mt" style={{ gap: 32 }}>
        <dl className="an-kv">
          {fact("Status", <Badge tone={p.status === "Active" ? "ok" : "warn"}>{p.status}</Badge>)}
          {fact(<>Reserve factor <InfoTip k="reserveFactor" /></>, pct(p.reserveFactor))}
          {fact("Accrued protocol fees", fees === null ? "Not available" : `${num(fees, 6)} ${row.symbol}${row.valued && row.price?.usd ? ` · ${usd(fees * row.price.usd)}` : ""}`)}
          {fact(<>Supply limit <InfoTip k="caps" /></>, capText(p.supplyCap))}
          {fact("Borrow limit", capText(p.borrowCap))}
          {fact("Value of one deposit share", num(p.exchangeRate, 9))}
          {fact("Last interest update", detail && finite(detail.lastAccrual) ? <><ForkTime t={detail.lastAccrual} /> <span className="an-muted">· {ago(data.forkTime - detail.lastAccrual)}</span></> : "Not available")}
          {fact("Collateral / borrowing", detail ? <><Badge tone={detail.collateralEnabled ? "ok" : "warn"}>{detail.collateralEnabled ? "Collateral on" : "Collateral off"}</Badge> <Badge tone={detail.borrowEnabled ? "ok" : "warn"}>{detail.borrowEnabled ? "Borrow on" : "Borrow off"}</Badge></> : "Not available")}
        </dl>
        <details className="an-more"><summary>More details</summary>
          <dl className="an-kv">
            {fact("Pool address", p.reserve ? <Addr value={p.reserve} head={6} tail={6} /> : "—")}
            {fact("Token mint", <Addr value={p.mint} head={6} tail={6} />)}
            {fact("Share mint", detail?.shareMint ? <Addr value={detail.shareMint} head={6} tail={6} /> : "—")}
            {fact("Liquidity vault", detail?.liquidityVault ? <Addr value={detail.liquidityVault} head={6} tail={6} /> : "—")}
            {fact("Asset configuration", p.assetConfig ? <Addr value={p.assetConfig} head={6} tail={6} /> : "—")}
            {fact("Decimals", String(p.decimals))}
          </dl>
        </details>
      </div>
    </section>
  );
}

type Measure = "usd" | "share" | "rates";

export function PoolsView() {
  const { data, isError } = useAnalyticsProtocol();
  const rows = poolRows(data);
  const t = poolTotals(rows);
  const [pick, setPick] = useState<string | null>(null);
  const [measure, setMeasure] = useState<Measure>("usd");
  const selected = rows.find((r) => r.symbol === pick) ?? rows[0] ?? null;
  const unvalued = rows.filter((r) => !r.valued);
  const why = !data ? (isError ? "Couldn't reach the service." : "Waiting for the first data load.") : unvalued.length ? `${unvalued.map((r) => r.symbol).join(", ")} ${unvalued.length === 1 ? "has" : "have"} no fresh price yet.` : "Prices and balances are out of sync. Try again in a moment.";
  const partial = t?.partial ? <Badge tone="warn">Partial</Badge> : null;
  const sub = (base: string) => (!t ? why : t.partial ? `Without ${t.excluded.join(", ")} (waiting for a fresh price)` : base);

  const cmpRows = rows.filter((r) => measure === "rates" || r.valued).map((r) => {
    const a = r.usdCash ?? 0, b = r.usdBorrowed ?? 0, tot = a + b || 1;
    const segments = measure === "rates"
      ? [{ value: r.pool.borrowApr, color: SERIES[0], tip: `${r.symbol} borrow APR ${pct(r.pool.borrowApr)}` }, { value: r.pool.supplyApr, color: SERIES[1], tip: `${r.symbol} supply APR ${pct(r.pool.supplyApr)}` }]
      : measure === "share"
        ? [{ value: a / tot, color: SERIES[0], tip: `Cash ${pct(a / tot, 1)}` }, { value: b / tot, color: SERIES[1], tip: `Debt ${pct(b / tot, 1)}` }]
        : [{ value: a, color: SERIES[0], tip: `${r.symbol} cash ${usd(a)}` }, { value: b, color: SERIES[1], tip: `${r.symbol} debt ${usd(b)}` }];
    return { key: r.symbol, name: <AssetCell symbol={r.symbol} sub="" size="sm" />, segments, valueText: measure === "rates" ? pct(r.pool.borrowApr) : measure === "share" ? `${pct(b / tot, 1)} debt` : usdC(a + b) };
  });

  return (
    <>
      <ViewHead title="Lending Pools" blurb="What lenders have supplied, what is borrowed and what is left to withdraw." />
      <div className="an-kpi-grid an-cols-5">
        <Kpi label="Supplied by lenders" tip="supplied" value={t ? usdC(t.supplied) : "—"} na={!t} badge={partial} sub={sub(`${rows.length} pools · USD`)} />
        <Kpi label="Borrowed" tip="borrowed" value={t ? usdC(t.borrowed) : "—"} na={!t} badge={partial} sub={sub("What borrowers owe")} />
        <Kpi label="Available to withdraw" tip="cash" value={t ? usdC(t.cash) : "—"} na={!t} badge={partial} sub={sub("Withdrawable cash")} />
        <Kpi label="Borrowed share" tip="ratio" value={t?.ratio != null ? pct(t.ratio) : "—"} na={t?.ratio == null} badge={partial} sub={t ? `${t.partial ? "Counted pools only · " : ""}Busiest: ${t.maxUtilizationSymbol} ${pct(t.maxUtilization)}` : why} />
        <Kpi label="Average borrow rate" tip="borrowApr" value={t?.borrowApr != null ? pct(t.borrowApr) : "—"} na={t?.borrowApr == null} sub={t ? `Supply APR ${pct(t.supplyApr)}` : why} />
      </div>
      {!rows.length ? <Empty title={data ? "No active lending pools" : "Loading pools…"} text={data ? "No Vanna lending pool is initialised on this network." : undefined} icon="pools" /> : (
        <>
          <section className="an-panel an-flush">
            <div className="an-panel-head"><div><h2 className="an-panel-title">Pools</h2><p className="an-panel-sub">{rows.length} lending pools · select one to inspect</p></div></div>
            <div className="an-table-wrap"><table className="an-t">
              <thead><tr><th>Pool</th><th className="an-r">Supplied</th><th className="an-r">Borrowed</th><th className="an-r">Available</th><th>Utilization</th><th className="an-r">Borrow APR</th><th>Status</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.symbol} className={`an-row-link ${selected?.symbol === r.symbol ? "an-expanded" : ""}`} tabIndex={0} role="button" aria-pressed={selected?.symbol === r.symbol}
                  onClick={() => setPick(r.symbol)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPick(r.symbol); } }}>
                  <td><AssetCell symbol={r.symbol} /></td>
                  <td className="an-r"><b>{usd(r.usdSupplied)}</b><small>{num(r.pool.totalSupplied)} {r.symbol}</small></td>
                  <td className="an-r"><b>{usd(r.usdBorrowed)}</b><small>{num(r.pool.totalBorrowed)} {r.symbol}</small></td>
                  <td className="an-r"><b>{usd(r.usdCash)}</b><small>{num(r.pool.availableLiquidity)} {r.symbol}</small></td>
                  <td style={{ minWidth: 130 }}><span className="an-strong">{pct(r.pool.utilization)}</span><div style={{ marginTop: 6 }}><Meter fraction={r.pool.utilization} /></div></td>
                  <td className="an-r"><b>{pct(r.pool.borrowApr)}</b><small>Supply {pct(r.pool.supplyApr)}</small></td>
                  <td><Badge tone={r.pool.status === "Active" ? "ok" : "warn"}>{r.pool.status}</Badge></td>
                </tr>
              ))}</tbody></table></div>
          </section>
          {selected && data && <Inspector row={selected} data={data} />}
          <Panel title="Liquidity structure" sub="How much of each pool is cash and how much is lent out"
            actions={<div className="an-seg" role="group" aria-label="Chart measure">{([["usd", "USD values"], ["share", "Cash vs debt"], ["rates", "Annual rates"]] as const).map(([k, l]) => <button key={k} aria-pressed={measure === k} onClick={() => setMeasure(k)}>{l}</button>)}</div>}>
            {measure !== "rates" && !rows.some((r) => r.valued)
              ? <Notice tone="warn">{why}</Notice>
              : <><HBars rows={cmpRows} /><div className="an-mt"><Legend items={measure === "rates" ? [{ label: "Borrow APR", color: SERIES[0] }, { label: "Supply APR", color: SERIES[1] }] : [{ label: "Available cash", color: SERIES[0] }, { label: "Outstanding debt", color: SERIES[1] }]} /></div></>}
            {measure !== "rates" && unvalued.length > 0 && rows.some((r) => r.valued) && <p className="an-panel-foot">Excludes {unvalued.map((r) => r.symbol).join(", ")}: waiting for a fresh price.</p>}
          </Panel>
        </>
      )}
    </>
  );
}
