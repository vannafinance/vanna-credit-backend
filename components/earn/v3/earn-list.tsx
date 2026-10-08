"use client";

/**
 * Earn landing (V3 design `#earn`): promo banner, the wallet's dashboard (Overall Deposit + Net
 * Earnings charts, connected only), then Vaults | Positions with the pool filters and search.
 *
 * Data: live pool Reserve state (GET /api/pools), the wallet's lender positions and its decoded
 * supply / withdraw events (hooks/use-earn.ts), oracle prices. Only real Vanna lending pools.
 */
import "./earn-v3.css";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/components/v3/ui";
import { IC, Icon } from "@/components/v3/icons";
import { usd } from "@/components/v3/format";
import { LENDING_TOKENS, TOKENS } from "@/lib/solana/tokens";
import type { SerializedPoolState } from "@/lib/solana/protocol-state";
import { ChartCard } from "./earn-chart";
import { LiveTable, type Col, type Row } from "./earn-table";
import { NoData, SV, usePop } from "./earn-ui";
import { fP, fT, usdOr } from "./earn-format";
import { seriesFor, useEarnV3 } from "./use-earn-v3";
import type { Tf } from "./earn-series";

const VCOLS: Col[] = [
  { id: "pool", label: "Pool" },
  { id: "sup", label: "Assets Supplied", sort: true },
  { id: "sapy", label: "Supply APY", sort: true },
  { id: "bor", label: "Assets Borrowed", sort: true },
  { id: "bapy", label: "Borrow APY", sort: true },
  { id: "util", label: "Utilization Rate", sort: true },
  { id: "your", label: "Your Supply", sort: true },
];
const PCOLS: Col[] = [
  { id: "pool", label: "Pool" },
  { id: "sup", label: "Assets Supplied", sort: true },
  { id: "sapy", label: "Supply APY", sort: true },
  { id: "bapy", label: "Borrow APY", sort: true },
  { id: "util", label: "Utilization Rate", sort: true },
];

/** Pool cell (logo, symbol, on-chain status tag). */
const poolCell = (sym: string, pool: SerializedPoolState | undefined) => ({
  ic: sym,
  chain: true,
  t: sym,
  text: sym,
  st: [pool ? (pool.initialised ? pool.status : "Not initialised") : "Active"],
});

