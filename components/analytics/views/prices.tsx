"use client";

/** Prices: each asset's on-chain price, how recently it was updated, and the limits the protocol applies. */
import { useState } from "react";
import { useAnalyticsProtocol } from "@/hooks/use-analytics";
import { finite, priceSourceLabel, usd } from "@/lib/analytics/format";
import { TOKENS } from "@/lib/solana/tokens";
import { KAMINO_RECEIPTS } from "@/lib/solana/kamino";
import { AssetCell, Badge, Empty, Icon, InfoTip, Kpi } from "../ui";
import { Meter } from "../charts";
import { ViewHead } from "../shell";

type St = "fresh" | "old" | "none";
const STATUSES: Array<["all" | St, string]> = [["all", "All"], ["fresh", "Up to date"], ["old", "Not updated"], ["none", "No price"]];

export function PricesView() {
  const { data, isError } = useAnalyticsProtocol();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | St>("all");
  const all = TOKENS.map((t) => {
    const p = data?.prices[t.symbol] ?? null;
    const st: St = !p || !finite(p.usd) ? "none" : p.stale ? "old" : "fresh";
    return { t, p, st };
  });
  const count = (s: St) => all.filter((r) => r.st === s).length;
  const list = all.filter((r) => (!q.trim() || `${r.t.symbol} ${r.t.name}`.toLowerCase().includes(q.trim().toLowerCase())) && (filter === "all" || r.st === filter));

  return (
    <>
      <ViewHead title="Prices" blurb="The on-chain prices the protocol uses, and how recently each was updated." />
      <div className="an-kpi-grid an-cols-3">
        <Kpi label="Prices up to date" tip="oracleFresh" value={data ? `${count("fresh")} / ${all.length}` : "-"} na={!data} tone={data && count("fresh") === all.length ? "ok" : "warn"} sub={data ? "Updated within the time the protocol allows" : isError ? "Couldn't reach the service." : "Loading…"} />
        <Kpi label="Not updated recently" value={data ? String(count("old")) : "-"} na={!data} tone={count("old") ? "warn" : ""} sub={count("old") ? "Accounts use the last on-chain price until they update" : "None"} />
        <Kpi label="No price" value={data ? String(count("none")) : "-"} na={!data} tone={count("none") ? "warn" : ""} sub="No usable price found on-chain" />
      </div>
      <div className="an-row">
        <label className="an-input-wrap"><Icon name="search" /><input className="an-input" placeholder="Search asset" aria-label="Search assets" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <div className="an-seg" role="group" aria-label="Price status">{STATUSES.map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}</div>
        <span className="an-muted">{list.length} assets shown</span>
      </div>
      <div className="an-rcards" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(290px,1fr))" }}>
        {list.map(({ t, p, st }) => {
          const limit = p?.maxAgeSecs ?? null, age = p?.ageSecs ?? null;
          const frac = finite(limit) && finite(age) && limit > 0 ? age / limit : null;
          const uses = [t.lendable ? "Lending pool" : null, "Margin collateral", ...KAMINO_RECEIPTS.filter((x) => x.underlying === t.symbol).map((x) => `${x.symbol} (Kamino deposit)`)].filter(Boolean).join(" · ");
          return (
            <article className="an-oracle-card" key={t.symbol}>
              <div className="an-row an-between"><AssetCell symbol={t.symbol} /><Badge tone={st === "fresh" ? "ok" : "warn"}>{st === "fresh" ? "Up to date" : st === "old" ? "Not updated" : "No price"}</Badge></div>
              <div>
                <div style={{ fontSize: 24, fontWeight: 700, color: st === "fresh" ? undefined : "var(--ink-3)" }}>{p && finite(p.usd) && p.usd > 0 ? usd(p.usd) : "-"}</div>
                {st === "old" && <div style={{ fontSize: 12, color: "var(--warn, var(--critical))", fontWeight: 600 }}>Last price seen on-chain · accounts use it until the next update</div>}
                <div className="an-muted" style={{ fontSize: 12.5 }}>{p?.feed ? priceSourceLabel(p.feed) : "No price source"}</div>
              </div>
              <div className="an-fresh-box">
                <div className="an-k">Last updated <InfoTip k="oracleFresh" /></div>
                <div className="an-v">{finite(age) ? age : "-"}<small>{"\u00a0"}seconds ago{finite(limit) ? ` · allowed up to ${limit}s` : ""}</small></div>
                <Meter fraction={frac} tone={st === "old" || (frac ?? 0) >= 1 ? "danger" : (frac ?? 0) >= 0.75 ? "warn" : ""} />
              </div>
              {p && finite(p.maxTwapDivergenceBps) && (
                <details className="an-more"><summary>Price safety limits</summary>
                  <dl className="an-kv" style={{ fontSize: 13 }}>
                    <div><dt>Max age</dt><dd>{p.maxAgeSecs}s</dd></div>
                    <div><dt>Max price swing vs average</dt><dd>{(p.maxTwapDivergenceBps! / 100).toFixed(2)}%</dd></div>
                    <div><dt>Max uncertainty</dt><dd>{((p.maxConfidenceBps ?? 0) / 100).toFixed(2)}%</dd></div>
                  </dl>
                </details>
              )}
              <div className="an-muted" style={{ fontSize: 12 }}>Used by: {uses}</div>
            </article>
          );
        })}
        {!list.length && <Empty title={data ? "No assets match" : "Loading prices…"} text={data ? "Change the search or filter." : undefined} icon="search" />}
      </div>
    </>
  );
}
