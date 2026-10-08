"use client";

/**
 * Predict (BETA) — event page (design predict.js `viewEvent`): head card (tiles + chart), the
 * outcome rows, "Your position", the Vault / Order book / Rules / Activity tabs and the sticky
 * trade panel. Route id = `<eventId>[~<marketId>[~yes|no]]` (a market id opens that market
 * selected, the panel on Buy with the default amount). UI only: sample data, in-memory actions.
 */
import "./predict-v3.css";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { IC, Icon, VMark } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { nf, pct, sUsd, spct, usd, usdC } from "@/components/v3/format";
import {
  DEF_AMT, EVM, OUT, PX, RATE, ask, bid, byChance, cancelQueued, defaultOut, hash, heldOf, lab, lentOf, levels, nl, openOuts, pairsOf,
  pmx, posIn, posOf, predictToast, rng, sampleBuy, sampleSell, side, toggleTight, usePredictSample, yl,
  type Outcome, type PredictEvent, type Side,
} from "@/lib/predict-sample";
import { CATN, INFO, IcFor, VsBadge, Tile, Cell, Kv, PIC, PredictToast, cf, cpair, p2, parseAmt, pc, shf } from "./ui";
import { EventChart } from "./charts";
import { TradePanel, type PanelActions, type PanelState } from "./trade-panel";
import { ImportSheet } from "./import-sheet";

type Tab = "vault" | "book" | "rules" | "activity";

function Tiles({ e, o }: { e: PredictEvent; o: Outcome }) {
  const earnT = <Tile k={<>Passive yield <Info text={INFO.apy} /></>} v={`up to ${pct(RATE(), 1)}`} cls="e" />;
  const ops = openOuts(e);
  if (e.type === "binary") {
    const [py, pn] = cpair(o.y, o.n);
    return <><Tile k="Yes chance" v={pc(o.y)} cls="big" /><Tile k="Buy Yes" v={py} cls="y" /><Tile k="Buy No" v={pn} cls="n" />{earnT}</>;
  }
  if (e.type === "updown") {
    const now = PX[e.asset ?? "SOL"];
    const open = e.open ?? now;
    const ch = (now / open - 1) * 100;
    return (
      <>
        <Tile k="Up chance" v={pc(o.y)} cls="big" />
        <Tile k={`${e.asset} now`} v={`$${nf(now, 2)}`} cls={now >= open ? "y" : "n"} sub={`open $${nf(open, 2)} · ${spct(ch, 2)}`} />
        <Tile k="Closes in" v={e.countdown} sub={e.ends} />
        {earnT}
      </>
    );
  }
  if (e.type === "match") {
    const ps = e.outs.filter((x) => !x.grp);
    return <>{ps.map((x) => <Tile key={x.k} k={x.name} v={pc(x.y)} cls="big" />)}{ps.length < 3 && <Tile k="Volume" v={usdC(e.vol)} />}{earnT}</>;
  }
  if (e.type === "strike") return <><Tile k={`${e.asset} now`} v={`$${nf(PX[e.asset ?? "BTC"], 0)}`} cls="big" /><Tile k="Ends in" v={e.countdown} sub={e.ends} /><Tile k="Volume" v={usdC(e.vol)} />{earnT}</>;
  if (e.type === "date") {
    const nx = ops[0];
    return <><Tile k={`By ${nx.name}`} v={pc(nx.y)} cls="big" /><Tile k="Volume" v={usdC(e.vol)} /><Tile k="Last date" v={e.ends} />{earnT}</>;
  }
  const lead = ops.slice().sort(byChance)[0];
  return <><Tile k="Leader" v={lead.name} sub={`${pc(lead.y)} chance`} /><Tile k="Volume" v={usdC(e.vol)} /><Tile k="Ends" v={e.ends} />{earnT}</>;
}

