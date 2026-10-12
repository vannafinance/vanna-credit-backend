"use client";

/**
 * One margin account on its own page: who it is, how healthy it is, a what-if slider on its own balances,
 * how it ranks, what it holds and owes, and its real transactions. Everything is read from the chain (via
 * the analytics API); the only maths here is the shared pure helpers (lib/analytics/risk, whatif).
 */
import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAccountActivity, useAccountPage, useAnalyticsProtocol } from "@/hooks/use-analytics";
import { ago, clock, finite, hfText, levText, pct, pct1, short, usd } from "@/lib/analytics/format";
import { trailFor, type From } from "@/lib/analytics/links";
import { classify, DISPLAY_BANDS, liquidationPrices, LIQUIDATION_LINE, STATUS_LABEL, type Standing } from "@/lib/analytics/risk";
import { simulateAccount } from "@/lib/analytics/whatif";
import { reasonText } from "@/lib/analytics/reasons";
import type { AccountView } from "@/lib/analytics/types";
import { explorerUrl } from "@/lib/solana/config";
import { CollateralDebt, MarginBreakdown } from "../accounts-monitor";
import { Sparkline } from "../charts";
import { Addr, Badge, Empty, ForkTime, Icon, InfoTip, Kpi, Notice, Panel, StatusBadge, statusTone, YouPill } from "../ui";

/** An asset priced within this of $1 is treated as a stable coin: a slider on it would say nothing. */
const STABLE_BAND = 0.03;
const SLIDER_RANGE = 50;

function Crumbs({ from, current }: { from: From; current: string }) {
  return (
    <nav className="an-crumbs" aria-label="Breadcrumb">
      {trailFor(from).map((c) => (
        <Fragment key={c.label}><Link href={c.href}>{c.label}</Link><span className="an-crumb-sep" aria-hidden="true">›</span></Fragment>
      ))}
      <span className="an-crumb-current" aria-current="page">{current}</span>
    </nav>
  );
}

