"use client";

/**
 * The pool page's tabs (V3 design `#earn-<SYM>`): Positions, Details, Activity, Collateral and
 * Limits, Analytics. Every figure is on-chain: the decoded Reserve + AssetConfig
 * (usePoolDetails), the pool summary (usePoolData), the wallet's lender position and decoded
 * supply / withdraw events, oracle prices.
 */
import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { PublicKey } from "@solana/web3.js";
import { Info, Modal } from "@/components/v3/ui";
import { usd } from "@/components/v3/format";
import { usePoolDetails } from "@/hooks/use-earn";
import { explorerUrl, LIQUIDATION_HEALTH_FACTOR, VANNA_PROGRAM_ID } from "@/lib/solana/config";
import { oracleSourceLabel } from "@/lib/solana/oracle";
import { findToken, TOKENS } from "@/lib/solana/tokens";
import { annualBorrowRate, annualSupplyRate, fromRaw, WAD, wadToNumber } from "@/lib/solana/math";
import type { EarnHistoryRow } from "@/lib/solana/history";
import { ChartCard, EarnChart } from "./earn-chart";
import { Customize, LiveTable, Pager, type Cell, type Col, type Row } from "./earn-table";
import { NoData, Pie, SV, usePop } from "./earn-ui";
import { fL, fLoc, fP, fT, fU, fXr, shortAddr, usdOr } from "./earn-format";
import { seriesFor, useEarnV3 } from "./use-earn-v3";
import type { Tf } from "./earn-series";
import { VannaLoader } from "@/components/v3/vanna-loader";

type D = ReturnType<typeof useEarnV3>;

/** Small stat block (`.earn-sc`). */
function StatCard({ h, main, sub, tip }: { h: string; main: string; sub?: string; tip?: string }) {
  return (
    <div className="earn-sc">
      <div className="earn-sch">
        {h}
        {tip && <Info text={tip} />}
      </div>
      <div className="earn-scv num">{main}</div>
      {sub && <div className="earn-scs num">{sub}</div>}
    </div>
  );
}

/** Ring + figures card (`.earn-pc`). */
function PieCard({ pct, h, main, sub, tip }: { pct: number; h: string; main: string; sub: string; tip?: string }) {
  return (
    <div className="earn-pc">
      <div className="earn-pcp">
        <Pie pct={pct} size={79} stroke={7} />
        <span className="num">{fP(pct)}</span>
      </div>
      <div className="earn-pct">
        <div className="earn-sch">
          {h}
          {tip && <Info text={tip} />}
        </div>
        <div className="earn-pcv num">{main}</div>
        <div className="earn-scs num">{sub}</div>
      </div>
    </div>
  );
}

/** WAD coefficient → plain decimal ("0.05"). */
const wadStr = (v: bigint): string => {
  const n = wadToNumber(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 6 }) : (v / WAD).toString();
};

