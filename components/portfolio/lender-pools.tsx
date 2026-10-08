"use client";

/**
 * Portfolio → Lender → Lending pools: Lender Stats, the 30-day Lending P&L chart and the Positions
 * Table (Current position | Position history). Positions = the wallet's Vanna lending shares at the
 * pool's live exchange rate (`useUserPositions`), APY from the program's rate curve (`usePoolData`),
 * interest and history decoded from the wallet's own supply / redeem events (`useEarnTransactions`).
 * Supply more / Withdraw hand off to the Earn pool page.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, IC } from "@/components/v3/icons";
import { pct, sUsd, tokFmt, usd } from "@/components/v3/format";
import { TOKENS } from "@/lib/solana/tokens";
import type { Portfolio } from "./use-portfolio";
import { lendingPnlSeries } from "./portfolio-math";
import { Badge, ChartCard, Ct, Dropdown, EYE_IC, FILTER_IC, Grid, HistNav, InfoCard, Success, TT, Tag, TxCell, when } from "./pf-ui";

const HIST_COLS = ".9fr .9fr 1.8fr .7fr 1fr";
const HIST_HEADS = ["Date", "Type", "Amount", "Status", "Tx Hash"];
const COLS = ["Amount Supplied", "Supply APY", "Earned", "Value"] as const;
type Col = (typeof COLS)[number];

export function LendingPools({ p }: { p: Portfolio }) {
  const router = useRouter();
  const [view, setView] = useState<"cur" | "hist">("cur");
  const [pool, setPool] = useState("All");
  const [hide, setHide] = useState<Col[]>([]);
  const { px, lendPositions, pools, earn } = p;
  // Captured once per mount: the chart's "now" (a render-time clock would make the series impure).
  const [mountedAt] = useState(() => Date.now());

  const rows = useMemo(
    () =>
      TOKENS.map(({ symbol }) => {
        const pos = lendPositions[symbol];
        const amt = pos?.assets ?? 0;
        const e = earn.earned?.[symbol];
        const earned = e ? e.earned : null;
        return {
          sym: symbol,
          amt,
          apy: (pools[symbol]?.supplyApr ?? 0) * 100,
          val: amt * (px[symbol] ?? 0),
          earned,
          earnUsd: earned === null ? null : earned * (px[symbol] ?? 0),
        };
      }).filter((r) => r.amt > 0),
    [lendPositions, pools, px, earn.earned],
  );
  const sup = rows.reduce((t, r) => t + r.val, 0);
  const avgApy = sup > 0 ? rows.reduce((t, r) => t + r.val * r.apy, 0) / sup : 0;
  const earned = p.totals.lendEarned;

  const series = useMemo(
    () => lendingPnlSeries(earn.history, lendPositions, earn.earned, px, mountedAt),
    [earn.history, lendPositions, earn.earned, px, mountedAt],
  );

  const stats = (
    <InfoCard
      title="Lender Stats"
      rows={[
        ["Total Holdings", usd(sup), "", TT.holdings],
        ["Supplied Assets", String(rows.length)],
        ["Avg Supply APY", pct(avgApy), rows.length ? "pf-up" : ""],
        ["Interest earned", earned === null ? "—" : sUsd(earned), earned !== null && earned > 0.004 ? "pf-up" : "", TT.lendInt],
      ]}
    />
  );
  const chart = (
    <ChartCard
      title="Lending P&L"
      value={earned === null ? "—" : sUsd(earned)}
      sub="30D"
      series={series ? [{ name: "Interest earned", color: "var(--pf-c-l)", pts: series.pts }] : null}
      labels={series?.labels}
      empty={earn.isLoading ? "Loading history…" : "No history yet"}
      min={0}
    />
  );

  const history = earn.transactions.filter((x) => pool === "All" || x.symbol === pool);
  if (!rows.length && !earn.transactions.length)
    return (
      <>
        <div className="pf-row2">
          {stats}
          {chart}
        </div>
        <div className="pf-emptyc">
          {p.lendLoading ? "Loading lending positions…" : "No lending positions yet. Supply assets on the Earn page to start earning."}
          <button type="button" className="pf-lnk" onClick={() => router.push("/earn")}>
            Go to Earn
          </button>
        </div>
      </>
    );

  const colDefs: [Col, string, (r: (typeof rows)[number]) => React.ReactNode][] = [
    ["Amount Supplied", "1.3fr", (r) => <Ct tags={<Tag>{usd(r.val)}</Tag>}>{tokFmt(r.amt, r.sym)}</Ct>],
    ["Supply APY", ".8fr", (r) => <Ct>{pct(r.apy)}</Ct>],
    [
      "Earned",
      ".9fr",
      (r) =>
        r.earnUsd === null ? (
          <Ct desc="history can't prove the cost basis">—</Ct>
        ) : (
          <Ct desc={tokFmt(r.earned ?? 0, r.sym)}>
            <span className="pos">{sUsd(r.earnUsd)}</span>
          </Ct>
        ),
    ],
    ["Value", "1fr", (r) => <Ct>{usd(r.val)}</Ct>],
  ];
  const vis = colDefs.filter((c) => !hide.includes(c[0]));
  const goEarn = (sym: string) => router.push(`/earn/${sym}?tab=your-positions`);

  const filter = (
    <Dropdown
      right
      trigger={(open, toggle) => (
        <button type="button" className="pf-allf" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <b>{pool === "All" ? "All:" : "Pool:"}</b>
          {pool === "All" ? (
            FILTER_IC
          ) : (
            <>
              <Icon sym={pool} className="ico pf-i16" />
              <span className="pf-allv">{pool}</span>
            </>
          )}
        </button>
      )}
    >
      {(close) =>
        ["All", ...rows.map((r) => r.sym)].map((x) => (
          <button
            key={x}
            type="button"
            className={`mi ${pool === x ? "on" : ""}`}
            onClick={() => {
              setPool(x);
              close();
            }}
          >
            {x === "All" ? (
              <>
                <span className="pf-mi-ic">{FILTER_IC}</span>All pools
              </>
            ) : (
              <>
                <Icon sym={x} className="ico pf-i20" />
                {x}
              </>
            )}
            {pool === x && <span className="pf-mi-ok">{IC.check}</span>}
          </button>
        ))
      }
    </Dropdown>
  );
  const customize = (
    <Dropdown
      right
      trigger={(open, toggle) => (
        <button type="button" className="pf-cust" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          {EYE_IC}Customize {IC.chev}
        </button>
      )}
    >
      {() => (
        <>
          <div className="pf-pop-h">Columns</div>
          {COLS.map((c) => (
            <button key={c} type="button" className="mi" onClick={() => setHide((h) => (h.includes(c) ? h.filter((x) => x !== c) : [...h, c]))}>
              <span className={`pf-cb ${hide.includes(c) ? "" : "on"}`}>{IC.check}</span>
              {c}
            </button>
          ))}
        </>
      )}
    </Dropdown>
  );

  return (
    <>
      <div className="pf-row2">
        {stats}
        {chart}
      </div>
      <section className="pf-tbl">
        <header className="pf-tblh">
          <h2>Positions Table</h2>
          <div className="pf-tools">
            {filter}
            {view === "cur" && customize}
          </div>
        </header>
        <div className="pf-tbar">
          <HistNav value={view} onChange={setView} />
        </div>
        {view === "hist" ? (
          <Grid
            cols={HIST_COLS}
            heads={HIST_HEADS}
            empty={earn.isLoading ? "Loading history…" : "No transactions yet"}
            rows={history.map((x, i) => ({
              key: `${x.signature}-${i}`,
              cells: [
                <Ct key="d">{when(x.timestamp)}</Ct>,
                <Badge key="t" act={x.type === "supply" ? "Supply" : "Withdraw"} />,
                <Ct key="a" desc={usd((parseFloat(x.amount) || 0) * (px[x.symbol] ?? 0))}>
                  <Icon sym={x.symbol} className="ico pf-i16" />
                  {(x.type === "supply" ? "+" : "−") + tokFmt(parseFloat(x.amount) || 0, x.symbol)}
                </Ct>,
                <Success key="s" />,
                <TxCell key="h" sig={x.signature} />,
              ],
            }))}
          />
        ) : (
          <Grid
            cols={["1fr", ...vis.map((c) => c[1]), "1.25fr"].join(" ")}
            heads={["Pool", ...vis.map((c) => c[0]), ""]}
            empty="No positions in this pool"
            rows={rows
              .filter((r) => pool === "All" || r.sym === pool)
              .map((r) => ({
                key: r.sym,
                onClick: () => goEarn(r.sym),
                cells: [
                  <>
                    <span className="pf-pool">
                      <Icon sym={r.sym} className="ico pf-i16" />
                      {r.sym}
                    </span>
                    <span className="pf-tags">
                      <Tag cls="pf-t-on">Active</Tag>
                    </span>
                  </>,
                  ...vis.map((c) => c[2](r)),
                  <span className="pf-acts" key="acts">
                    <button
                      type="button"
                      className="pf-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/earn/${r.sym}?tab=your-positions&action=supply`);
                      }}
                    >
                      Supply more
                    </button>
                    <button
                      type="button"
                      className="pf-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/earn/${r.sym}?tab=your-positions&action=withdraw`);
                      }}
                    >
                      Withdraw
                    </button>
                  </span>,
                ],
              }))}
          />
        )}
      </section>
    </>
  );
}