export function AccountPage({ address, from }: { address: string; from: From }) {
  const wallet = useWallet();
  const { data, error, isLoading } = useAccountPage(address);
  const { data: protocol } = useAnalyticsProtocol();
  const activity = useAccountActivity(address);
  const prices = useMemo(() => Object.fromEntries(Object.entries(protocol?.prices ?? {}).map(([k, v]) => [k, v.usd])) as Record<string, number | null>, [protocol]);

  if (!data) {
    return (
      <>
        <Crumbs from={from} current={short(address, 5, 5)} />
        {isLoading
          ? <Empty title="Loading account…" text="Reading it from the chain." />
          : <Empty title="Account not found" text={error instanceof Error ? error.message : "This account could not be read."} icon="search">
              <p><Link className="an-btn an-sm" href={trailFor(from)[0].href}>Back to {trailFor(from)[0].label}</Link></p>
            </Empty>}
      </>
    );
  }

  const { row, standing } = data;
  const mine = wallet.publicKey?.toBase58() === row.owner;
  const hasDebt = row.valued && (row.debtUsd ?? 0) > 0;
  // The exact opening time comes from the account's own transactions; the scan's "first seen" is only a fallback.
  const opened = activity.data?.items.find((i) => i.type === "create")?.time ?? null;
  const stale = (row.stalePrices ?? []).map((s) => ({ s, p: protocol?.prices[s] })).filter((x) => x.p?.stale);

  return (
    <>
      <Crumbs from={from} current={short(row.owner, 5, 5)} />

      <section className="an-panel an-acct-head">
        <div className="an-acct-id">
          <div className="an-eyebrow">Margin account</div>
          <h1 className="an-acct-title" title={row.owner}>{short(row.owner, 5, 5)}<YouPill value={row.owner} /></h1>
          <div className="an-acct-line">
            <span className="an-muted">Margin account</span><Addr value={row.address} head={5} tail={5} /><StatusBadge row={row} />
          </div>
          <div className="an-acct-line an-muted">
            <span>Owner wallet</span><Addr value={row.owner} head={5} tail={5} />
            <span>· {opened ? <>opened <ForkTime t={opened} /></> : row.firstSeenTime ? <>first seen in activity <ForkTime t={row.firstSeenTime} /></> : "opening time not found in the scanned window"}</span>
            <span>· read at {clock(row.readAt)}</span>
          </div>
        </div>
        <a className="an-btn an-sm" href={explorerUrl("address", row.address)} target="_blank" rel="noreferrer">View on explorer ↗</a>
      </section>

      {mine
        ? <div className="an-acct-banner an-mine">
            <div><b>This is your account.</b>{hasDebt && row.bufferPct !== null && !row.liquidatable && <> It is {pct1(row.bufferPct)} of its collateral value away from liquidation.</>}{row.liquidatable && <> It is already below the liquidation line.</>}</div>
            <Link className="an-btn an-sm" href="/">Add collateral or repay on the Margin page →</Link>
          </div>
        : <div className="an-acct-banner">
            <div><b>You are viewing {wallet.publicKey ? "another user's account" : "a Vanna margin account"}.</b> <span className="an-muted">Everything here is public on-chain data and read-only. Only the owner can act on it.</span></div>
          </div>}

      {!row.valued && <Notice tone="warn"><strong>This account can&apos;t be valued right now.</strong> {row.reasons.map(reasonText).join(" ") || "Part of it could not be read."} It is left out of the dashboard&apos;s totals.</Notice>}

      <div className="an-kpi-grid an-cols-6">
        <Kpi label="Health" tip="health" value={!row.valued ? "-" : row.healthFactor === null ? "No debt" : hfText(row.healthFactor)} na={!row.valued} tone={row.liquidatable ? "danger" : statusTone(row.status) === "warn" ? "warn" : ""} sub={hasDebt ? `Liquidated at ${LIQUIDATION_LINE.toFixed(2)}` : row.valued ? "Nothing owed" : "Not valued"} />
        <Kpi label="Leverage" value={levText(row.leverage)} na={!row.valued || row.leverage === null} sub="Account value ÷ own money" />
        <Kpi label="Account value" tip="accountValue" value={usd(row.collateralUsd)} na={!row.valued} sub="Everything it holds" />
        <Kpi label="Debt" value={usd(row.debtUsd)} na={!row.valued} sub={!row.valued ? "Not valued" : row.debts.length ? `${row.debts.map((d) => d.symbol).join(", ")} · ${row.debts.map((d) => pct(d.borrowApr)).join(", ")} APR` : "No borrowing"} />
        <Kpi label="Own money" value={usd(row.equityUsd)} na={!row.valued} tone={(row.equityUsd ?? 0) < 0 ? "danger" : ""} sub="Value minus debt" />
        <Kpi label="Room before liquidation" tip="buffer" value={row.liquidatable ? "None" : row.bufferPct === null ? "-" : pct1(row.bufferPct)} na={!row.valued || (!row.liquidatable && row.bufferPct === null)} tone={row.liquidatable ? "danger" : ""} sub={row.bufferUsd !== null && !row.liquidatable ? usd(row.bufferUsd) : row.liquidatable ? "Already below the line" : ""} />
      </div>

      <div className="an-grid-main">
        <Scenario row={row} prices={prices} />
        <StandingPanel row={row} standing={standing} />
      </div>

      <section className="an-panel">
        <div className="an-panel-head"><div><h2 className="an-panel-title">Collateral and debt</h2><p className="an-panel-sub">What the account holds and what it owes</p></div></div>
        <div className="an-acct-stack">
          <MarginBreakdown row={row} />
          <CollateralDebt row={row} />
        </div>
      </section>

      <Activity activity={activity} />

      {stale.length > 0 && (
        <p className="an-muted an-acct-foot">
          Prices used: {stale.map(({ s, p }) => `${s} ${usd(p?.usd)} (last updated ${ago(p?.ageSecs)}, allowed up to ${p?.maxAgeSecs ?? "-"}s)`).join(" · ")}. The account is valued at the last on-chain price until it updates.
        </p>
      )}
    </>
  );
}

