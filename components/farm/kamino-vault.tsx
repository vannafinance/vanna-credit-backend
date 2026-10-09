"use client";

/**
 * V3 Kamino vault page (/farm/:id) — the design's `kamView`: back link, title + tags, Kamino stats
 * bar, All Transactions | Analytics panel, and the Supply / Withdraw column ({@link KaminoAction}).
 *
 * Data: Kamino reserve metrics (`useFarmPool`), the margin account's cTokens for this vault and their
 * earnings ({@link useFarmAccount}), this vault's farm-deposit / farm-withdraw events from the margin
 * account's on-chain history. There is no position-value time series on chain, so the position summary
 * shows today's value and earned yield.
 */
import "./farm-v3.css";
import { useState } from "react";
import { Icon, IC } from "@/components/v3/icons";
import { Info, Seg } from "@/components/v3/ui";
import { cmp, nf, pct, tokFmt, usd } from "@/components/v3/format";
import { explorerUrl } from "@/lib/solana/config";
import { useFarmPool } from "@/lib/farm/use-farm";
import type { FarmPoolConfig } from "@/lib/farm/pools";
import { useFarmAccount, type FarmPositionRow } from "./use-farm-account";
import { KaminoAction } from "./kamino-action";
import { BackLink, Cell, CheckDropdown, HowItWorks, TabsBox, Tiles, Venue, VTag, YieldList, useOutside } from "./fm-ui";

const COLS = {
  current: [
    ["Asset", "1.2fr"],
    ["Protocol", "1fr"],
    ["Supplied", "1.2fr"],
    ["Receipt balance", "1.2fr"],
    ["APY", ".8fr"],
  ],
  history: [
    ["Date", "1.1fr"],
    ["Type", ".9fr"],
    ["Amount", "1.1fr"],
    ["Status", ".8fr"],
    ["Tx Hash", "1fr"],
  ],
} as const;
type TxTab = keyof typeof COLS;

const m = (v: number | null, kind: "pct" | "usd") => (kind === "pct" ? pct(v !== null && Number.isFinite(v) ? v * 100 : 0) : usd(v !== null && Number.isFinite(v) ? v : 0));

