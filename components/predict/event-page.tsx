"use client";

/**
 * Predict event page (design predict.js `viewEvent`, V4): head card (tiles; price history is not
 * indexed, so a quiet note replaces the chart), the outcome rows (Buy Yes / Buy No, or +/✓ while
 * the bet slip is on), "Your position" (paired gauge, source badge, Buy more / Sell), the Earning /
 * Prices / Rules / Activity tabs and the sticky trade panel.
 * Route id = `<eventId>[~<marketId>[~yes|no]]`: a market id opens that market selected, the panel
 * on Buy with the default amount. Real data: GET /api/predict/events/:id (fresh prices and pool
 * balances), the wallet's positions and its own trades, the USDC pool rate.
 */
import "./predict-v3.css";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { IC, Icon } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { nf, pct, sUsd, usd, usdC } from "@/components/v3/format";
import { usePredictActivity, usePredictEvent } from "@/hooks/use-predict";
import { timeAgo } from "@/lib/predict/math";
import { useStartEarning, usePredictAccount } from "./positions";
import {
  DEF_AMT, LEG_AMT, MAX_TRADE_LEGS, ask, bid, byChance, canTrade, defaultOut, isDraw, lab, mName, mainOuts, nl, outOf, pairsIn, pairsOf, parseRouteId, poolSide, pooled, yl,
} from "@/lib/predict/view";
import type { PredictEvent, PredictOutcome as Outcome, PredictPosition, Side } from "@/lib/predict/types";
import { CATN, Cell, EvLogo, INFO, Kv, Meter, PIC, PoolBar, SideTag, SrcBadge, TeamLogo, Tile, cf, cpair, p2, pc, pp, shf } from "./ui";
import { TradePanel, type PanelState, heldOf } from "./trade-panel";
import { LinkedSheet } from "./linked-sheet";

type Tab = "earning" | "prices" | "rules" | "activity";

function Tiles({ e, o, rate }: { e: PredictEvent; o: Outcome; rate: number }) {
  const earnT = e.outs.some(pooled) ? <Tile k={<>Earn while you wait <Info text={INFO.apy} /></>} v={`up to ${pct(rate, 1)}`} cls="e" /> : <Tile k="Open interest" v={usdC(e.oi)} />;
  const ms = mainOuts(e);
  if (e.outs.length === 1) {
    const [py, pn] = cpair(o.y, o.n);
    if (e.type === "updown")
      return (
        <>
          <Tile k={`${yl(o)} chance`} v={pc(o.y)} cls="big" />
          <Tile k={`Buy ${yl(o)}`} v={py} cls="y" />
          <Tile k="Closes in" v={e.countdown || "Closed"} sub={e.ends || undefined} />
          {earnT}
        </>
      );
    return (
      <>
        <Tile k={`${yl(o)} chance`} v={pc(o.y)} cls="big" />
        <Tile k={`Buy ${yl(o)}`} v={py} cls="y" />
        <Tile k={`Buy ${nl(o)}`} v={pn} cls="n" />
        {earnT}
      </>
    );
  }
  if (e.type === "match") {
    const ps = ms.slice(0, 3);
    return (
      <>
        {ps.map((x) => (
          <Tile key={x.k} k={<><TeamLogo e={e} o={x} cls="xs" />{isDraw(x) ? "Draw" : x.name}</>} v={pc(x.y)} cls="big" />
        ))}
        {ps.length < 3 && <Tile k="Volume, 24h" v={usdC(e.vol)} />}
        {earnT}
      </>
    );
  }
  const lead = e.outs.slice().sort(byChance)[0];
  return (
    <>
      <Tile k="Leader" v={lead.name} sub={`${pc(lead.y)} chance`} />
      <Tile k="Volume, 24h" v={usdC(e.vol)} />
      <Tile k="Open interest" v={usdC(e.oi)} />
      {earnT}
    </>
  );
}

