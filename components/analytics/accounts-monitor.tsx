"use client";

/**
 * Accounts table: server-side filter / sort / search / paging, the connected wallet pinned on top
 * ("YOU"), and row expansion with collateral/debt lines and per-asset liquidation prices. It renders
 * what the API returns; the only maths here is pure helpers from lib/analytics/risk.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { lookupWallet, useAnalyticsAccounts, useAnalyticsProtocol, type AccountsQuery } from "@/hooks/use-analytics";
import { hfText, levText, num, pct, pct1, short, usd, usdC } from "@/lib/analytics/format";
import { DEFAULT_SORT_DIR, inBand, liquidationPrices, matchesFilter, protocolsOf } from "@/lib/analytics/risk";
import { reasonText } from "@/lib/analytics/reasons";
import { accountHref } from "@/lib/analytics/links";
import type { AccountFilter, AccountSortKey, AccountView } from "@/lib/analytics/types";
import { Addr, AssetCell, Empty, Icon, InfoTip, StatusBadge, statusTone, ForkTime, YouPill } from "./ui";
import { SERIES, Sparkline, StackBar } from "./charts";

const FILTERS: Array<[AccountFilter, string]> = [["all", "All"], ["liquidatable", "Liquidatable"], ["atrisk", "At risk"], ["healthy", "Safe"], ["nodebt", "No debt"], ["incomplete", "Not valued"]];
const FILTER_TONE: Partial<Record<AccountFilter, string>> = { liquidatable: "danger", atrisk: "warn", healthy: "ok" };
const TABS = [["health", "By health", "health"], ["leverage", "By leverage", "activity"]] as const;
type Tab = (typeof TABS)[number][0];
const PER = 10;
const COLS = 10;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const hfClass = (r: AccountView) => (r.healthFactor === null ? "an-na" : `an-${statusTone(r.status) === "ok" ? "ok" : statusTone(r.status)}`);
const hfCell = (r: AccountView) => (!r.valued ? <span className="an-hf an-na">-</span> : r.healthFactor === null ? <span className="an-hf an-na">{r.status === "empty" ? "-" : "No debt"}</span> : <span className={`an-hf ${hfClass(r)}`}>{hfText(r.healthFactor)}</span>);
const protocolCell = (r: AccountView) => { const p = protocolsOf(r); return p.length ? p.join(" · ") : <span className="an-muted">-</span>; };

export function AccountsMonitor({ band, onClearBand, title = "Accounts", fixedFilter }: { band: string | null; onClearBand: () => void; title?: string; fixedFilter?: AccountFilter }) {
  const wallet = useWallet();
  const you = wallet.publicKey?.toBase58() ?? null;
  const [filter, setFilter] = useState<AccountFilter>(fixedFilter ?? "all");
  const [sort, setSort] = useState<AccountSortKey>("health");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [tab, setTab] = useState<Tab>("health");
  const [page, setPage] = useState(1);
  const section = useRef<HTMLElement>(null);
  // A page change starts at the top of the table: the last page is shorter, so staying put would leave the view below it.
  const goPage = (n: number) => { setPage(n); section.current?.scrollIntoView({ block: "start", behavior: "smooth" }); };
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const qc = useQueryClient();
  const [lookup, setLookup] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });

  useEffect(() => { const t = setTimeout(() => { setQ(text); setPage(1); }, 300); return () => clearTimeout(t); }, [text]);
  // A new band or filter starts on page 1. Reset while rendering (not in an effect), so the list is
  // never requested for the new filter at the old page first.
  const [pageScope, setPageScope] = useState({ band, filter });
  if (pageScope.band !== band || pageScope.filter !== filter) {
    setPageScope({ band, filter });
    setPage(1);
  }
  // Arriving from an alert (/analytics?filter=atrisk#accounts): open that list and scroll to it.
  useEffect(() => {
    const f = new URLSearchParams(window.location.search).get("filter");
    if (f && !fixedFilter && FILTERS.some(([k]) => k === f)) { setFilter(f as AccountFilter); document.getElementById("accounts")?.scrollIntoView({ block: "start" }); }
  }, [fixedFilter]);

  const query: AccountsQuery = { filter: fixedFilter ?? filter, sort, dir, q, page, per: PER, band, you };
  const { data, isLoading } = useAnalyticsAccounts(query);
  const { data: protocol } = useAnalyticsProtocol();
  const prices = Object.fromEntries(Object.entries(protocol?.prices ?? {}).map(([k, v]) => [k, v.usd]));
  const mine = data?.you ?? null;

  // The connected wallet may not be in the server's snapshot yet: ask the server to add it (read-only).
  const [lookedUp, setLookedUp] = useState<string | null>(null);
  useEffect(() => {
    if (!you || !data || data.state.status !== "ready" || data.you || lookedUp === you) return;
    setLookedUp(you);
    lookupWallet(you).then(() => qc.invalidateQueries({ queryKey: ["analytics"] })).catch(() => undefined); // no margin account → nothing to pin
  }, [you, data, lookedUp, qc]);

  const rows = data?.rows ?? [];
  // Your own row is pinned on top only when it belongs in the list being shown (same filter and band, no search).
  const activeFilter = fixedFilter ?? filter;
  const pinned = mine && page === 1 && !q && matchesFilter(mine.row, activeFilter) && (!band || inBand(mine.row, band)) ? mine : null;
  const shown = pinned ? [pinned.row, ...rows.filter((r) => r.owner !== pinned.row.owner)] : rows;
  const counts = data?.filterCounts;
  const filteredTotal = data?.filteredTotal ?? 0, total = data?.total ?? 0;
  const incomplete = counts?.incomplete ?? 0;

  const th = (key: AccountSortKey, label: string, cls = "", tip?: Parameters<typeof InfoTip>[0]["k"]) => (
    <th className={cls}>
      <button type="button" className="an-sort" aria-sort={sort === key ? (dir === "asc" ? "ascending" : "descending") : undefined}
        onClick={() => { if (sort === key) setDir(dir === "asc" ? "desc" : "asc"); else { setSort(key); setDir(DEFAULT_SORT_DIR[key] === 1 ? "asc" : "desc"); } }}>
        {label}{sort === key ? (dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
      {tip && <InfoTip k={tip} />}
    </th>
  );
  const heads = tab === "health"
    ? <><th></th><th>#</th><th>Wallet</th>{th("health", "Health", "an-r", "health")}<th>Health trend</th>{th("debt", "Total debt", "an-r")}<th>Collateral mix</th><th className="an-nowrap">Where it sits</th>{th("buffer", "Room to fall", "an-r")}{th("status", "Status", "", "status")}</>
    : <><th></th><th>#</th><th>Wallet</th>{th("leverage", "Leverage", "an-r")}{th("equity", "Own money", "an-r")}{th("collateral", "Collateral", "an-r")}{th("debt", "Borrowed", "an-r")}<th className="an-r">Debt ÷ collateral</th>{th("buffer", "Room to fall", "an-r")}{th("status", "Status", "", "status")}</>;

  const isWallet = BASE58.test(text.trim()) && !isLoading && shown.length === 0;
  async function doLookup() {
    setLookup({ loading: true, error: null });
    try {
      const row = await lookupWallet(text.trim());
      setOpen((s) => new Set(s).add(row.owner));
      await qc.invalidateQueries({ queryKey: ["analytics"] });
      setLookup({ loading: false, error: null });
    } catch (e) { setLookup({ loading: false, error: e instanceof Error ? e.message : "Lookup failed" }); }
  }

  return (
    <section className="an-panel an-flush an-scroll-top" id="accounts" ref={section}>
      <div className="an-panel-head">
        <div>
          <h2 className="an-panel-title">{title}</h2>
          <p className="an-panel-sub">
            {filteredTotal === total ? `${total} account${total === 1 ? "" : "s"}` : `${filteredTotal} of ${total} accounts`}
            {incomplete > 0 && ` · ${incomplete} not valued yet (shown last)`}
          </p>
        </div>
      </div>
      <div className="an-tabs" role="tablist" style={{ padding: "0 20px" }}>
        {TABS.map(([k, l, ic]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}><Icon name={ic} />{l}</button>)}
      </div>
      <div className="an-toolbar">
        {!fixedFilter && (
          <div className="an-seg" role="group" aria-label="Status filter">
            {FILTERS.filter(([k]) => k === "all" || (counts?.[k] ?? 0) > 0 || filter === k).map(([k, l]) => (
              <button key={k} aria-pressed={filter === k} data-tone={FILTER_TONE[k]} onClick={() => setFilter(k)}>{FILTER_TONE[k] && <i className="an-dot" />}{l}{counts ? <span className="an-muted"> {counts[k]}</span> : null}</button>
            ))}
          </div>
        )}
        {band && <span className="an-badge an-accent">Filtered by health band <button className="an-btn an-sm an-ghost" onClick={onClearBand}>Clear</button></span>}
        <span className="an-grow" />
        <label className="an-input-wrap"><Icon name="search" />
          <input className="an-input" placeholder="Search wallet or margin address" aria-label="Search accounts" value={text} onChange={(e) => setText(e.target.value)} style={{ width: 260 }} />
        </label>
      </div>
      <div className="an-table-wrap">
        <table className="an-t an-compact">
          <thead><tr>{heads}</tr></thead>
          <tbody>
            {shown.length ? shown.map((r, i) => {
              const isYou = !!you && r.owner === you;
              const isOpen = open.has(r.owner);
              const tone = statusTone(r.status);
              const rank = isYou && mine?.row.owner === r.owner ? mine.rank ?? null : (data!.page - 1) * data!.per + (pinned ? i : i + 1);
              return (
                <Fragment key={r.address}>
                  <tr className={`an-row-link ${tone === "danger" ? "an-tone-danger" : ""} ${isOpen ? "an-expanded" : ""} ${isYou ? "an-you" : ""}`} tabIndex={0} role="button" aria-expanded={isOpen}
                    onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(r.owner)) n.delete(r.owner); else n.add(r.owner); return n; })}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } }}>
                    <td className="an-c" style={{ width: 26 }}><Icon name="chevron" className="an-chev" /></td>
                    <td className={isYou ? "an-you-rank" : "an-muted"} style={{ width: 30 }}>{rank ?? "-"}</td>
                    <td className="an-nowrap"><span className="an-strong" title={r.owner}>{short(r.owner, 5, 5)}</span><YouPill value={r.owner} /></td>
                    {tab === "health" ? (
                      <>
                        <td className="an-r">{hfCell(r)}</td>
                        <td><Sparkline w={72} values={r.hfTrend} label="Health factor readings" color={tone === "danger" ? "var(--danger-bar)" : tone === "warn" ? "var(--warn-bar)" : "var(--c2)"} /></td>
                        <td className="an-r">{usd(r.debtUsd)}</td>
                        <td>{r.valued ? <div style={{ width: 96 }}><StackBar segments={[
                          { label: "Tokens held", value: r.composition.direct, color: SERIES[0], tip: `Tokens held ${usd(r.composition.direct)}` },
                          { label: "Kamino deposits", value: r.composition.receipt, color: SERIES[1], tip: `Kamino deposits ${usd(r.composition.receipt)}` },
                          { label: "Phoenix perps", value: r.composition.venue, color: SERIES[2], tip: `Phoenix perps ${usd(r.composition.venue)}` }]} /></div> : "-"}</td>
                        <td>{protocolCell(r)}</td>
                        <td className="an-r">{r.liquidatable ? <span className="an-strong" style={{ color: "var(--danger)" }}>Below the line</span> : r.bufferPct === null ? <span className="an-muted">-</span> : <><span className="an-strong">{pct1(r.bufferPct)}</span><small>{usdC(r.bufferUsd)}</small></>}</td>
                      </>
                    ) : (
                      <>
                        <td className="an-r"><span className="an-hf">{levText(r.leverage)}</span></td>
                        <td className="an-r">{usd(r.equityUsd)}</td>
                        <td className="an-r">{usd(r.collateralUsd)}</td>
                        <td className="an-r">{usd(r.debtUsd)}</td>
                        <td className="an-r">{r.valued && (r.collateralUsd ?? 0) > 0 ? pct1((r.debtUsd ?? 0) / (r.collateralUsd ?? 1)) : "-"}</td>
                        <td className="an-r">{r.liquidatable ? <span style={{ color: "var(--danger)", fontWeight: 600 }}>Below the line</span> : r.bufferPct === null ? "-" : `−${pct1(r.bufferPct)}`}</td>
                      </>
                    )}
                    <td><StatusBadge row={r} /></td>
                  </tr>
                  {isOpen && <AccountDetail row={r} colSpan={COLS} prices={prices} />}
                </Fragment>
              );
            }) : (
              <tr><td colSpan={COLS}>
                {isWallet ? (
                  <div className="an-group-note" style={{ margin: "14px 20px" }}>
                    <div><b>Not in the list</b><span>Look up this address directly.</span></div>
                    <button className="an-btn an-sm" onClick={doLookup} disabled={lookup.loading}>{lookup.loading ? "Looking…" : "Look up"}</button>
                    {lookup.error && <p className="an-panel-foot" style={{ color: "var(--danger)", padding: "0 20px" }}>{lookup.error}</p>}
                  </div>
                ) : isLoading ? <Empty title="Loading accounts…" text="Reading the latest snapshot." />
                  : total ? <Empty title="No accounts match" text="Adjust the status filter, band or search." icon="search" />
                  : <Empty title="No accounts found yet" text="Accounts are found by reading recent Vanna transactions. They appear here as they are verified." />}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="an-table-foot">
        <span>{pinned ? "Your margin account is shown first; # is still your real rank in this list" : "Click a row for details · riskiest first"}</span>
        {data && data.pages > 1 && <Pager page={data.page} pages={data.pages} total={filteredTotal} per={data.per} onPage={goPage} />}
      </div>
    </section>
  );
}

function Pager({ page, pages, total, per, onPage }: { page: number; pages: number; total: number; per: number; onPage: (n: number) => void }) {
  const nums: Array<number | "…"> = [];
  for (let i = 1; i <= pages; i++) { if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i); else if (nums[nums.length - 1] !== "…") nums.push("…"); }
  return (
    <nav className="an-pager" aria-label="Pages">
      <span>{(page - 1) * per + 1}–{Math.min(total, page * per)} of {total}</span>
      <button className="an-btn an-sm" disabled={page === 1} onClick={() => onPage(page - 1)}>←</button>
      {nums.map((n, i) => n === "…" ? <span key={`e${i}`}>…</span> : <button key={n} className={`an-btn an-sm ${n === page ? "an-primary" : ""}`} aria-current={n === page ? "page" : undefined} onClick={() => onPage(n)}>{n}</button>)}
      <button className="an-btn an-sm" disabled={page === pages} onClick={() => onPage(page + 1)}>→</button>
    </nav>
  );
}

/** Row-expansion wrapper. */
function AccountDetail({ row, colSpan, prices }: { row: AccountView; colSpan: number; prices: Record<string, number | null> }) {
  return (
    <tr className="an-detail"><td colSpan={colSpan}>
      <AccountDetailBody row={row} prices={prices} />
      <div className="an-detail-foot">
        <span>Liquidation price, price scenarios, how it ranks and its transactions are on the full page.</span>
        <Link className="an-btn an-primary" href={accountHref(row.address, "overview")}>View full details <Icon name="arrow" /></Link>
      </div>
    </td></tr>
  );
}