/** Earn list screen. */
export function EarnList({ initialTab = "vaults" }: { initialTab?: "vaults" | "positions" }) {
  const router = useRouter();
  const d = useEarnV3();
  const [tab, setTab] = useState<"vaults" | "positions">(initialTab);
  const [q, setQ] = useState("");
  const [selPools, setSelPools] = useState<string[]>([]);
  const [dep, setDep] = useState<string[]>([]);
  const [apy, setApy] = useState<{ gt: boolean; v: number }>({ gt: false, v: 0 });
  const [apyText, setApyText] = useState("");
  const [popq, setPopq] = useState("");
  const [mflt, setMflt] = useState(false);
  const [tfDep, setTfDep] = useState<Tf>("3 Months");
  const [tfNet, setTfNet] = useState<Tf>("3 Months");
  const pop = usePop();
  const connected = Boolean(d.address);

  const go = (sym: string, positions?: boolean) => router.push(`/earn/${sym}${positions ? "?tab=your-positions" : ""}`);

  // ── dashboard series ──────────────────────────────────────────────────────────────────────
  const syms = TOKENS.map((t) => t.symbol);
  const depS = useMemo(() => seriesFor("dep", tfDep, syms, d.seriesInput, d.now, d.depositUsd), [tfDep, d.seriesInput, d.now, d.depositUsd]); // eslint-disable-line react-hooks/exhaustive-deps
  const netS = useMemo(() => seriesFor("net", tfNet, syms, d.seriesInput, d.now, null), [tfNet, d.seriesInput, d.now]); // eslint-disable-line react-hooks/exhaustive-deps

  // Share-rounding residue (±$0.000001 right after a supply) is not a loss: show $0.00, not −$0.00.
  const netValue = d.earnedSummary.usd === null ? "—" : usd(Math.abs(d.earnedSummary.usd) < 0.005 ? 0 : d.earnedSummary.usd);
  const depNote =
    d.depositMissingPrice.length > 0
      ? `Excludes ${d.depositMissingPrice.join(", ")} (no oracle price right now).`
      : depS.excluded.length > 0 && d.depositUsd > 0
        ? `Past values can't be rebuilt for ${depS.excluded.join(", ")} (shares moved outside supply / withdraw, or older than the scanned history), so only today's value is drawn.`
        : null;
  const netNote = d.historyLoading
    ? "Reading your supply history from chain…"
    : d.earnedSummary.usd === null
      ? d.earnedSummary.unknownSymbols.length
        ? "Earned interest can't be proven from your on-chain history (positions opened outside the scanned history)."
        : null
      : d.earnedSummary.partial
        ? `Partial — excludes ${d.earnedSummary.unknownSymbols.join(", ")} (cost basis not provable from on-chain history).`
        : null;

  // ── tables ────────────────────────────────────────────────────────────────────────────────
  const vaultRows: Row[] = useMemo(
    () =>
      LENDING_TOKENS.map((t) => {
        const s = t.symbol;
        const p = d.pools[s];
        const px = d.prices[s] ?? 0;
        const mine = d.supplied[s] ?? 0;
        const ok = Boolean(p?.initialised);
        return {
          key: s,
          onClick: () => go(s),
          cells: [
            poolCell(s, p),
            ok ? { t: `${fT(p.totalSupplied)} ${s}`, v: p.totalSupplied * px, tags: [usdOr(p.totalSupplied, px)] } : { t: "—" },
            ok ? { t: fP(p.supplyApr * 100), v: p.supplyApr * 100, tags: [fP(p.supplyApr * 100)] } : { t: "—" },
            ok ? { t: `${fT(p.totalBorrowed)} ${s}`, v: p.totalBorrowed * px, tags: [usdOr(p.totalBorrowed, px)] } : { t: "—" },
            ok ? { t: fP(p.borrowApr * 100), v: p.borrowApr * 100, tags: [fP(p.borrowApr * 100)] } : { t: "—" },
            ok ? { t: fP(p.utilization * 100), v: p.utilization * 100, tags: [fP(p.utilization * 100)] } : { t: "—" },
            connected ? { t: `${fT(mine)} ${s}`, v: mine * px, tags: [usdOr(mine, px)] } : { t: "—", v: 0, tags: ["Connect wallet"] },
          ],
        };
      }),
    [d.pools, d.prices, d.supplied, connected], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Every registry token with a position (a pool no longer offered stays visible: withdraw-only).
  const positionRows: Row[] = useMemo(
    () =>
      !connected
        ? []
        : TOKENS.filter((t) => (d.supplied[t.symbol] ?? 0) > 0).map((t) => {
            const s = t.symbol;
            const p = d.pools[s];
            const v = d.supplied[s];
            const px = d.prices[s] ?? 0;
            return {
              key: s,
              onClick: () => go(s, true),
              cells: [
                poolCell(s, p),
                { t: `${fT(v)} ${s}`, v: v * px, tags: [usdOr(v, px)] },
                { t: fP((p?.supplyApr ?? 0) * 100), tags: [fP((p?.supplyApr ?? 0) * 100)] },
                { t: fP((p?.borrowApr ?? 0) * 100), tags: [fP((p?.borrowApr ?? 0) * 100)] },
                { t: fP((p?.utilization ?? 0) * 100), tags: [fP((p?.utilization ?? 0) * 100)] },
              ],
            };
          }),
    [connected, d.supplied, d.pools, d.prices], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const filterRows = (rows: Row[]) => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      const sym = r.key;
      if (qq && !r.cells.some((c) => String(c.text ?? (typeof c.t === "string" ? c.t : "")).toLowerCase().includes(qq))) return false;
      if (selPools.length && !selPools.includes(sym)) return false;
      if (dep.length && !dep.includes(sym)) return false;
      if (apy.v > 0) {
        const p = d.pools[sym];
        const v = p ? p.supplyApr * 100 : null;
        if (v === null || (apy.gt ? !(v > apy.v) : !(v < apy.v))) return false;
      }
      return true;
    });
  };

  // ── filter controls ───────────────────────────────────────────────────────────────────────
  const OPTS = LENDING_TOKENS.map((t) => t.symbol);
  const optList = (list: string[], set: (l: string[]) => void) => {
    const opts = OPTS.filter((s) => !popq.trim() || s.toLowerCase().includes(popq.trim().toLowerCase()));
    return (
      <div className="earn-opts">
        {opts.length ? (
          opts.map((s) => (
            <button key={s} type="button" className="earn-opt" role="checkbox" aria-checked={list.includes(s)} onClick={() => set(list.includes(s) ? list.filter((x) => x !== s) : [...list, s])}>
              <span className={`earn-cb${list.includes(s) ? " on" : ""}`}>{list.includes(s) ? SV.check : null}</span>
              <Icon sym={s} className="earn-i16" />
              <span>{s}</span>
            </button>
          ))
        ) : (
          <div className="earn-optnone">No results found</div>
        )}
      </div>
    );
  };
  const multiPop = (list: string[], set: (l: string[]) => void, ph: string, right?: boolean) => (
    <div className={`pop earn-pop${right ? " r" : ""}`} role="dialog" aria-label={ph}>
      <label className="earn-search in">
        {SV.search}
        <input placeholder={`Search for ${ph}`} value={popq} onChange={(e) => setPopq(e.target.value)} aria-label={`Search ${ph}`} />
      </label>
      {list.length > 0 && (
        <div className="earn-selh">
          <span>{list.length} selected</span>
          <button
            type="button"
            onClick={() => {
              set([]);
              pop.close();
            }}
          >
            Clear
          </button>
        </div>
      )}
      {optList(list, set)}
    </div>
  );
  const openPop = (id: string) => {
    setPopq("");
    pop.toggle(id);
  };
  const poolsTxt = !selPools.length ? "All Pools" : selPools.length > 2 ? `${selPools.slice(0, 2).join(", ")} +${selPools.length - 2} more` : selPools.join(", ");
  const poolsDd = (
    <div className="earn-ddw" data-earn-pop="pools">
      <button type="button" className="earn-dd" aria-expanded={pop.open === "pools"} onClick={() => openPop("pools")}>
        <span className="earn-ddi">
          <Icon sym="SOL" className="earn-i16" />
        </span>
        <span>{poolsTxt}</span>
        <span className="earn-ddc">{SV.chev}</span>
      </button>
      {pop.open === "pools" && multiPop(selPools, setSelPools, "pools")}
    </div>
  );
  const search = (ph: string) => (
    <label className="earn-search">
      {SV.search}
      <input placeholder={ph} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search pools" />
    </label>
  );
  const depDd = (
    <div className="earn-depw" data-earn-pop="dep">
      <span className="earn-depk">Deposit:</span>
      {dep.length ? (
        <>
          <button type="button" className="earn-depsel" onClick={() => openPop("dep")}>
            {dep.join(", ")}
          </button>
          <button type="button" className="earn-depx" aria-label="Clear deposit filter" onClick={() => setDep([])}>
            {IC.x}
          </button>
        </>
      ) : (
        <button type="button" className="earn-depv" aria-expanded={pop.open === "dep"} onClick={() => openPop("dep")}>
          {SV.filter}All
        </button>
      )}
      {pop.open === "dep" && multiPop(dep, setDep, "deposit", true)}
    </div>
  );
  const apyChip = apy.v > 0 ? `${apy.gt ? ">" : "<"}${apy.v}` : "Anything";
  const apyDd = (
    <div className="earn-apyw" data-earn-pop="apy">
      <button type="button" className="earn-apyb" aria-expanded={pop.open === "apy"} onClick={() => pop.toggle("apy")}>
        <span>Supply APY is</span>
        <span className="earn-apyc">{apyChip}</span>
      </button>
      {pop.open === "apy" && (
        <section className="pop earn-pop r apy" aria-label="Supply APY Filter">
          <button
            type="button"
            className="earn-reset"
            onClick={() => {
              setApy((a) => ({ ...a, v: 0 }));
              setApyText("");
            }}
          >
            Reset
          </button>
          <div className="earn-gl">
            <button type="button" className={apy.gt ? "on" : ""} onClick={() => setApy((a) => ({ ...a, gt: true }))}>
              Greater than
            </button>
            <button type="button" className={apy.gt ? "" : "on"} onClick={() => setApy((a) => ({ ...a, gt: false }))}>
              Less than
            </button>
          </div>
          <label className="earn-apyin">
            <span className="earn-sr">APY Percentage</span>
            <input
              inputMode="decimal"
              placeholder="Enter Amount"
              value={apyText}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, "");
                setApyText(v);
                setApy((a) => ({ ...a, v: parseFloat(v) || 0 }));
              }}
            />
          </label>
        </section>
      )}
    </div>
  );

  const tableArea = () => {
    if (tab === "positions") {
      if (!connected) return <NoData text="Connect your wallet to see your positions" />;
      const rows = filterRows(positionRows);
      return rows.length ? <LiveTable cols={PCOLS} rows={rows} /> : <NoData />;
    }
    const rows = filterRows(vaultRows);
    return rows.length ? <LiveTable cols={VCOLS} rows={rows} /> : <NoData text={d.poolsLoading ? "Loading pools…" : undefined} />;
  };

  return (
    <div className="earn">
      <section className="earn-bnw">
        <Banner page="earn" />
      </section>
      {connected && (
        <section className="earn-dash" aria-label="Protocol Dashboard">
          <article>
            <ChartCard
              label="Overall Deposit"
              tip="Value of your Earn supplies today, interest included, at current oracle prices."
              value={usd(d.depositUsd)}
              tf={tfDep}
              onTf={setTfDep}
              pts={depS.pts}
              kind="dep"
              note={depNote}
            />
          </article>
          <article>
            <ChartCard
              label="Net Earnings"
              tip="Interest earned on your Earn supplies: current value minus what you supplied, plus interest already withdrawn. Rebuilt from your on-chain supply / withdraw history."
              value={netValue}
              tf={tfNet}
              onTf={setTfNet}
              pts={d.earnedSummary.usd === null ? [] : netS.pts}
              kind="net"
              empty={d.historyLoading ? "Reading your supply history…" : "Earned interest can't be proven from your history"}
              note={netNote}
            />
          </article>
        </section>
      )}
      <section className="earn-tsec" aria-label="Vaults and Positions">
        <div className="earn-bar">
          <div className="earn-tabsrow">
            <nav className="earn-seg" aria-label="Table Navigation Tabs">
              <button type="button" className={tab === "vaults" ? "on" : ""} onClick={() => setTab("vaults")}>
                Vaults
              </button>
              <button type="button" className={tab === "positions" ? "on" : ""} onClick={() => setTab("positions")}>
                Positions
              </button>
            </nav>
          </div>
          <div className="earn-flt">
            {poolsDd}
            {search("Search for Pools")}
            <span className="earn-sp" />
            {depDd}
            {apyDd}
          </div>
          <div className="earn-mflt">
            <div className="earn-mfr">
              {search("Search pools...")}
              <button type="button" className={`earn-mfb${mflt ? " on" : ""}`} onClick={() => setMflt((m) => !m)}>
                {SV.filt14}Filter
              </button>
            </div>
            {mflt && (
              <div className="earn-mfp">
                {poolsDd}
                {depDd}
                {apyDd}
              </div>
            )}
          </div>
        </div>
        <div className="earn-tarea">{tableArea()}</div>
      </section>
    </div>
  );
}