function OutRow({ e, o, on, st, onRow, onPick }: { e: PredictEvent; o: Outcome; on: boolean; st: PanelState; onRow: () => void; onPick: (s: Side) => void }) {
  const held = posIn(e).filter((p) => p.o === o.k);
  const d = o.d || 0;
  return (
    <div className={`pd-row ${on ? "on" : ""} ${o.res ? "res" : ""}`} onClick={o.res ? undefined : onRow}>
      <div className="pd-r-n">
        {e.type === "match" && o.ab ? <IcFor e={e} o={o} cls="sm" /> : null}
        <div>
          <b>{o.name}</b>
          <small className="num">
            {o.res ? (
              `Resolved ${o.res === "yes" ? yl(o) : nl(o)} · Vol ${usdC(o.vol)}`
            ) : (
              <>
                Vol {usdC(o.vol)}
                {held.length > 0 && (
                  <>
                    {" · "}
                    <span className="pd-you">You: {held.map((p) => `${shf(p.sh + p.yld)} ${lab(o, p.side)}`).join(", ")}</span>
                  </>
                )}
              </>
            )}
          </small>
        </div>
      </div>
      <div className="pd-r-p num">
        <b>
          {o.yl && !o.res ? <i className="pd-r-l">{o.yl}</i> : null}
          {o.res ? (o.res === "yes" ? "100%" : "0%") : pc(o.y)}
        </b>
        {!o.res && d ? <small className={d > 0 ? "pos" : "neg"}>{d > 0 ? "↑" : "↓"}{Math.abs(d)}</small> : null}
      </div>
      <div className="pd-r-b num">
        {!o.res &&
          (["yes", "no"] as const).map((s, i) => (
            <button
              key={s}
              type="button"
              className={`${s === "yes" ? "pd-y" : "pd-n"} ${on && st.side === s && st.mode === "buy" ? "on" : ""}`}
              onClick={(ev) => {
                ev.stopPropagation();
                onPick(s);
              }}
            >
              {o.yl ? "" : "Buy "}
              {lab(o, s)} {cpair(o.y, o.n)[i]}
            </button>
          ))}
      </div>
    </div>
  );
}