/** A looked-up account as a card: status, the six numbers that matter, then the full detail. */
export function AccountCard({ row, prices }: { row: AccountView; prices: Record<string, number | null> }) {
  const stat = (k: React.ReactNode, v: React.ReactNode, tone?: string) => <div className="an-stat"><span>{k}</span><b style={tone ? { color: tone } : undefined}>{v}</b></div>;
  return (
    <div className="an-acard">
      <div className="an-acard-head">
        <div><div className="an-eyebrow">Margin account</div><div className="an-acard-title"><Addr value={row.owner} head={6} tail={6} /></div></div>
        <StatusBadge row={row} />
      </div>
      <div className="an-stats">
        {stat(<>Account value <InfoTip k="accountValue" /></>, usd(row.collateralUsd))}
        {stat("Debt", usd(row.debtUsd))}
        {stat("Equity", usd(row.equityUsd), (row.equityUsd ?? 0) < 0 ? "var(--danger)" : undefined)}
        {stat(<>Health <InfoTip k="health" /></>, row.healthFactor === null ? (row.valued ? "No debt" : "-") : hfText(row.healthFactor))}
        {stat("Leverage", levText(row.leverage))}
        {stat(<>Room before liquidation <InfoTip k="buffer" /></>, row.liquidatable ? "Already below the line" : row.bufferPct === null ? "-" : pct1(row.bufferPct))}
      </div>
      <AccountDetailBody row={row} prices={prices} />
    </div>
  );
}