// ---- what if the price moves ----------------------------------------------------------------------
function Scenario({ row, prices }: { row: AccountView; prices: Record<string, number | null> }) {
  const [pick, setPick] = useState<string | null>(null);
  const [change, setChange] = useState(0);
  const movable = useMemo(() => {
    const exposure = new Map<string, number>();
    for (const l of row.collateral) if (l.kind !== "venue") exposure.set(l.underlying, (exposure.get(l.underlying) ?? 0) + l.usd);
    for (const d of row.debts) exposure.set(d.symbol, (exposure.get(d.symbol) ?? 0) + d.usd);
    return [...exposure].filter(([s]) => { const p = prices[s]; return finite(p) && Math.abs(p - 1) > STABLE_BAND; }).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  }, [row, prices]);

  if (!row.valued) return <Panel title="If the price moves" sub="Not available for this account"><p className="an-muted">The account can&apos;t be valued right now, so there is nothing to reprice.</p></Panel>;
  if ((row.debtUsd ?? 0) <= 0) return <Panel title="If the price moves" sub="Needs an account with debt"><p className="an-muted">This account owes nothing, so a price move cannot put it at risk of liquidation.</p></Panel>;
  if (row.venueHeld) return <Panel title="If the price moves" sub="Not available for this account"><p className="an-muted">Its Phoenix perps account is counted as one lump value, so its positions can&apos;t be repriced one by one.</p></Panel>;
  if (!movable.length) return <Panel title="If the price moves" sub="Not available for this account"><p className="an-muted">It holds and owes only assets priced at about $1, so a price move says nothing here.</p></Panel>;

  const symbol = pick && movable.includes(pick) ? pick : movable[0];
  const now = prices[symbol] as number;
  const run = simulateAccount({ owner: row.owner, address: row.address, collateral: row.collateral, debts: row.debts, collateralUsd: row.collateralUsd, debtUsd: row.debtUsd }, { [symbol]: change });
  const r = run.result;
  const status = classify({ valued: true, collateralUsd: r.collateral, debtUsd: r.debt, healthFactor: r.health, liquidatable: r.eligible });
  const marker = r.health === null ? 100 : Math.min(100, Math.max(0, (r.health - 1) * 100));
  const liq = liquidationPrices(row, prices).find((l) => l.symbol === symbol);
  const room = r.debt > 0 && r.collateral > 0 ? Math.max(0, 1 - (LIQUIDATION_LINE * r.debt) / r.collateral) : null;

  return (
    <Panel title="If the price moves" sub="Drag to move the price. Worked out in your browser from this account's own balances; nothing is sent anywhere."
      actions={movable.length > 1 ? <div className="an-seg" role="group" aria-label="Asset to move">{movable.slice(0, 5).map((s) => <button key={s} aria-pressed={s === symbol} onClick={() => { setPick(s); setChange(0); }}>{s}</button>)}</div> : <Badge tone="warn">Simulated</Badge>}>
      <div className="an-hmeter" role="img" aria-label={`Health ${hfText(r.health)} on a scale from 1.00 to 2.00, liquidation at ${LIQUIDATION_LINE.toFixed(2)}`}>
        <i className="an-hmeter-line" style={{ left: `${(LIQUIDATION_LINE - 1) * 100}%` }} />
        <i className="an-hmeter-mark" style={{ left: `${marker}%` }}><span>{hfText(r.health)}</span></i>
        <span className="an-hmeter-tick" style={{ left: "0%" }}>1.00</span>
        <span className="an-hmeter-tick an-liq" style={{ left: `${(LIQUIDATION_LINE - 1) * 100}%` }}>{LIQUIDATION_LINE.toFixed(2)} liquidation</span>
        <span className="an-hmeter-tick" style={{ left: `${(DISPLAY_BANDS.warning - 1) * 100}%` }}>{DISPLAY_BANDS.warning.toFixed(2)}</span>
        <span className="an-hmeter-tick" style={{ left: "100%" }}>2.00</span>
      </div>
      <div className="an-scn-row">
        <div><span className="an-scn-price">{usd(now * (1 + change / 100))}</span> <span className="an-muted">{symbol} price{change !== 0 ? ` (now ${usd(now)})` : ""}</span></div>
        <Badge tone={statusTone(status)}>{STATUS_LABEL[status]}</Badge>
      </div>
      <input type="range" className="an-range" min={-SLIDER_RANGE} max={SLIDER_RANGE} step={1} value={change} onChange={(e) => setChange(Number(e.target.value))} aria-label={`Change in ${symbol} price`} />
      <div className="an-scn-scale an-muted"><span>−{SLIDER_RANGE}%</span><span>{change === 0 ? "0% (now)" : `${change > 0 ? "+" : "−"}${Math.abs(change)}%`}</span><span>+{SLIDER_RANGE}%</span></div>
      <div className="an-mini-stats">
        <div><span className="an-k">Account value</span><span className="an-v">{usd(r.collateral)}</span></div>
        <div><span className="an-k">Own money</span><span className="an-v">{usd(r.equity)}</span></div>
        <div><span className="an-k">Room before liquidation</span><span className="an-v">{room === null ? "-" : pct1(room)}</span></div>
      </div>
      <p className="an-panel-foot" style={{ padding: 0 }}>
        {liq ? <>Liquidation happens if {symbol} {liq.direction === "down" ? "falls" : "rises"} to <b>{usd(liq.price)}</b> ({liq.change >= 0 ? "+" : "−"}{pct1(Math.abs(liq.change))}), all else equal.</> : <>No move of {symbol} alone reaches the liquidation line.</>} Interest and liquidations actually happening are not modelled.
      </p>
    </Panel>
  );
}