function VaultTab({ e, o }: { e: PredictEvent; o: Outcome }) {
  const ops = openOuts(e);
  const lent = lentOf(e);
  const y = side(o, "yes");
  const n = side(o, "no");
  const mineV = posIn(e).map(pmx).reduce((t, m) => t + m.inVault, 0);
  const on = ops.length > 1 ? ` · ${o.name}` : "";
  const usdcI = <Icon sym="USDC" className="pd-i14" />;
  return (
    <>
      <div className="pd-tiles num">
        <Tile k={<>{usdcI}Lent from this event <Info text={INFO.lent} /></>} v={usd(lent, 0)} sub={`${nf(lent)} Yes+No pairs`} />
        <Tile k={<>{usdcI}USDC Earn pool <Info text={INFO.rate} /></>} v={`${p2(RATE())} APY`} cls="e" sub="smaller side: full rate" />
        <Tile k={<>{yl(o)} side{on} <Info text={INFO.sideApy} /></>} v={p2(y.apy)} cls={y.scarce ? "e" : ""} sub={`${pct(y.share * 100, 0)} matched`} />
        <Tile k={<>{nl(o)} side{on} <Info text={INFO.sideApy} /></>} v={p2(n.apy)} cls={n.scarce ? "e" : ""} sub={`${pct(n.share * 100, 0)} matched`} />
      </div>
      <div className="pd-flow">
        <span>Your Yes or No</span>
        {IC.arrow}
        <span>
          <VMark size={13} />
          Vault
        </span>
        {IC.arrow}
        <span>Yes+No pairs</span>
        {IC.arrow}
        <span>
          {usdcI}USDC
        </span>
        {IC.arrow}
        <span className="e">Earn pool {p2(RATE())}</span>
      </div>
      {ops.length > 1 ? (
        <div className="pd-vtbl">
          <div className="pd-vt-h">
            <span>Market</span>
            <span>Yes supplied</span>
            <span>No supplied</span>
            <span>Lent</span>
            <span>Yes APY</span>
            <span>No APY</span>
          </div>
          {ops.map((x) => {
            const a = side(x, "yes");
            const b = side(x, "no");
            return (
              <div key={x.k} className={`pd-vt-r num ${x.k === o.k ? "on" : ""}`}>
                <span>
                  {x.name}
                  {x.yl ? <small>Yes = {x.yl} · No = {x.nl}</small> : null}
                </span>
                <span>{nf(x.pool.yes)}</span>
                <span>{nf(x.pool.no)}</span>
                <span className="pd-lent">
                  {usdcI}
                  {usd(pairsOf(x), 0)}
                </span>
                <span className={a.scarce ? "pos" : ""}>{p2(a.apy)}</span>
                <span className={b.scarce ? "pos" : ""}>{p2(b.apy)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="pd-sides num">
          {([["yes", y], ["no", n]] as const).map(([s, d]) => (
            <div key={s} className="pd-sidec">
              <div className="h">
                <span className={`pd-sd ${s}`}>{lab(o, s).toUpperCase()}</span>
                <span className={d.scarce ? "pos" : "mut"}>{d.scarce ? "Smaller side · full rate" : `${pct(d.share * 100, 0)} matched`}</span>
              </div>
              <div className={`v ${d.scarce ? "e" : ""}`}>
                {p2(d.apy)}{" "}
                <span className="mut" style={{ fontSize: 12, fontWeight: 500 }}>
                  APY
                </span>
              </div>
              <span className="pd-meter">
                <i style={{ width: `${(d.share * 100).toFixed(0)}%` }} />
              </span>
              <div className="pd-kv" style={{ marginTop: 8, fontSize: 12 }}>
                <span>Supplied</span>
                <span>{nf(d.mine)} shares</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="pd-note">
        Vanna&apos;s keeper merges pairs into USDC and lends it in the Earn pool. Yield is paid as extra shares of each side, worth $0 if that side loses.
        {mineV ? (
          <>
            {" "}
            Your matched shares:{" "}
            <b className="num" style={{ color: "var(--pd-text)" }}>
              {usd(mineV)}
            </b>
            .
          </>
        ) : null}
      </p>
    </>
  );
}

function BookTab({ e, o, s }: { e: PredictEvent; o: Outcome; s: Side }) {
  const L = lab(o, s);
  const asks = levels(o, s, 1).slice(0, 5);
  const bids = levels(o, s, -1).slice(0, 5);
  const mx = Math.max(...asks.map((x) => x.q), ...bids.map((x) => x.q));
  // Cumulative USD down each side of the book.
  const cum = (ls: { p: number; q: number }[]) => ls.map((x, i) => ({ ...x, cum: ls.slice(0, i + 1).reduce((t, l) => t + (l.q * l.p) / 100, 0) }));
  const askRows = cum(asks);
  const bidRows = cum(bids);
  const row = (x: { p: number; q: number; cum: number }, cls: string) => (
    <div key={`${cls}${x.p}`} className={`pd-bk-r ${cls}`}>
      <i style={{ width: `${((x.q / mx) * 100).toFixed(0)}%` }} />
      <span>{cf(x.p)}</span>
      <span>{nf(x.q)}</span>
      <span>{usd(x.cum, 0)}</span>
    </div>
  );
  return (
    <div className="pd-bk num">
      <div className="pd-bk-h">
        <span>
          {L}
          {openOuts(e).length > 1 ? ` · ${o.name}` : ""}
        </span>
        <span>Shares</span>
        <span>Total</span>
      </div>
      {askRows.slice().reverse().map((x) => row(x, "a"))}
      <div className="pd-bk-m">
        <span>Spread {cf(ask(o, s) - bid(o, s))}</span>
        <span>Best ask {cf(ask(o, s))}</span>
      </div>
      {bidRows.map((x) => row(x, "b"))}
      <p className="pd-note">Sample order book (best prices across World&apos;s trading venues in the design); the panel&apos;s quotes fill against these levels. It follows the side picked in the panel.</p>
    </div>
  );
}

function RulesTab({ e }: { e: PredictEvent }) {
  return (
    <div className="pd-rules">
      <p>{e.rules}</p>
      <div className="pd-kvs num">
        <Kv k="Resolver" v={<><Icon sym="WORLD" className="pd-i16" />World operator (on-chain)</>} />
        <Kv k="Winning share pays" v={<><Icon sym="CASH" className="pd-i16" />$1 (1 CASH), yield shares too</>} />
        <Kv k="Losing share" v="Worth $0, yield shares too" />
        <Kv k="Source" v={e.source} />
        <Kv k="Market opened" v={e.opened} />
        <Kv k="Ends" v={e.ends} />
      </div>
    </div>
  );
}

function ActTab({ e }: { e: PredictEvent }) {
  const r = rng(hash(`${e.id}/act`));
  const ops = openOuts(e);
  const rows: React.ReactNode[] = [];
  [2, 7, 15, 33, 58, 96, 140, 210].forEach((m, i) => {
    const o = ops[Math.floor(r() * ops.length)];
    const s: Side = r() < 0.6 ? "yes" : "no";
    const t = m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
    if (i % 3 === 2) {
      const pr = Math.round(40 + r() * 400);
      rows.push(
        <div key={i} className="pd-act-r num">
          <span className="t">{t}</span>
          <span className="d">
            Vault merge<small>{nf(pr)} pairs of {o.name} into USDC</small>
          </span>
          <span className="a pos">+{usd(pr, 0)} lent</span>
        </div>,
      );
      return;
    }
    const buy = r() < 0.7;
    const n = Math.round(20 + r() * 480);
    const px = buy ? ask(o, s) : bid(o, s);
    rows.push(
      <div key={i} className="pd-act-r num">
        <span className="t">{t}</span>
        <span className="d">
          {buy ? "Buy" : "Sell"}{" "}
          <span className={`pd-sd ${s}`} style={{ height: 18, fontSize: 10 }}>
            {lab(o, s).toUpperCase()}
          </span>
          {ops.length > 1 ? <small>{o.name}</small> : null}
        </span>
        <span className="a">
          {nf(n)} at {cf(px)}
        </span>
      </div>,
    );
  });
  return <div>{rows}</div>;
}

/** The event page; `id` is the route segment (`event[~market[~side]]`). */
export function PredictEventPage({ id }: { id: string }) {
  usePredictSample();
  const [evId, mk, sd] = decodeURIComponent(id).split("~");
  const e = EVM(evId);
  // Arriving on an event page: Buy, default amount, the market and side from the link.
  const [sel, setSel] = useState<string | undefined>(() => {
    const o = e && mk ? OUT(e, mk) : undefined;
    return o && !o.res ? o.k : undefined;
  });
  const [st, setSt] = useState<PanelState>(() => {
    const o = e && mk ? OUT(e, mk) : undefined;
    const held = e && o ? (["yes", "no"] as const).find((s) => posOf(e, o, s)) : undefined;
    return { side: sd === "yes" || sd === "no" ? sd : (held ?? "yes"), mode: "buy", amt: DEF_AMT, pay: "USDC" };
  });
  const [tab, setTab] = useState<Tab>("vault");
  const [range, setRange] = useState<"1W" | "1M" | "ALL">("1M");
  const [showRes, setShowRes] = useState(false);
  const [osel, setOsel] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const scrollPanel = useCallback(() => {
    if (window.innerWidth < 1024) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, []);

  if (!e)
    return (
      <div className="v3 page">
        <Link href="/predict" className="pd-back">
          {PIC.back}All markets
        </Link>
        <div className="pd-empty" style={{ marginTop: 16 }}>
          This market doesn&apos;t exist in the preview.
        </div>
      </div>
    );

  const k = sel && OUT(e, sel) && !OUT(e, sel)?.res ? sel : defaultOut(e);
  const o = OUT(e, k) as Outcome;
  /** Sell mode prefills the holding of that market / side. */
  const sellAmt = (oo: Outcome, s: Side) => {
    const h = heldOf(e, oo, s);
    return h ? String(Math.floor(h * 100) / 100) : "";
  };
  const setMode = (m: "buy" | "sell", oo: Outcome = o, s: Side = st.side) =>
    setSt((p) => ({ ...p, mode: m, side: s, amt: m === "buy" ? (parseAmt(p.amt) && p.mode === "buy" ? p.amt : DEF_AMT) : sellAmt(oo, s) }));

  const act: PanelActions = {
    setSide: (s) => setSt((p) => ({ ...p, side: s, amt: p.mode === "sell" ? sellAmt(o, s) : p.amt })),
    setMode: (m) => {
      if (m !== st.mode) setMode(m);
    },
    setAmt: (a) => setSt((p) => ({ ...p, amt: a })),
    setPay: (pay) => {
      setSt((p) => ({ ...p, pay }));
      setPayOpen(false);
    },
    choose: (kk) => {
      setSel(kk);
      setOsel(false);
      if (st.mode === "sell") setSt((p) => ({ ...p, amt: sellAmt(OUT(e, kk) as Outcome, p.side) }));
    },
    twin: (kk, s) => {
      setSel(kk);
      setSt((p) => ({ ...p, side: s }));
    },
    exec: () => {
      const a = parseAmt(st.amt);
      if (st.mode === "buy") {
        const t = sampleBuy(e, o, st.side, a, st.pay);
        if (t) {
          predictToast(t);
          setSt((p) => ({ ...p, amt: DEF_AMT }));
        }
      } else {
        const t = sampleSell(e, o, st.side, a);
        if (t) {
          predictToast(t);
          setSt((p) => ({ ...p, amt: "" }));
        }
      }
    },
    tight: () => {
      const t = toggleTight();
      if (t) predictToast(t);
    },
    cancelQ: (pid) => {
      const t = cancelQueued(pid);
      if (t) {
        predictToast(t);
        setSt((p) => ({ ...p, amt: sellAmt(o, p.side) }));
      }
    },
  };

  const main = e.outs.filter((x) => !x.grp && !x.res);
  const lines = e.outs.filter((x) => x.grp === "lines");
  const res = e.outs.filter((x) => x.res);
  const rows = e.type === "multi" ? main.slice().sort(byChance) : main;
  const outsTitle = ({ match: "Moneyline", multi: "Outcomes", date: "Dates", strike: "Price targets" } as Record<string, string>)[e.type] || "Markets";
  const note = e.note || (e.type === "multi" ? "exactly one resolves YES" : "");
  const when = e.live ? `${e.score} · ${e.when}` : e.when ? e.when : `Ends ${e.ends}`;
  const rowEl = (x: Outcome) => (
    <OutRow
      key={x.k}
      e={e}
      o={x}
      on={x.k === k}
      st={st}
      onRow={() => {
        setSel(x.k);
        if (st.mode === "sell") setSt((p) => ({ ...p, amt: sellAmt(x, p.side) }));
      }}
      onPick={(s) => {
        setSel(x.k);
        setSt((p) => ({ ...p, side: s, mode: "buy", amt: parseAmt(p.amt) && p.mode === "buy" ? p.amt : DEF_AMT }));
        scrollPanel();
      }}
    />
  );
  const mine = posIn(e);

  return (
    <div className="v3 page">
      <Link href="/predict" className="pd-back">
        {PIC.back}All markets
      </Link>
      <div className="pd-cols">
        <div className="pd-main">
          <section className="pd-box pd-head">
            <div className="pd-h-top">
              {e.type === "match" ? <VsBadge e={e} cls="lg" /> : <IcFor e={e} cls="lg" />}
              <div className="pd-h-q">
                <div className="pd-h-tags">
                  <span className="pd-ltag">{e.tag}</span>
                  <span className="pd-hcat">{CATN[e.cat]}</span>
                  {e.live && <span className="pd-live">LIVE</span>}
                  <span className="pd-hcat num">{when}</span>
                  <span className="pd-hcat num">Vol {usdC(e.vol)}</span>
                  <span className="pd-beta-sm">Sample</span>
                </div>
                <h1 className="pd-h1">{e.title}</h1>
              </div>
            </div>
            <div className="pd-tiles num">
              <Tiles e={e} o={o} />
            </div>
            {e.type === "binary" && (
              <div className="pd-pbar">
                <i style={{ width: `${o.y}%` }} />
              </div>
            )}
            <EventChart e={e} range={range} onRange={setRange} />
          </section>

          {e.outs.length > 1 && (
            <section className="pd-box pd-outs">
              <div className="pd-oh">
                <h2>{outsTitle}</h2>
                <span>{note}</span>
              </div>
              <div className="pd-rows">{rows.map(rowEl)}</div>
              {lines.length > 0 && (
                <>
                  <div className="pd-oh sub">
                    <h2>Game lines</h2>
                    <span>spread and total runs</span>
                  </div>
                  <div className="pd-rows">{lines.map(rowEl)}</div>
                </>
              )}
              {res.length > 0 && (
                <>
                  <button type="button" className="pd-resv" aria-expanded={showRes} onClick={() => setShowRes(!showRes)}>
                    {showRes ? "Hide" : "View"} resolved ({res.length}) {IC.chev}
                  </button>
                  {showRes && <div className="pd-rows">{res.map(rowEl)}</div>}
                </>
              )}
            </section>
          )}

          {mine.length > 0 && (
            <section className="pd-box pd-pos">
              <div className="pd-oh">
                <h2>Your position</h2>
                <span className="num">{usd(mine.map(pmx).reduce((t, m) => t + m.value, 0))}</span>
              </div>
              {mine.map((p) => {
                const m = pmx(p);
                const L = lab(m.o, p.side);
                return (
                  <div key={p.id} className="pd-p">
                    <div className="pd-p-h">
                      <span className={`pd-sd ${p.side}`}>{L.toUpperCase()}</span>
                      <b>{e.outs.length > 1 ? m.o.name : e.title}</b>
                      {m.merging ? <span className="mini warn">Merging into the Earn pool</span> : <span className="mini ok">Earning {p2(m.apy)}</span>}
                      {p.src === "wallet" && (
                        <span className="mini pd-srcm">
                          <Icon sym="WORLD" className="pd-i12" />
                          From wallet
                        </span>
                      )}
                      {p.src === "polymarket" && (
                        <span className="mini pd-srcm">
                          <Icon sym="POLY" className="pd-i12" />
                          Moved from Polymarket
                        </span>
                      )}
                      {p.q ? <span className="mini warn">Sell queued: {shf(p.q)}</span> : null}
                      <span className="pd-p-a">
                        <button
                          type="button"
                          className="btn-s"
                          onClick={() => {
                            setSel(p.o);
                            setSt((x) => ({ ...x, side: p.side, mode: "buy", amt: DEF_AMT }));
                            scrollPanel();
                          }}
                        >
                          Buy more
                        </button>
                        <button
                          type="button"
                          className="btn-s"
                          onClick={() => {
                            setSel(p.o);
                            setMode("sell", m.o, p.side);
                            scrollPanel();
                          }}
                        >
                          Sell
                        </button>
                      </span>
                    </div>
                    <div className="pd-p-g num">
                      <Cell k="Shares" v={shf(m.tot)} sub={p.yld ? `+${shf(p.yld)} from yield` : `bought ${p.t}`} />
                      <Cell k="Avg / now" v={<span className="pd-ba">{cpair(p.avg * 100, m.mk * 100)[0]}{IC.arrow}{cpair(p.avg * 100, m.mk * 100)[1]}</span>} />
                      <Cell k="Value" v={usd(m.value)} sub={<span className={m.pnl >= 0 ? "pos" : "neg"}>{sUsd(m.pnl)} P&amp;L</span>} />
                      <Cell k={<>In USDC vault <Info text={INFO.vault} /></>} v={usd(m.inVault)} sub={m.merging ? "merging" : `${pct(m.sd.share * 100, 0)} matched`} />
                      <Cell k={<>Earned <Info text={INFO.earned} /></>} v={<span className="pos">{sUsd(m.earned)}</span>} sub={`${shf(p.yld)} ${L} shares`} />
                      <Cell k={<>Pays if right <Info text={INFO.pays} /></>} v={usd(m.pays)} sub={`${p2(m.apy)} APY now`} />
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          <section className="pd-box pd-tabs-c">
            <div className="pd-tabs" role="tablist">
              {([["vault", "Vault"], ["book", "Order book"], ["rules", "Rules"], ["activity", "Activity"]] as const).map(([kk, l]) => (
                <button key={kk} type="button" className={tab === kk ? "on" : ""} role="tab" aria-selected={tab === kk} onClick={() => setTab(kk)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="pd-tab-b">
              {tab === "vault" ? <VaultTab e={e} o={o} /> : tab === "book" ? <BookTab e={e} o={o} s={st.side} /> : tab === "rules" ? <RulesTab e={e} /> : <ActTab e={e} />}
            </div>
          </section>
        </div>
        <aside className="pd-side">
          <TradePanel ref={panelRef} e={e} o={o} st={st} act={act} oselOpen={osel} setOsel={setOsel} payOpen={payOpen} setPayOpen={setPayOpen} />
        </aside>
      </div>
      <ImportSheet />
      <PredictToast />
    </div>
  );
}