/** Everything about one account: breakdown, liquidation prices, collateral and debt lines. */
export function AccountDetailBody({ row, prices }: { row: AccountView; prices: Record<string, number | null> }) {
  const fact = (k: React.ReactNode, v: React.ReactNode) => <div><span>{k}</span><b>{v}</b></div>;
  const liq = liquidationPrices(row, prices);
  return (
      <div className="an-detail-body">
        <MarginBreakdown row={row} />
        <div className="an-facts">
          {fact("Owner", <Addr value={row.owner} />)}
          {fact("Margin account", <Addr value={row.address} />)}
          {fact("Equity", usd(row.equityUsd))}
          {fact("Leverage", levText(row.leverage))}
          {fact(<>Room before liquidation <InfoTip k="buffer" /></>, row.liquidatable ? "Already below the line" : row.bufferPct === null ? "-" : `${pct1(row.bufferPct)} · ${usd(row.bufferUsd)}`)}
          {fact("First seen in activity", row.firstSeenTime ? <ForkTime t={row.firstSeenTime} /> : "-")}
        </div>
        {liq.length > 0 && (
          <div>
            <div className="an-eyebrow" style={{ marginBottom: 8 }}>Liquidation price <span className="an-muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>· calculated, if only that asset moves</span></div>
            <div className="an-breakdown">
              {liq.slice(0, 4).map((l) => (
                <div key={l.symbol} className="an-bcell"><span>{l.symbol} {l.direction === "down" ? "falls to" : "rises to"}</span><b>{usd(l.price)}</b><small>{l.change >= 0 ? "+" : "−"}{pct1(Math.abs(l.change))} from now</small></div>
              ))}
            </div>
          </div>
        )}
        <CollateralDebt row={row} />
      </div>
  );
}