function OutRow({ e, o, on, st, held, onRow, onPick }: { e: PredictEvent; o: Outcome; on: boolean; st: PanelState; held: PredictPosition[]; onRow: () => void; onPick: (s: Side) => void }) {
  const leg = st.slip?.find((l) => l.k === o.k);
  const ok = canTrade(o);
  return (
    <div className={`pd-row ${on || leg ? "on" : ""}`} onClick={ok ? onRow : undefined}>
      <div className="pd-r-n">
        {e.type === "match" ? <TeamLogo e={e} o={o} cls="sm" /> : null}
        <div>
          <b>{o.name}</b>
          <small className="num">
            <span>Vol {usdC(o.vol)}</span>
            {!ok && <span>No World trades yet</span>}
            {ok && !pooled(o) && <span>Not in Vanna&apos;s pool</span>}
            {held.length > 0 && <span className="pd-you">You hold {held.map((p) => `${shf(p.shares)} ${p.label}`).join(" and ")}</span>}
          </small>
        </div>
      </div>
      <div className="pd-r-p num">
        <b>{pc(o.y)}</b>
      </div>
      <div className="pd-r-b num">
        {(["yes", "no"] as const).map((s, i) => {
          const sel = st.slip ? leg?.s === s : on && st.side === s && st.mode === "buy";
          return (
            <button
              key={s}
              type="button"
              disabled={!ok}
              className={`${s === "yes" ? "pd-y" : "pd-n"} ${sel ? "on" : ""}`}
              onClick={(ev) => {
                ev.stopPropagation();
                onPick(s);
              }}
            >
              {st.slip ? (sel ? IC.check : PIC.plus) : null}
              {ok ? `Buy ${lab(o, s)} ${cpair(o.y, o.n)[i]}` : `${lab(o, s)}: no price`}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EarnTab({ e, o, rate, mineV }: { e: PredictEvent; o: Outcome; rate: number; mineV: number }) {
  const y = poolSide(o, "yes", rate);
  const n = poolSide(o, "no", rate);
  const pairs = pairsOf(o);
  const ops = e.outs.filter(pooled);
  if (!pooled(o) && !ops.length)
    return <p className="pd-note sm">{INFO.notPooled} Pools open market by market.</p>;
  return (
    <>
      <div className="pd-et">
        <p className="pd-et-l num">
          {e.outs.length > 1 ? `${o.name}: ` : ""}
          {pooled(o) ? (
            <>
              <b>
                {nf(pairs, pairs >= 100 ? 0 : 2)} pair{pairs === 1 ? "" : "s"} earning {p2(rate)}
              </b>{" "}
              in Vanna&apos;s USDC pool <Info text={INFO.pairs} />
            </>
          ) : (
            <b>Not in Vanna&apos;s pool yet</b>
          )}
        </p>
        {pooled(o) && (
          <>
            <PoolBar o={o} />
            <div className="pd-pb-k num">
              <span>
                <SideTag s="yes" L={yl(o)} />
                {nf(o.pool.yes, 2)} in pool, {y.full ? "all paired" : `${nf(y.waiting, 2)} waiting`}
                <b className={y.full && y.mine > 0 ? "pos" : ""}>earns {p2(y.apy)}</b>
              </span>
              <span>
                <SideTag s="no" L={nl(o)} />
                {nf(o.pool.no, 2)} in pool, {n.full ? "all paired" : `${nf(n.waiting, 2)} waiting`}
                <b className={n.full && n.mine > 0 ? "pos" : ""}>earns {p2(n.apy)}</b>
              </span>
            </div>
          </>
        )}
        <ul className="pd-how">
          <li>Your shares earn when they can be paired with the opposite side in this market&apos;s pool.</li>
          <li>Paired shares earn {p2(rate)} in Vanna&apos;s USDC pool. Unpaired shares wait until more of the other side arrives.</li>
          <li>More deposits on the other side mean more of yours earn. If they leave, fewer of yours earn.</li>
          <li>Yield is paid in extra shares of your side, so it pays out only if your side wins.</li>
        </ul>
      </div>
      {e.outs.length > 1 && ops.length > 0 && (
        <div className="pd-vtbl">
          <div className="pd-vt-h">
            <span>Market</span>
            <span>Pool balance</span>
            <span>Pairs</span>
            <span>
              Yes earns <Info text={INFO.sideApy} />
            </span>
            <span>No earns</span>
          </div>
          {ops.map((x) => {
            const a = poolSide(x, "yes", rate);
            const b = poolSide(x, "no", rate);
            return (
              <div key={x.k} className={`pd-vt-r num ${x.k === o.k ? "on" : ""}`}>
                <span>
                  {e.type === "match" ? <TeamLogo e={e} o={x} cls="xs" /> : null}
                  {x.name}
                </span>
                <span>
                  <PoolBar o={x} />
                </span>
                <span className="pd-lent">
                  <Icon sym="USDC" className="pd-i14" />
                  {nf(pairsOf(x), pairsOf(x) >= 100 ? 0 : 2)}
                </span>
                <span className={a.full && a.mine > 0 ? "pos" : ""}>{p2(a.apy)}</span>
                <span className={b.full && b.mine > 0 ? "pos" : ""}>{p2(b.apy)}</span>
              </div>
            );
          })}
        </div>
      )}
      {mineV > 0 && (
        <p className="pd-note">
          Your paired shares here are worth{" "}
          <b className="num" style={{ color: "var(--pd-text)" }}>
            {usd(mineV)}
          </b>{" "}
          today.
        </p>
      )}
    </>
  );
}

/** Best prices now (World's latest trades): what the panel fills at. No depth is indexed. */
function PricesTab({ e, o }: { e: PredictEvent; o: Outcome }) {
  const row = (s: Side) => (
    <div className="pd-bk-r" key={s}>
      <span>
        <SideTag s={s} L={lab(o, s)} />
      </span>
      <span>{cf(ask(o, s))}</span>
      <span>{cf(bid(o, s))}</span>
    </div>
  );
  return (
    <div className="pd-bk num">
      <div className="pd-bk-h">
        <span>{e.outs.length > 1 ? o.name : "Side"}</span>
        <span>Buy at</span>
        <span>Sell at</span>
      </div>
      {row("yes")}
      {row("no")}
      <div className="pd-kvs num">
        <Kv k="Last trade" v={e.last || "No trades yet"} />
        <Kv k="Open interest" v={usdC(o.oi)} />
        <Kv k="Volume, 24h" v={usdC(o.vol)} />
      </div>
      <p className="pd-note">{INFO.prices} The full order book is not shown yet.</p>
    </div>
  );
}

function RulesTab({ e }: { e: PredictEvent }) {
  return (
    <div className="pd-rules">
      <p>{e.rules}</p>
      <div className="pd-kvs num">
        <Kv k="Resolver" v={<><Icon sym="WORLD" className="pd-i16" />World, on-chain</>} />
        <Kv k="Winning share pays" v={<><Icon sym="CASH" className="pd-i16" />$1 (1 CASH), extra yield shares too</>} />
        <Kv k="Losing share" v="Worth $0, extra yield shares too" />
        <Kv k="Source" v={e.source} />
        {e.opened && <Kv k="Market opened" v={e.opened} />}
        <Kv k="Ends" v={e.ends || "When World resolves it"} />
      </div>
    </div>
  );
}

/** The connected wallet's own trades on this event (rebuilt from its fork transactions). */
function ActTab({ e, connected }: { e: PredictEvent; connected: boolean }) {
  const { data, isLoading } = usePredictActivity();
  if (!connected) return <p className="pd-note sm">Connect a wallet to see your trades on this event.</p>;
  const ids = new Set(e.outs.map((o) => o.k));
  const rows = (data ?? []).filter((t) => ids.has(t.marketId));
  if (isLoading) return <p className="pd-note sm">Loading your trades…</p>;
  if (!rows.length) return <p className="pd-note sm">No trades on this event yet.</p>;
  const ago = (ms: number | null) => timeAgo(ms) || "N/A";
  return (
    <div>
      {rows.slice(0, 20).map((t) => {
        const o = outOf(e, t.marketId);
        return (
          <div key={`${t.signature}-${t.marketId}-${t.outcome}`} className="pd-act-r num">
            <span className="t">{ago(t.time)}</span>
            <span className="d">
              {t.side === "buy" ? "Buy" : "Sell"} <SideTag s={t.outcome} L={o ? lab(o, t.outcome) : t.outcomeLabel} />
              {e.outs.length > 1 && <small>{o?.name ?? t.question}</small>}
              {t.pooled > 0 && <small>into Vanna&apos;s pool</small>}
            </span>
            <span className="a">
              {shf(t.shares)} at {cf(t.price * 100)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One position on this event (pool part + wallet part of one market side). */
function PosBlock({ e, p, rate, onMore, onSell, onEarn, busy }: { e: PredictEvent; p: PredictPosition; rate: number; onMore: () => void; onSell: () => void; onEarn: (() => void) | null; busy: boolean }) {
  const o = outOf(e, p.marketId);
  const L = p.label;
  const share = p.shares > 0 ? Math.min(1, p.matched / 100) : 0;
  const inPool = p.poolValueShares > 0;
  const status = !inPool ? <span className="mini warn">Not earning</span> : p.merging ? <span className="mini warn">Joining the pool</span> : <span className="mini ok">Earning {p2(p.apy)}</span>;
  return (
    <div className="pd-p">
      <div className="pd-p-h">
        <SideTag s={p.side} L={L} />
        <b>{o ? mName(e, o) : p.market}</b>
        {status}
        <SrcBadge src={inPool ? "vanna" : "world"} />
        <span className="pd-p-a">
          <button type="button" className="btn-s" onClick={onMore} disabled={!o || !canTrade(o)}>
            Buy more
          </button>
          <button type="button" className="btn-s" onClick={onSell}>
            Sell
          </button>
        </span>
      </div>
      {inPool && !p.merging && (
        <div className="pd-pair">
          <div className="pd-pair-h">
            <b>
              Earning on {pp(share)} of your shares <Info text={INFO.paired} />
            </b>
            <span className="num">
              {shf(p.shares * share)} of {shf(p.shares)} {L} paired
            </span>
          </div>
          <Meter v={share} />
          <p className="num">Changes as people buy or sell on either side. Paired shares earn {p2(rate)}.</p>
        </div>
      )}
      {p.walletShares > 0 && (
        <div className="pd-qd">
          <span>
            {IC.wallet}
            <span>
              <b className="num">
                {shf(p.walletShares)} {L} in your wallet
              </b>{" "}
              {onEarn ? "are not earning. Move them into Vanna's pool to earn." : "do not earn: this market is not in Vanna's pool yet."}
            </span>
          </span>
          {onEarn && (
            <button type="button" className="btn-v" disabled={busy} onClick={onEarn}>
              Start earning
            </button>
          )}
        </div>
      )}
      <div className="pd-p-g num">
        <Cell k="Shares" v={shf(p.shares)} sub={p.yieldShares > 0.005 ? `${shf(p.yieldShares)} extra from yield` : p.since ? `bought ${p.since}` : "held now"} />
        <Cell k="Avg / now" v={<span className="pd-ba">{cpair(p.avg * 100, p.mark * 100)[0]}{IC.arrow}{cpair(p.avg * 100, p.mark * 100)[1]}</span>} />
        <Cell k="Value" v={usd(p.value)} sub={<span className={p.pnl >= 0 ? "pos" : "neg"}>{sUsd(p.pnl)} P&amp;L</span>} />
        <Cell k={<>Earning in pool <Info text={INFO.inPool} /></>} v={usd(p.inVault)} sub={p.merging ? "joining" : `${pp(share)} paired`} />
        <Cell k={<>Earned <Info text={INFO.earned} /></>} v={<span className="pos">{sUsd(p.earned)}</span>} sub={`${shf(Math.max(0, p.yieldShares))} extra ${L} shares`} />
        <Cell k={<>Pays if right <Info text={INFO.pays} /></>} v={usd(p.pays)} sub={`${p2(p.apy)} APY now`} />
      </div>
    </div>
  );
}

function EventView({ e, ev, mk, sd }: { e: PredictEvent; ev: string; mk?: string; sd?: Side }) {
  const acct = usePredictAccount();
  const earn = useStartEarning();
  const rate = acct.rate;
  // A route that names a market (or IS a market id) opens it selected.
  const start = outOf(e, mk ?? ev) ?? defaultOut(e);
  const [sel, setSel] = useState<string>(start.k);
  const [tab, setTab] = useState<Tab>("earning");
  const [st, setSt] = useState<PanelState>(() => {
    const w = acct.data?.wallet;
    return { side: sd ?? "yes", mode: "buy", amt: DEF_AMT, pay: w && w.cash <= 0 && w.usdc > 0 ? "USDC" : "CASH", slip: null, pop: null };
  });
  const panelRef = useRef<HTMLElement>(null);
  const set = useCallback((p: Partial<PanelState>) => setSt((x) => ({ ...x, ...p })), []);
  const o = outOf(e, sel) ?? start;
  const data = acct.data;
  const mine = (data?.positions ?? []).filter((p) => e.outs.some((x) => x.k === p.marketId));
  const scrollPanel = () => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const sellAmt = (x: Outcome, s: Side) => {
    const h = heldOf(data, x, s).total;
    return h ? String(Math.floor(h * 100) / 100) : "";
  };
  const choose = (k: string) => {
    setSel(k);
    const x = outOf(e, k);
    if (x && st.mode === "sell") set({ amt: sellAmt(x, st.side) });
  };
  const addLeg = (k: string, s: Side = "yes") =>
    setSt((x) => {
      const legs = x.slip ?? [];
      const l = legs.find((z) => z.k === k);
      if (!l) return legs.length >= MAX_TRADE_LEGS ? x : { ...x, slip: [...legs, { k, s, amt: LEG_AMT }] };
      if (l.s !== s) return { ...x, slip: legs.map((z) => (z.k === k ? { ...z, s } : z)) };
      return { ...x, slip: legs.filter((z) => z !== l) };
    });
  const pick = (x: Outcome, s: Side) => {
    if (st.slip && st.mode === "buy") return addLeg(x.k, s);
    setSel(x.k);
    set({ side: s, mode: "buy", amt: st.mode === "buy" ? st.amt : DEF_AMT });
    scrollPanel();
  };

  const ms = mainOuts(e);
  const lines = e.outs.filter((x) => x.grp);
  const rows = e.type === "match" ? ms : ms.slice().sort(byChance);
  const outsTitle = ({ match: "Who wins", multi: "Outcomes", date: "Dates", strike: "Price targets" } as Record<string, string>)[e.type] ?? "Markets";
  const note = e.note ? e.note.charAt(0).toUpperCase() + e.note.slice(1) : e.exh === false ? "Every listed outcome can lose" : "";
  const when = e.live ? `${e.when ?? ""}` : e.when ? e.when : e.ends ? `Ends ${e.ends}` : e.last ? `Last trade ${e.last}` : "";
  const tv = mine.reduce((t, p) => t + p.value, 0);
  const mineV = mine.reduce((t, p) => t + p.inVault, 0);
  const pairsAll = pairsIn(e);

  return (
    <div className="v3 page">
      <Link href="/predict" className="pd-back">
        {PIC.back}All markets
      </Link>
      <div className="pd-cols">
        <div className="pd-main">
          <section className="pd-box pd-head">
            <div className="pd-h-top">
              <EvLogo e={e} cls="lg" />
              <div className="pd-h-q">
                <div className="pd-h-tags">
                  <span className="pd-ltag">{e.tag}</span>
                  <span className="pd-hcat">{CATN[e.cat]}</span>
                  {e.live && <span className="pd-live">LIVE</span>}
                  {when && <span className="pd-hcat num">{when}</span>}
                  <span className="pd-hcat num">Vol {usdC(e.vol)}</span>
                  {pairsAll > 0 && <span className="pd-hcat num">{usdC(pairsAll)} earning in the pool</span>}
                </div>
                <h1 className="pd-h1">{e.title}</h1>
              </div>
            </div>
            <div className="pd-tiles num">
              <Tiles e={e} o={o} rate={rate} />
            </div>
            {e.outs.length === 1 && o.y !== null && (
              <div className="pd-pbar">
                <i style={{ width: `${Math.min(100, o.y)}%` }} />
              </div>
            )}
            <p className="pd-chart-e">
              {IC.clock}
              <span>Price history is not available yet. Prices here update live from the latest World trades{e.last ? ` (last trade ${e.last})` : ""}.</span>
            </p>
          </section>

          {e.outs.length > 1 && (
            <section className="pd-box pd-outs">
              <div className="pd-oh">
                <h2>{outsTitle}</h2>
                <span>{note}</span>
              </div>
              {st.slip && st.mode === "buy" && (
                <p className="pd-sliphint">
                  {PIC.plus}Bet slip is on. Tap Buy Yes or Buy No on any row to add it.
                </p>
              )}
              <div className="pd-rows">
                {rows.map((x) => (
                  <OutRow
                    key={x.k}
                    e={e}
                    o={x}
                    on={x.k === o.k && !st.slip}
                    st={st}
                    held={mine.filter((p) => p.marketId === x.k)}
                    onRow={() => !st.slip && choose(x.k)}
                    onPick={(s) => pick(x, s)}
                  />
                ))}
              </div>
              {lines.length > 0 && (
                <>
                  <div className="pd-oh sub">
                    <h2>More on this game</h2>
                    <span>Side bets on the same game. Each one is its own Yes or No market.</span>
                  </div>
                  <div className="pd-rows">
                    {lines.map((x) => (
                      <OutRow key={x.k} e={e} o={x} on={x.k === o.k && !st.slip} st={st} held={mine.filter((p) => p.marketId === x.k)} onRow={() => !st.slip && choose(x.k)} onPick={(s) => pick(x, s)} />
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {mine.length > 0 && (
            <section className="pd-box pd-pos">
              <div className="pd-oh">
                <h2>Your position</h2>
                <span className="num">{usd(tv)}</span>
              </div>
              {mine.map((p) => {
                const x = outOf(e, p.marketId);
                const imp = data?.importable.find((i) => i.marketId === p.marketId && i.side === p.side) ?? null;
                return (
                  <PosBlock
                    key={p.id}
                    e={e}
                    p={p}
                    rate={rate}
                    busy={earn.busy}
                    onEarn={imp ? () => earn.start([imp]) : null}
                    onMore={() => {
                      setSel(p.marketId);
                      set({ side: p.side, mode: "buy", amt: DEF_AMT, slip: null });
                      scrollPanel();
                    }}
                    onSell={() => {
                      setSel(p.marketId);
                      set({ side: p.side, mode: "sell", slip: null, amt: x ? sellAmt(x, p.side) : "" });
                      scrollPanel();
                    }}
                  />
                );
              })}
            </section>
          )}

          <section className="pd-box pd-tabs-c">
            <div className="pd-tabs" role="tablist">
              {([["earning", "Earning"], ["prices", "Prices"], ["rules", "Rules"], ["activity", "Activity"]] as const).map(([k, l]) => (
                <button key={k} type="button" className={tab === k ? "on" : ""} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="pd-tab-b">
              {tab === "earning" ? <EarnTab e={e} o={o} rate={rate} mineV={mineV} /> : tab === "prices" ? <PricesTab e={e} o={o} /> : tab === "rules" ? <RulesTab e={e} /> : <ActTab e={e} connected={acct.connected} />}
            </div>
          </section>
        </div>
        <aside className="pd-side">
          <TradePanel ref={panelRef} e={e} o={o} st={st} set={set} choose={choose} addLeg={addLeg} data={data} address={acct.address} rate={rate} />
        </aside>
      </div>
      <LinkedSheet />
    </div>
  );
}

/** The event page: loads the event (by event id or any of its market ids), then the view. */
export function PredictEventPage({ id }: { id: string }) {
  const { ev, mk, sd } = parseRouteId(id);
  const { data: e, isLoading, error } = usePredictEvent(ev);
  if (!e)
    return (
      <div className="v3 page">
        <Link href="/predict" className="pd-back">
          {PIC.back}All markets
        </Link>
        <div className="pd-load" style={{ marginTop: 16 }}>
          {isLoading ? "Loading the market from World… the first load can take up to a minute." : `This market could not be loaded${error ? `: ${(error as Error).message}` : "."}`}
        </div>
      </div>
    );
  return <EventView e={e} ev={ev} mk={mk} sd={sd} />;
}