// ---- where it stands -------------------------------------------------------------------------------
function StandingPanel({ row, standing }: { row: AccountView; standing: Standing }) {
  const fact = (k: React.ReactNode, v: React.ReactNode) => <div><dt>{k}</dt><dd>{v}</dd></div>;
  return (
    <Panel title="Where it stands" sub="Compared with every other account the dashboard has valued">
      <dl className="an-kv">
        {fact("Debt rank", standing.debtRank ? `#${standing.debtRank} of ${standing.borrowers} with debt` : "No debt")}
        {fact("Share of all debt", standing.debtShare !== null ? pct1(standing.debtShare) : "-")}
        {fact(<>Closest to liquidation <InfoTip k="buffer" /></>, standing.healthRank ? `#${standing.healthRank} of ${standing.borrowers}` : "-")}
        {fact("Health, recent readings", <Sparkline w={110} values={row.hfTrend} label="Health factor readings" color="var(--c2)" />)}
      </dl>
      <p className="an-panel-foot" style={{ padding: 0 }}>Readings are this dashboard&apos;s own, one per refresh. They are not chain history.</p>
    </Panel>
  );
}

// ---- real transactions ---------------------------------------------------------------------------------
function Activity({ activity }: { activity: ReturnType<typeof useAccountActivity> }) {
  const { data, isLoading, isError } = activity;
  const items = data?.items ?? [];
  return (
    <section className="an-panel an-flush">
      <div className="an-panel-head"><div><h2 className="an-panel-title">Recent activity</h2><p className="an-panel-sub">This account&apos;s own transactions, read from the chain{data && !data.complete ? " · older ones are not shown" : ""}</p></div></div>
      {isLoading ? <Empty title="Reading transactions…" text="This can take a few seconds." />
        : isError ? <Empty title="Activity can't be read right now" text="The account itself is shown above. Try again in a moment." />
        : items.length === 0 ? <Empty title="No transactions found" text="None of this wallet's recent transactions touched the Vanna program." />
        : <div className="an-feed">{items.map((i) => (
          <div className="an-feed-item" key={`${i.signature}-${i.type}-${i.detail}`}>
            <div className={`an-feed-icon an-${i.tone === "neutral" ? "" : i.tone}`}><Icon name="activity" /></div>
            <div className="an-feed-main"><b>{i.title}</b><p>{i.detail || " "}{i.healthFactor !== null ? `${i.detail ? " · " : ""}health after ${hfText(i.healthFactor)}` : ""}</p></div>
            <div className="an-feed-meta"><ForkTime t={i.time} /><br /><a href={explorerUrl("tx", i.signature)} target="_blank" rel="noreferrer" className="an-link">Transaction ↗</a></div>
          </div>
        ))}</div>}
    </section>
  );
}