/** Where the account's value sits: held in the account, Kamino deposits, Phoenix perps. Nothing for an account with no value. */
export function MarginBreakdown({ row }: { row: AccountView }) {
  const total = row.collateralUsd || 1;
  const mix = row.valued && (row.collateralUsd ?? 0) > 0 ? row.composition : null;
  if (!mix) return null;
  return (
    <div>
      <div className="an-eyebrow" style={{ marginBottom: 8 }}>Margin breakdown</div>
      <div className="an-breakdown">
        {([["Held in the account", mix.direct, SERIES[0]], ["Kamino deposits", mix.receipt, SERIES[1]], ["Phoenix perps", mix.venue, SERIES[2]]] as const).map(([l, v, c]) => (
          <div key={l} className="an-bcell"><span><i style={{ background: c }} />{l}</span><b>{usd(v)}</b><small>{pct1(v / total)} of account value</small></div>
        ))}
      </div>
    </div>
  );
}

/**
 * What the account holds and owes, as two tables, plus the notes that go with them (idle funds, prices not
 * updated, why an account is not valued). Shared by the Overview dropdown and the account page.
 */
export function CollateralDebt({ row }: { row: AccountView }) {
  const kind = (k: string) => (k === "receipt" ? "Deposit share" : "");
  // Same split as the Margin page: borrowed tokens still sitting in the vault are "idle" (they belong to the loan);
  // the rest of that balance was deposited or bought. idle = min(vault balance, debt in the same token).
  const owed = new Map(row.debts.map((d) => [d.symbol, d.amount]));
  const DUST_USD = 0.01;
  const lines = row.collateral.flatMap((l) => {
    if (l.kind === "venue") return [{ ...l, key: l.symbol, tag: "perps" as const }];
    const idle = Math.min(l.amount, owed.get(l.symbol) ?? 0);
    const px = l.amount > 0 ? l.usd / l.amount : 0;
    return (l.amount - idle) * px > DUST_USD ? [{ ...l, amount: l.amount - idle, usd: (l.amount - idle) * px, key: l.symbol, tag: undefined as "perps" | undefined }] : [];
  });
  // Idle funds are the borrowed tokens still in the vault: shown with the loan (Debt), not as collateral, but still counted in health.
  const vaultAmount = new Map(row.collateral.filter((l) => l.kind !== "venue").map((l) => [l.symbol, l.amount]));
  const idleOf = (symbol: string) => Math.min(vaultAmount.get(symbol) ?? 0, owed.get(symbol) ?? 0);
  const idleUsd = row.debts.reduce((s, d) => s + (d.amount > 0 ? idleOf(d.symbol) * (d.usd / d.amount) : 0), 0);
  const depositedUsd = lines.reduce((s, l) => s + l.usd, 0) || 1;

  return (
    <>
      <div className="an-detail-cols">
        <section className="an-dcard"><h4>Collateral</h4>
          {row.collateral.length ? (
            <table className="an-t"><thead><tr><th>Asset</th><th className="an-r">Amount</th><th className="an-r">Value</th><th className="an-r">Share</th></tr></thead>
              <tbody>{lines.map((l) => (
                <tr key={l.key}>
                  <td className="an-nowrap">
                    <span className="an-assetrow">
                    <AssetCell symbol={l.symbol} sub={l.kind === "receipt" ? kind(l.kind) : ""} size="sm" />
                    {l.tag && <span className="an-tag" data-tip="The Phoenix perps account, valued as one lump." tabIndex={0}>{l.tag}</span>}
                    </span>
                  </td>
                  <td className="an-r">{l.kind === "venue" ? "-" : num(l.amount)}</td><td className="an-r">{usd(l.usd)}</td><td className="an-r">{pct1(l.usd / depositedUsd)}</td>
                </tr>
              ))}</tbody></table>
          ) : <p className="an-muted an-dcard-empty">{row.valued ? "No active collateral." : "Not valued right now."}</p>}
        </section>
        <section className="an-dcard"><h4>Debt</h4>
          {row.debts.length ? (
            <table className="an-t"><thead><tr><th>Asset</th><th className="an-r">Debt</th><th className="an-r">Value</th><th className="an-r">APR</th></tr></thead>
              <tbody>{row.debts.map((l) => (
                <tr key={l.symbol}><td className="an-nowrap"><span className="an-assetrow"><AssetCell symbol={l.symbol} sub="" size="sm" />
                  {idleOf(l.symbol) * (l.amount > 0 ? l.usd / l.amount : 0) > DUST_USD && <span className="an-tag" data-tip="Borrowed funds still in the account. They count toward health until used or repaid." tabIndex={0}>{num(idleOf(l.symbol))} idle</span>}</span></td><td className="an-r">{num(l.amount)}</td><td className="an-r">{usd(l.usd)}</td><td className="an-r">{pct(l.borrowApr)}</td></tr>
              ))}</tbody></table>
          ) : <p className="an-muted an-dcard-empty">{row.valued ? "No outstanding debt." : "Not valued right now."}</p>}
        </section>
      </div>
      {idleUsd > DUST_USD && <p className="an-panel-foot" style={{ padding: 0 }}>The account value above also includes {usd(idleUsd)} of borrowed funds still idle in the account (shown with the debt). They count toward health until they are used or repaid.</p>}
      {row.reasons.length > 0 && <p className="an-panel-foot" style={{ color: "var(--warn)", padding: 0 }}>{row.reasons.map(reasonText).join(" ")}</p>}
      {!!row.stalePrices?.length && <p className="an-panel-foot" style={{ padding: 0 }}>Valued at the last on-chain price of {row.stalePrices.join(", ")}, which had not been updated recently when this was read. It refreshes as soon as the price does.</p>}
      {row.venueHeld && row.valued && <p className="an-panel-foot" style={{ padding: 0 }}>Its Phoenix perps account is counted as one lump value (collateral plus position equity). Individual positions are not shown, so this account is left out of What-if scenarios.</p>}
    </>
  );
}