/** Supply / withdraw history cells (design `histCells`). */
function histCells(h: EarnHistoryRow, price: number): Cell[] {
  const d = new Date(h.timestamp);
  const amt = parseFloat(h.amount) || 0;
  return [
    { t: d.toLocaleDateString("en-US"), d: d.toLocaleTimeString("en-US"), v: h.timestamp },
    { node: <span className={`earn-badge ${h.type === "supply" ? "g" : "o"}`}>{h.type === "supply" ? "Supply" : "Withdraw"}</span>, t: h.type, text: h.type },
    { ic: h.symbol, t: `${fLoc(amt, 6)} ${h.symbol}`, text: h.amount, v: amt, d: price > 0 ? usd(amt * price) : "" },
    { node: <span className="earn-badge g">Success</span>, t: "Success" },
    {
      node: (
        <a className="earn-hash" href={explorerUrl("tx", h.signature)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
          {h.signature.slice(0, 8)}…{h.signature.slice(-4)}
        </a>
      ),
      t: h.signature,
    },
  ];
}
const HIST_COLS: Col[] = [
  { id: "date", label: "Date" },
  { id: "type", label: "Type" },
  { id: "amt", label: "Amount" },
  { id: "st", label: "Status" },
  { id: "tx", label: "Tx Hash" },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Details
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Statistics, supplied / borrowed rings, every pool parameter and the on-chain addresses. */
export function TabDetails({ sym, d }: { sym: string; d: D }) {
  const { details, isLoading } = usePoolDetails();
  const token = findToken(sym) ?? TOKENS[0];
  const p = details[sym];
  const a = p?.asset ?? null;
  const r = p?.reserve ?? null;
  const px = d.prices[sym] ?? 0;
  const u = (n: number) => (px > 0 ? `$${fL(n * px)}` : `$${fL(0)}`);

  if (isLoading || !p?.reserve) {
    return (
      <section className="earn-det" aria-label="Vault Details">
        <div className="earn-detin">
          <h2>Statistics</h2>
          <NoData text={isLoading ? <VannaLoader size="block" caption="Loading vault statistics" /> : `The ${sym} pool is not initialised on this network.`} />
          <div style={{ height: 20 }} />
        </div>
      </section>
    );
  }
  const util = Math.max(0, Math.min(100, p.utilization * 100));
  const supPct = p.totalSupplied > 0 ? 100 - util : 0;
  const curve = p.reserve.rateCurve;
  const grid: [string, string, string | undefined, string][] = [
    ["Available Liquidity", `${fL(p.availableLiquidity)} ${sym}`, u(p.availableLiquidity), `${sym} in the vault that is not lent out, so borrowers can take it and suppliers can withdraw it.`],
    ["Supply APY", fP(p.supplyApr * 100), `${fL(p.totalSupplied)} ${sym}`, "Yearly interest suppliers earn now: borrow rate × utilization × (1 − reserve factor), from the on-chain rate curve."],
    ["Borrow APY", fP(p.borrowApr * 100), undefined, "Yearly interest borrowers pay now; it moves with utilization."],
    ["Utilization Rate", fP(p.utilization * 100), undefined, "Share of the supplied assets that is currently borrowed."],
    ["Liquidation Bonus", a ? fP(a.liquidationBonusBps / 100) : fP(0), `Liquidatable at HF ${LIQUIDATION_HEALTH_FACTOR.toFixed(2)} or below`, `Extra paid to a liquidator who takes this asset from a margin account at health factor ${LIQUIDATION_HEALTH_FACTOR.toFixed(2)} or below.`],
    ["Oracle Price", px > 0 ? `$${px.toFixed(px < 1 ? 4 : 2)}` : usd(0), a ? `${oracleSourceLabel(a.oracle)} · max age ${a.maxPriceAgeSecs}s` : undefined, "Price the program uses to value this asset."],
    ["Share Token Exchange Rate", fXr(p.exchangeRate), `${sym} per v${sym}`, `How much ${sym} one v${sym} share is worth; it rises as interest accrues.`],
    ["Reserve Factor", fP(p.reserveFactor * 100), undefined, "Part of the interest borrowers pay that the protocol keeps instead of passing to suppliers."],
    ["Supply Cap", p.supplyCapUi === null ? "Uncapped" : `${fL(p.supplyCapUi)} ${sym}`, p.supplyCapUi === null ? undefined : `${Math.min(100, (p.totalSupplied / p.supplyCapUi) * 100).toFixed(2)}% used`, "Most this vault accepts in total; Uncapped means no limit."],
    ["Borrow Cap", p.borrowCapUi === null ? "Uncapped" : `${fL(p.borrowCapUi)} ${sym}`, p.borrowCapUi === null ? undefined : `${Math.min(100, (p.totalBorrowed / p.borrowCapUi) * 100).toFixed(2)}% used`, "Most that can be borrowed from this vault in total; Uncapped means no limit."],
    ["Status", p.statusLabel, undefined, "Active: all actions · Supply only: no new borrows · Repay only: no supply / borrow · Frozen: repay only."],
    ["Rate Curve", `×${wadStr(curve.rateMultiplierWad)}`, `linear ${wadStr(curve.linearCoeffWad)} · jump ${wadStr(curve.jumpCoeffWad)}`, "Annual borrow rate = multiplier × (linear × (u + u³²) + jump × u⁶⁴): slow at first, then steep at high utilization."],
  ];
  const addr: [string, string | null][] = [
    [`v${sym} Share Mint`, r?.shareMint.toBase58() ?? null],
    [`${sym} Reserve`, r?.address.toBase58() ?? null],
    ["Liquidity Vault", r?.liquidityVault.toBase58() ?? null],
    ["Asset Config", a?.address.toBase58() ?? null],
    ["Scope Prices", a && !a.oracle.scopePrices.equals(PublicKey.default) ? a.oracle.scopePrices.toBase58() : null],
    ["Pyth Fallback Feed", a && !a.oracle.pythPrice.equals(PublicKey.default) ? a.oracle.pythPrice.toBase58() : null],
    [`${sym} Mint`, token.mint.toBase58()],
    ["Vanna Lending Program", VANNA_PROGRAM_ID.toBase58()],
  ];
  const copy = (s: string) => {
    navigator.clipboard?.writeText(s).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Clipboard blocked"),
    );
  };
  return (
    <section className="earn-det" aria-label="Vault Details">
      <div className="earn-detin">
        <h2>Statistics</h2>
        <article className="earn-pies" aria-label="Supply and Borrow Overview">
          <PieCard pct={supPct} h="Total Supplied" main={`${fL(p.totalSupplied)} ${sym}`} sub={u(p.totalSupplied)} tip={`All ${sym} supplied to this vault; the ring shows the part not borrowed.`} />
          <PieCard pct={util} h="Total Borrowed" main={`${fL(p.totalBorrowed)} ${sym}`} sub={u(p.totalBorrowed)} tip={`${sym} borrowed from this vault by margin accounts; the ring shows utilization.`} />
        </article>
        <article className="earn-sgrid" aria-label="Vault Statistics">
          {grid.map(([h, m, s, tp]) => (
            <StatCard key={h} h={h} main={m} sub={s} tip={tp} />
          ))}
        </article>
        <article className="earn-addrs" aria-label="On-chain Addresses">
          <h3>Addresses</h3>
          <div className="earn-agrid">
            {addr.map(([h, v]) => (
              <div key={h} className="earn-ad">
                <div className="earn-sch">{h}</div>
                <div className="earn-adr">
                  <span>{v ? shortAddr(v) : "N/A"}</span>
                  {v && (
                    <>
                      <button type="button" className="earn-adb" aria-label="Copy address" onClick={() => copy(v)}>
                        {SV.copy}
                      </button>
                      <a className="earn-adb" href={explorerUrl("address", v)} target="_blank" rel="noopener noreferrer" aria-label="Open in explorer">
                        {SV.link}
                      </a>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Positions
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** My Supply chart, then the current position / position history (or the no-position card). */
export function TabPositions({ sym, d }: { sym: string; d: D }) {
  const [tf, setTf] = useState<Tf>("All Time");
  const [mp, setMp] = useState<"current" | "history">("current");
  const [hideCur, setHideCur] = useState<string[]>([]);
  const [hideHist, setHideHist] = useState<string[]>([]);
  const pop = usePop();
  const connected = Boolean(d.address);
  const pool = d.pools[sym];
  const px = d.prices[sym] ?? 0;
  const v = d.supplied[sym] ?? 0;
  const has = connected && v > 0;
  const apy = (pool?.supplyApr ?? 0) * 100;
  const hs = useMemo(() => d.transactions.filter((h) => h.symbol === sym).sort((a, b) => b.timestamp - a.timestamp), [d.transactions, sym]);
  const myValue = connected ? v * px : 0;

  const my = useMemo(() => (connected ? seriesFor("dep", tf, [sym], d.seriesInput, d.now, myValue) : { pts: [], excluded: [] }), [connected, tf, sym, d.seriesInput, d.now, myValue]);
  const noHistory = !hs.length && !has;
  const note = has && my.excluded.includes(sym) ? (px > 0 ? "Past values can't be rebuilt from your on-chain history, so only today's value is drawn." : `No oracle price for ${sym} right now.`) : null;

  const earnedE = d.earned?.[sym];
  const earnedTok = earnedE ? earnedE.earned : null;
  const curCols: Col[] = [
    { id: "pool", label: "Pool" },
    { id: "sh", label: "Vault Shares" },
    { id: "sup", label: `${sym} Supplied` },
    { id: "usd", label: "USD Value" },
    { id: "apy", label: "APY" },
    { id: "earn", label: "Interest Earned" },
  ];
  const curRows: Row[] = has
    ? [
        {
          key: "d",
          cells: [
            { ic: sym, t: sym, tags: ["Vanna", "Vault"] },
            { t: `${fT(d.positions[sym]?.shares ?? 0)} v${sym}` },
            { t: `${fT(v)} ${sym}` },
            { t: fU(px > 0 ? v * px : 0) },
            { t: fP(apy) },
            earnedTok === null
              ? { t: `${fT(0)} ${sym}`, d: earnedE?.reason ?? <VannaLoader size="inline" caption="Reading history" /> }
              : { t: `${fT(Math.max(0, earnedTok))} ${sym}`, d: px > 0 ? usd(Math.max(0, earnedTok) * px) : "" },
          ],
        },
      ]
    : [];
  const histRows: Row[] = hs.map((h) => ({ key: h.signature + h.type, cells: histCells(h, px) }));
  const cur = mp === "current";

  return (
    <section className="earn-ypos" aria-label="Your Positions Overview">
      <figure className="earn-myc">
        <ChartCard
          className="my"
          label="My Supply"
          value={usd(myValue)}
          tf={tf}
          onTf={setTf}
          pts={noHistory ? [] : my.pts}
          kind="my"
          h={320}
          mobile={false}
          empty={connected ? "No supply position yet" : "Connect your wallet to see your supply"}
          note={note}
        />
      </figure>
      <article className="earn-ypa" aria-label="My Position">
        {!connected || noHistory ? (
          <div className="earn-nopos">
            <span className="earn-noic">{SV.layers}</span>
            <div>
              <p className="t">No active position</p>
              <p className="s">Supply liquidity to start earning {sym} interest</p>
            </div>
            <div className="earn-noapy">
              <div>
                <span>Current Supply APY</span>
                <b className="num">{fP(apy)}</b>
              </div>
              <span className="earn-acc">{SV.clock}Accrues every second</span>
            </div>
          </div>
        ) : (
          <>
            <div className="earn-mph">
              <h2>My Position</h2>
              <Customize
                popId="cust"
                cols={cur ? curCols : HIST_COLS}
                hidden={cur ? hideCur : hideHist}
                onChange={cur ? setHideCur : setHideHist}
                open={pop.open === "cust"}
                onToggle={() => pop.toggle("cust")}
              />
            </div>
            <nav className="earn-seg sm" aria-label="Position tabs">
              <button type="button" className={cur ? "on" : ""} onClick={() => setMp("current")}>
                Current Position
              </button>
              <button type="button" className={cur ? "" : "on"} onClick={() => setMp("history")}>
                Position History
              </button>
            </nav>
            {cur ? (
              curRows.length ? <LiveTable cols={curCols} rows={curRows} hidden={hideCur} /> : <NoData text="No active position" />
            ) : histRows.length ? (
              <LiveTable cols={HIST_COLS} rows={histRows} hidden={hideHist} />
            ) : (
              <NoData text="No transactions yet" />
            )}
          </>
        )}
      </article>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Activity
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Pool composition (idle vs borrowed, from the projected Reserve) and the wallet's decoded
 * supply / withdraw events for this pool. (A per-holder distribution needs a token-holder index
 * this RPC does not serve, so it is not shown.)
 */
export function TabActivity({ sym, d }: { sym: string; d: D }) {
  const p = d.pools[sym];
  const px = d.prices[sym] ?? 0;
  const connected = Boolean(d.address);
  const avail = p?.availableLiquidity ?? 0;
  const bor = p?.totalBorrowed ?? 0;
  const total = p?.totalSupplied ?? 0;
  const sh = total > 0 ? Math.min(100, (avail / total) * 100) : 0;
  const comp: Row[] = p?.initialised
    ? [
        { key: "a", cells: [{ ic: sym, t: "Available liquidity" }, { ic: sym, t: `${fLoc(avail, 4)} ${sym}`, d: usdOr(avail, px) }, { pie: sh, t: fP(sh) }] },
        { key: "b", cells: [{ ic: sym, t: "Borrowed by margin accounts" }, { ic: sym, t: `${fLoc(bor, 4)} ${sym}`, d: usdOr(bor, px) }, { pie: 100 - sh, t: fP(total > 0 ? 100 - sh : 0) }] },
      ]
    : [];
  const hs = connected ? d.transactions.filter((h) => h.symbol === sym).sort((a, b) => b.timestamp - a.timestamp) : [];
  const txRows: Row[] = hs.length
    ? hs.map((h) => ({ key: h.signature + h.type, cells: histCells(h, px) }))
    : [{ key: "none", cells: [{ t: "None", d: d.historyLoading ? <VannaLoader size="inline" label="Loading transactions" /> : "No transactions yet" }, { t: "N/A" }, { t: `0 ${sym}` }, { t: "N/A" }, { t: "None" }] }];
  return (
    <section className="earn-act" aria-label="Activity Overview">
      <h2>Pool Composition</h2>
      {comp.length ? (
        <LiveTable
          cols={[
            { id: "b", label: "Bucket" },
            { id: "a", label: "Assets" },
            { id: "s", label: "Share of Supply (%)" },
          ]}
          rows={comp}
        />
      ) : (
        <NoData text={p ? "This pool has no supply yet" : <VannaLoader />} />
      )}
      <div className="earn-acth">
        <h3>Your Recent Transactions</h3>
        <span className="num">
          {hs.length} transaction{hs.length === 1 ? "" : "s"}
        </span>
      </div>
      <LiveTable cols={HIST_COLS} rows={txRows} />
      {!connected ? (
        <div className="earn-actnote">Connect your wallet to see your supply / withdraw activity.</div>
      ) : (
        <div className="earn-actnote">
          <a className="earn-hash" href={explorerUrl("address", d.address!)} target="_blank" rel="noopener noreferrer">
            View all your transactions on Solana Explorer
          </a>
          {d.history && !d.history.complete && <div>Showing activity from your latest {d.history.scanned} transactions.</div>}
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Collateral and Limits
// ─────────────────────────────────────────────────────────────────────────────────────────────

const PAGE = 5;

/** Account-wide liquidation rule, per-asset collateral parameters and cap usage (every registry asset). */
export function TabCollateral() {
  const { details, isLoading } = usePoolDetails();
  const [pg, setPg] = useState({ coll: 0, sup: 0, bor: 0 });
  const pages = Math.max(1, Math.ceil(TOKENS.length / PAGE));
  const slice = (k: keyof typeof pg) => TOKENS.slice(pg[k] * PAGE, pg[k] * PAGE + PAGE);
  if (isLoading) return <NoData text={<VannaLoader size="block" caption="Loading collateral and limits" />} />;

  const cp: Row[] = slice("coll").map((t) => {
    const a = details[t.symbol]?.asset;
    return {
      key: t.symbol,
      cells: [
        { ic: t.symbol, t: t.symbol },
        { t: a ? (a.collateralEnabled ? "Enabled" : "Disabled") : "N/A" },
        { t: a ? (a.borrowEnabled ? "Enabled" : "Disabled") : "N/A" },
        { t: !a ? "N/A" : a.maxCollateralPerMargin === 0n || a.maxCollateralPerMargin === 0xffff_ffff_ffff_ffffn ? "Uncapped" : `${fT(Number(fromRaw(a.maxCollateralPerMargin, t.decimals)))} ${t.symbol}` },
        { t: a ? fP(a.liquidationBonusBps / 100) : fP(0) },
      ],
    };
  });
  const capRows = (k: "sup" | "bor"): Row[] =>
    slice(k).map((t) => {
      const p = details[t.symbol];
      const used = (k === "sup" ? p?.totalSupplied : p?.totalBorrowed) ?? 0;
      const cap = (k === "sup" ? p?.supplyCapUi : p?.borrowCapUi) ?? null;
      return {
        key: t.symbol,
        cells: [
          { ic: t.symbol, t: t.symbol, d: p?.reserve ? `v${t.symbol} Pool` : "Not initialised" },
          cap === null
            ? { t: "", bar: { pct: 0, v: `${fT(used)} ${t.symbol} · Uncapped` } }
            : { t: "", bar: { pct: cap > 0 ? Math.min(100, (used / cap) * 100) : 0, v: `${fT(used)} of ${fT(cap)} ${t.symbol}` } },
        ],
      };
    });
  const capCols = (label: string): Col[] => [
    { id: "a", label: "Assets" },
    { id: "u", label },
  ];
  const setPage = (k: keyof typeof pg) => (n: number) => setPg((s) => ({ ...s, [k]: n }));
  return (
    <section className="earn-coll" aria-label="Collateral Limits Overview">
      <article className="earn-hfc" aria-label="Account-wide Liquidation Rule">
        <span className="t">Account-wide health factor</span>
        <span className="s">
          A margin account&apos;s health factor is the sum of collateral value ÷ the sum of debt value across all assets. It becomes liquidatable at HF{" "}
          {LIQUIDATION_HEALTH_FACTOR.toFixed(2)} or below; borrowed tokens stay in the margin account and count as collateral. Liquidators receive the seized asset&apos;s
          liquidation bonus.
        </span>
      </article>
      <article aria-label="Collateral Parameters">
        <h2>Collateral Parameters</h2>
        <LiveTable
          cols={[
            { id: "a", label: "Asset" },
            { id: "c", label: "Collateral" },
            { id: "b", label: "Borrowing" },
            { id: "m", label: "Max per Margin Account" },
            { id: "l", label: "Liquidation Bonus" },
          ]}
          rows={cp}
        />
        {pages > 1 && <Pager page={pg.coll} pages={pages} onPage={setPage("coll")} />}
      </article>
      <article aria-label="Supply Cap Usage">
        <LiveTable cols={capCols("Supply Cap Usage")} rows={capRows("sup")} cls="cap" />
        {pages > 1 && <Pager page={pg.sup} pages={pages} onPage={setPage("sup")} />}
      </article>
      <article aria-label="Borrow Cap Usage">
        <LiveTable cols={capCols("Borrow Cap Usage")} rows={capRows("bor")} cls="cap" />
        {pages > 1 && <Pager page={pg.bor} pages={pages} onPage={setPage("bor")} />}
      </article>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Analytics
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Deposit / Borrow APY now, and the pool's real rate curve (APY at every utilization, evaluated
 * with the program's own rate math on the on-chain coefficients). The design's APY-history chart is
 * not drawn: no indexer records past rates, and a made-up history would be fake data.
 */
export function TabAnalytics({ sym, d }: { sym: string; d: D }) {
  const { details } = usePoolDetails();
  const [kind, setKind] = useState<"Deposit APY" | "Borrow APY">("Deposit APY");
  const [expanded, setExpanded] = useState(false);
  const pop = usePop();
  const p = d.pools[sym];
  const det = details[sym];
  const cur = ((kind === "Borrow APY" ? p?.borrowApr : p?.supplyApr) ?? 0) * 100;
  const pts = useMemo(() => {
    const r = det?.reserve;
    if (!r) return [];
    return Array.from({ length: 101 }, (_, i) => {
      const w = (BigInt(i) * WAD) / 100n;
      return { t: i, v: (kind === "Borrow APY" ? annualBorrowRate(r.rateCurve, w) : annualSupplyRate(r.rateCurve, w, r.reserveFactorBps)) * 100 };
    });
  }, [det, kind]);
  const ts = new Date().toLocaleString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const util = (p?.utilization ?? 0) * 100;
  const tipSub = (q: { t: number }) => `at ${q.t}% utilization${Math.abs(q.t - util) < 0.5 ? " (now)" : ""}`;
  return (
    <section className="earn-an" aria-label="Analytics Dashboard">
      <div className="earn-cc an">
        <div className="earn-cch">
          <div className="earn-anl">
            <div className="earn-apsw" data-earn-pop="apysel">
              <button type="button" className="earn-aps" aria-expanded={pop.open === "apysel"} onClick={() => pop.toggle("apysel")}>
                {kind} {SV.chev14}
              </button>
              {pop.open === "apysel" && (
                <div className="pop earn-pop apysel">
                  {(["Deposit APY", "Borrow APY"] as const).map((x) => (
                    <button
                      key={x}
                      type="button"
                      className={x === kind ? "on" : ""}
                      onClick={() => {
                        setKind(x);
                        pop.close();
                      }}
                    >
                      {x}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="num v">{fP(cur)}</p>
            <time className="num">
              {ts} · utilization {fP(util)}
            </time>
          </div>
          <button type="button" className="earn-exp" aria-label="Expand chart" onClick={() => setExpanded(true)}>
            {SV.expand}
          </button>
        </div>
        <div className="earn-ccr">
          <span className="earn-note">
            Rate curve: {kind === "Borrow APY" ? "borrow" : "supply"} APY at each utilization (x-axis), from the pool&apos;s on-chain rate model
          </span>
        </div>
        <EarnChart pts={pts} kind="curve" h={393} tipSub={tipSub} empty="Pool not initialised" />
      </div>
      {expanded && (
        <AnalyticsModal kind={kind} cur={cur} pts={pts} tipSub={tipSub} onClose={() => setExpanded(false)} />
      )}
    </section>
  );
}

/** Expanded rate-curve chart. */
function AnalyticsModal({ kind, cur, pts, tipSub, onClose }: { kind: string; cur: number; pts: { t: number; v: number }[]; tipSub: (q: { t: number }) => string; onClose: () => void }) {
  return (
    <Modal wide className="earn-xmodal" onClose={onClose}>
      <div className="earn earn-xm">
        <div className="earn-xmh">
          <div>
            <h2>{kind}</h2>
            <p className="num">{fP(cur)}</p>
          </div>
        </div>
        <EarnChart pts={pts} kind="curve" h={450} tipSub={tipSub} />
      </div>
    </Modal>
  );
}