export function KaminoVault({ id }: { id: string }) {
  const { pool, isLoading } = useFarmPool(id);
  const farm = useFarmAccount();
  const [left, setLeft] = useState<"tx" | "an">("tx");

  if (!pool) {
    return (
      <div className="v3">
        <div className="page">
          <BackLink />
          <section className="fm-nf">
            <h1>{isLoading ? "Loading pool…" : "Pool not found"}</h1>
            {!isLoading && <p>&ldquo;{id}&rdquo; isn&apos;t a Farm vault.</p>}
          </section>
        </div>
      </div>
    );
  }
  const position = farm.rows.find((r) => r.poolId === pool.id) ?? null;
  const stat = (l: string, v: string) => (
    <article>
      <div className="lbl">{l}</div>
      <div className="fm-sv">{v}</div>
    </article>
  );

  return (
    <div className="v3">
      <div className="page">
        <BackLink />
        <div className="fm-vh">
          <Icon sym={pool.symbol} className="fm-ico28" />
          <h1>{pool.symbol}</h1>
          <span className="fm-tag">Vault</span>
          <VTag name="Kamino" />
        </div>
        <section className="fm-stats num">
          {stat("Supply APY", m(pool.supplyApy, "pct"))}
          {stat("Borrow APY", m(pool.borrowApy, "pct"))}
          {stat("Utilization Rate", m(pool.utilization, "pct"))}
          {stat("Total Pool Supply", m(pool.totalSupplyUsd, "usd"))}
        </section>
        <div className="fm-cols">
          <div className="fm-main">
            <TabsBox
              items={[
                ["tx", "All Transactions"],
                ["an", "Analytics"],
              ]}
              value={left}
              onChange={setLeft}
            />
            <div className="fm-panel kp">{left === "an" ? <Analytics pool={pool} /> : <Transactions pool={pool} position={position} farm={farm} />}</div>
          </div>
          <aside className="fm-aside">
            <KaminoAction pool={pool} position={position} />
            <Tiles
              items={[
                ["Total Value Locked", m(pool.totalSupplyUsd, "usd")],
                ["Supply APY", m(pool.supplyApy, "pct")],
              ]}
            />
            <YieldList
              rows={[
                ["Your Position", usd(position ? position.liquidityUsd : 0)],
                ["Receipt", pool.receiptSymbol],
              ]}
            />
            <HowItWorks
              steps={[
                ["Choose a vault", "Pick the asset to supply to Kamino"],
                ["Supply from your margin account", "Supply the asset already in your margin account (deposited, borrowed or swapped in) to Kamino"],
                ["Earn Kamino supply yield", "The cTokens stay in your margin account and count toward its health factor"],
                ["Withdraw anytime", "Redeem back into your margin account, then repay or withdraw on the Margin page"],
              ]}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function Analytics({ pool }: { pool: FarmPoolConfig }) {
  const sc = (h: string, main: string, sub: string, tip: string) => (
    <div className="fm-sc">
      <div className="lbl">
        {h} <Info text={tip} />
      </div>
      <b>{main}</b>
      <span>{sub}</span>
    </div>
  );
  const tok = (v: number | null) => `${cmp(v ?? 0)} ${pool.symbol}`;
  return (
    <>
      <h2 className="fm-h21">Statistics</h2>
      <div className="fm-scg num">
        {sc("Supply APY", m(pool.supplyApy, "pct"), "Annual yield on supplied assets", `The yearly yield Kamino pays on ${pool.symbol} supplied to this reserve (Kamino main market).`)}
        {sc("Borrow APY", m(pool.borrowApy, "pct"), "Annual cost to borrow on Kamino", `The yearly rate Kamino charges people who borrow ${pool.symbol} from this reserve.`)}
        {sc("Utilization", m(pool.utilization, "pct"), "Borrowed / Total Supply", "The share of this reserve that is lent out right now.")}
        {sc("Total Supply", tok(pool.totalSupply), m(pool.totalSupplyUsd, "usd"), `All ${pool.symbol} supplied to this Kamino reserve, by everyone.`)}
        {sc("Total Borrow", tok(pool.totalBorrow), m(pool.totalBorrowUsd, "usd"), `All ${pool.symbol} borrowed from this Kamino reserve, by everyone.`)}
      </div>
    </>
  );
}

function Transactions({ pool, position, farm }: { pool: FarmPoolConfig; position: FarmPositionRow | null; farm: ReturnType<typeof useFarmAccount> }) {
  const [tab, setTab] = useState<TxTab>("current");
  const [types, setTypes] = useState<string[]>([]);
  const [hide, setHide] = useState<Record<TxTab, string[]>>({ current: [], history: [] });
  const [custOpen, setCustOpen] = useState(false);
  const [cq, setCq] = useState("");
  const custRef = useOutside(custOpen, () => setCustOpen(false));

  const history = farm.history
    .filter((r) => (r.type === "farm-deposit" || r.type === "farm-withdraw") && r.symbol === pool.symbol)
    .map((r) => ({ ...r, label: r.type === "farm-deposit" ? "Supply" : "Withdraw" }))
    .filter((r) => !types.length || types.includes(r.label));

  const cells = {
    current: position
      ? [
          [
            <Cell
              key="a"
              v={
                <span className="fm-tk">
                  <Icon sym={pool.symbol} className="fm-ico16" />
                  {pool.symbol}
                </span>
              }
              mini="Vault"
            />,
            <Cell key="p" v={<Venue name="Kamino" />} />,
            <Cell key="s" v={tokFmt(position.underlying, pool.symbol)} mini={usd(position.liquidityUsd)} />,
            <Cell key="r" v={`${nf(position.receipts, 6)} ${pool.receiptSymbol}`} />,
            <Cell key="y" v={m(pool.supplyApy, "pct")} />,
          ],
        ]
      : [],
    history: history.map((r) => [
      <Cell key="d" v={new Date(r.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} mini={new Date(r.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })} />,
      <Cell key="t" v={r.label} />,
      <Cell key="m" v={tokFmt(Number(r.amount), pool.symbol)} />,
      <Cell key="s" v={<span className="fm-ok">Success</span>} />,
      <Cell
        key="h"
        v={
          <a className="fm-link" href={explorerUrl("tx", r.signature)} target="_blank" rel="noreferrer">
            {r.signature.slice(0, 8)}…{r.signature.slice(-4)}
          </a>
        }
      />,
    ]),
  };

  const show = COLS[tab].map((c, i) => [c, i] as const).filter(([c]) => !hide[tab].includes(c[0]));
  const grid = { gridTemplateColumns: show.map(([c]) => c[1]).join(" "), minWidth: Math.max(240, show.length * 110) };
  const rows = cells[tab];
  const empty = tab === "current" ? "No position in this vault yet" : types.length ? `No ${types.join(" or ").toLowerCase()} in this vault yet` : "No activity in this vault yet";
  const custCols = COLS[tab].filter(([l]) => !cq.trim() || l.toLowerCase().includes(cq.trim().toLowerCase()));

  return (
    <>
      <dl className="fm-position-summary num">
        <div><dt>Position value</dt><dd>{usd(position ? position.liquidityUsd : 0)}</dd></div>
        <div><dt>Receipt balance</dt><dd>{`${nf(position ? position.receipts : 0, 6)} ${pool.receiptSymbol}`}</dd></div>
        <div><dt>Earned yield</dt><dd>{usd(position?.earnedUsd ?? 0)}</dd>
          {position?.since && <small>Since {new Date(position.since).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small>}
        </div>
      </dl>
      <div className="fm-ath">
        <h2>{tab === "current" ? "Your Position" : "Position History"}</h2>
        <div className="fm-athr">
          <span className="fm-vl">{types.length ? types.join(", ") : "All"}:</span>
          <CheckDropdown
            right
            withIcons={false}
            options={["Supply", "Withdraw"]}
            selected={types}
            onChange={(next) => {
              setTypes(next);
              if (next.length) setTab("history");
            }}
            placeholder="Search types"
            trigger={(open, toggle) => (
              <button type="button" className={`fm-all ${types.length ? "set" : ""}`} aria-haspopup="listbox" aria-expanded={open} aria-label="Filter transactions by type" onClick={toggle}>
                <svg width="17" height="12" viewBox="0 0 17 12" aria-hidden="true">
                  <path d="M1 1h15M4 6h9M7 11h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            )}
          />
          <span className="fm-ddw" ref={custRef}>
            <button type="button" className="fm-cust" aria-haspopup="menu" aria-expanded={custOpen} onClick={() => setCustOpen((o) => !o)}>
              {EYE}Customize {IC.chev}
            </button>
            {custOpen && (
              <div className="pop r fm-cpop" role="menu">
                <label className="fm-psearch">
                  {IC.search}
                  <input placeholder="Search for customize" value={cq} onChange={(e) => setCq(e.target.value)} aria-label="Search columns" autoComplete="off" />
                </label>
                <div className="fm-cl">
                  {custCols.length ? (
                    custCols.map(([l]) => {
                      const on = !hide[tab].includes(l);
                      return (
                        <button
                          key={l}
                          type="button"
                          className={`fm-co eye ${on ? "on" : ""}`}
                          role="menuitemcheckbox"
                          aria-checked={on}
                          onClick={() => setHide((h) => ({ ...h, [tab]: on ? h[tab].concat(l) : h[tab].filter((z) => z !== l) }))}
                        >
                          {on ? EYE : EYE_OFF}
                          {l}
                        </button>
                      );
                    })
                  ) : (
                    <p className="fm-cnone">No match</p>
                  )}
                </div>
              </div>
            )}
          </span>
        </div>
      </div>
      <Seg<TxTab>
        className="fm-seg-l"
        value={tab}
        options={[
          ["current", "Current Position"],
          ["history", "Position History"],
        ]}
        onChange={setTab}
      />
      <section className="fm-itbl">
        {!show.length ? (
          <p className="fm-it-e">All columns are hidden. Turn one on in Customize.</p>
        ) : rows.length ? (
          <>
            <div className="fm-it-h" style={grid}>
              {show.map(([c]) => (
                <span key={c[0]}>{c[0]}</span>
              ))}
            </div>
            {rows.map((r, k) => (
              <div key={k} className="fm-it-r num" style={grid}>
                {show.map(([, i]) => r[i])}
              </div>
            ))}
          </>
        ) : (
          <p className="fm-it-e">{empty}</p>
        )}
      </section>
    </>
  );
}

const EYE = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <circle cx="8" cy="8" r="2" fill="currentColor" />
  </svg>
);
const EYE_OFF = (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5z" stroke="currentColor" strokeWidth="1.4" fill="none" opacity=".45" />
    <path d="M2.5 13.5l11-11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
