"use client";

/**
 * Predict (BETA) trade panel (design predict.js `panel` / `prevBuy` / `prevSell`): Buy / Sell,
 * market picker, YES / NO, amount box with pay token + % buttons, then the buy preview (payout,
 * "earns while you wait" vault box, 3-step route) or the one-step sell route (unmatched first,
 * USDC withdrawn + split, queue when the Earn pool is short). UI only: quotes walk the sample
 * order book and the button changes the in-memory sample — no transaction is sent.
 */
import { forwardRef, useEffect, useRef } from "react";
import { IC, Icon } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { nf, pct, sUsd, usd } from "@/components/v3/format";
import {
  RATE, ask, bid, buyFx, clamp, heldOf, isTight, lab, openOuts, posOf, qSell, sampleWallet, sellN, sellRoute, side, twinOf, usdcPool,
  type Outcome, type PredictEvent, type Side,
} from "@/lib/predict-sample";
import { INFO, IcFor, Kv, PreviewNote, cf, cpair, k2, p2, parseAmt, pc, shf } from "./ui";

export interface PanelState {
  side: Side;
  mode: "buy" | "sell";
  amt: string;
  pay: "USDC" | "CASH";
}
export interface PanelActions {
  setSide: (s: Side) => void;
  setMode: (m: "buy" | "sell") => void;
  setAmt: (a: string) => void;
  setPay: (p: "USDC" | "CASH") => void;
  choose: (k: string) => void;
  twin: (k: string, s: Side) => void;
  exec: () => void;
  tight: () => void;
  cancelQ: (id: string) => void;
}

const Step = ({ i, k, v, sub, off, tip }: { i: number; k: string; v: React.ReactNode; sub: React.ReactNode; off?: boolean; tip?: string }) => (
  <div className={`pd-st ${off ? "off" : ""}`}>
    <p>
      <i>{i}</i>
      {k}
      {tip ? <Info text={tip} /> : null}
    </p>
    <b>{v}</b>
    <small>{sub}</small>
  </div>
);

/** A small popover that closes on an outside click / Escape. */
function usePopClose(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const h = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "mousedown" && ref.current?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", h);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", h);
    };
  }, [open, close, ref]);
}

function BuyPreview({ e, o, st, act }: { e: PredictEvent; o: Outcome; st: PanelState; act: PanelActions }) {
  const s = st.side;
  const L = lab(o, s);
  const a = parseAmt(st.amt);
  const fx = buyFx(o, s, a);
  const q = fx.q;
  const sd = fx.after;
  const mo = (a * sd.share * RATE()) / 100 / 12;
  const held = heldOf(e, o, s);
  const tw = twinOf(e, o, s);
  const bal = sampleWallet()[st.pay] || 0;
  let lbl = `Buy ${L}`;
  let dis = false;
  if (!a) {
    lbl = "Enter amount";
    dis = true;
  } else if (a > bal) {
    lbl = `Not enough ${st.pay}`;
    dis = true;
  }
  return (
    <>
      <details className="pd-det" open>
        <summary>
          More details {IC.chev}
        </summary>
        <div className="rows num">
          <Kv k="Avg price" v={cf(a ? q.avg : ask(o, s))} />
          <Kv k="Shares" v={shf(a ? q.sh : 0)} />
          <Kv k={<>Pays if right <Info text={INFO.pays} /></>} v={usd(a ? q.sh : 0)} cls="g" />
          <Kv k="Profit if right" v={a ? `${sUsd(q.sh - a)} (${pct(((q.sh - a) / a) * 100, 0)})` : `${usd(0)} (${pct(0, 0)})`} cls="g" />
        </div>
      </details>
      <div className="pd-eb">
        <div className="pd-eb-h">
          <span>
            {IC.coins}Earns while you wait <Info text={INFO.apy} />
          </span>
          <b className="num">{p2(sd.apy)} APY</b>
        </div>
        <div className="pd-eb-r num">
          <span>
            Matched <Info text={INFO.matched} />
          </span>
          <span className="pd-meter">
            <i style={{ width: `${(sd.share * 100).toFixed(0)}%` }} />
          </span>
          <b>
            {pct(sd.share * 100, 0)}
            {a ? ` · ${usd(a * sd.share)}` : ""}
          </b>
        </div>
        <div className="pd-eb-r t num">
          <span>
            Est. yield <Info text={INFO.estYield} />
          </span>
          <b>{`+${usd(a ? mo : 0)} / month in ${L} shares`}</b>
        </div>
        {!sd.scarce && (
          <div className="pd-eb-r t num">
            <span>
              Smaller side <Info text={INFO.small} />
            </span>
            <b>
              {lab(o, s === "yes" ? "no" : "yes")} earns {p2(RATE())} here
            </b>
          </div>
        )}
        {held > 0 && a > 0 && sd.share < fx.before.share - 1e-4 && (
          <div className="pd-eb-r t num">
            <span>Your {L}</span>
            <b className="pd-dil">
              {shf(held)} you hold:{" "}
              <span className="pd-ba">
                {p2(fx.before.apy)}
                {IC.arrow}
                {p2(sd.apy)}
              </span>
            </b>
          </div>
        )}
        <div className="pd-route num">
          <Step i={1} k="Buy" v={`${shf(a ? q.sh : 0)} ${L}`} sub={a ? `avg ${cf(q.avg)}` : "on World"} tip={INFO.buyStep} />
          <Step i={2} k="Vault" v={`${pct(sd.share * 100, 0)} matched`} sub={sd.scarce ? "smaller side" : "larger side"} tip={INFO.vaultStep} />
          <Step
            i={3}
            k="Earn pool"
            v={<><Icon sym="USDC" className="pd-i14" />{a && fx.newPairs > 0.005 ? `+${usd(fx.newPairs)}` : "+$0.00"}</>}
            sub={fx.newPairs > 0.005 || !a ? "new USDC lent" : "shares existing pairs"}
            tip={INFO.newUsd}
          />
        </div>
      </div>
      {tw && (
        <p className="pd-twin">
          Same bet as{" "}
          <b>
            {tw.o.name} {lab(tw.o, tw.s)}
          </b>{" "}
          at {cf(ask(tw.o, tw.s))}
          {tw.tie ? " (except a tie)" : ""}: it earns {p2(side(tw.o, tw.s).apy)}, this side {p2(sd.apy)}.{" "}
          <button type="button" className="lnk" onClick={() => act.twin(tw.o.k, tw.s)}>
            Switch
          </button>
        </p>
      )}
      <PreviewNote />
      <button type="button" className="pd-cta" disabled={dis} onClick={act.exec}>
        {lbl}
      </button>
      <p className="pd-fine">
        One step: the shares are bought and deposited into Vanna&apos;s yield vault. Each winning share pays $1. Yield arrives as extra {L} shares, so it pays only if {L} wins.
      </p>
    </>
  );
}

function SellPreview({ e, o, st, act }: { e: PredictEvent; o: Outcome; st: PanelState; act: PanelActions }) {
  const s = st.side;
  const L = lab(o, s);
  const other = lab(o, s === "yes" ? "no" : "yes");
  const held = heldOf(e, o, s);
  const p = posOf(e, o, s);
  const qd = p ? p.q || 0 : 0;
  const a = parseAmt(st.amt);
  const n = sellN(e, o, s, a);
  const r = sellRoute(o, s, n);
  const qNow = qSell(o, s, r.nowSh);
  const qAll = qSell(o, s, n);
  const tot = p ? p.sh + p.yld : 0;
  const ySh = p && tot ? (n * p.yld) / tot : 0;
  const cost = p && tot ? ((n * p.sh) / tot) * p.avg : 0;
  const tight = isTight();
  const queuedBlock =
    qd > 0 && p ? (
      <div className="pd-qd">
        <span>
          {IC.clock}
          <span>
            <b className="num">
              {shf(qd)} {L} queued
            </b>{" "}
            · completes when the Earn pool frees USDC; they keep earning meanwhile
          </span>
        </span>
        <button type="button" className="btn-s" onClick={() => act.cancelQ(p.id)}>
          Cancel queued sell
        </button>
      </div>
    ) : null;
  if (!held && qd > 0)
    return (
      <>
        {queuedBlock}
        {tight && (
          <button type="button" className="pd-demo" onClick={act.tight}>
            Demo: normal liquidity
          </button>
        )}
        <p className="pd-fine">All your {L} shares here are queued to sell.</p>
      </>
    );
  const pool = usdcPool();
  const freePct = clamp((r.free / pool.sup) * 100, 0, 100);
  const myShare = p ? side(o, s).share : 1;
  const usdIco = <Icon sym="USDC" className="pd-i14" />;
  let steps: React.ReactNode;
  if (r.fromVault >= n && n > 0)
    steps = (
      <>
        <Step i={1} k="From vault" v={`${shf(n)} ${L}`} sub="market's unmatched · no USDC" />
        <Step i={2} k="Split" v="not needed" sub="no USDC used" off />
        <Step i={3} k="Sell" v={`${shf(n)} ${L}`} sub={`avg ${cf(qAll.avg)}`} />
      </>
    );
  else if (r.fromVault > 0)
    steps = (
      <>
        <Step i={1} k="From vault" v={`${shf(r.fromVault)} ${L}`} sub="market's unmatched" />
        <Step i={2} k="Withdraw" v={<>{usdIco}{usd(r.needUsd)}</>} sub={`split: keep ${L}, ${other} stays`} />
        <Step i={3} k="Sell" v={`${shf(n)} ${L}`} sub={`avg ${cf(qAll.avg)}`} />
      </>
    );
  else
    steps = (
      <>
        <Step i={1} k="Withdraw" v={<>{usdIco}{usd(n ? r.needUsd : 0)}</>} sub="USDC from Earn pool" />
        <Step i={2} k="Split" v={`${shf(n ? r.needUsd : 0)} pairs`} sub={`keep ${L}, ${other} stays`} />
        <Step i={3} k="Sell" v={`${shf(n || 0)} ${L}`} sub={`avg ${cf(n ? qAll.avg : bid(o, s))}`} />
      </>
    );
  let lbl = `Sell ${L}`;
  let dis = false;
  if (!held) {
    lbl = `You hold no ${L} shares here`;
    dis = true;
  } else if (!a) {
    lbl = "Enter shares";
    dis = true;
  } else if (a > held + 1e-9) {
    lbl = "Not enough shares";
    dis = true;
  } else if (r.queued > 0) lbl = r.nowSh > 0 ? `Sell ${shf(r.nowSh)} now · queue ${shf(r.queued)}` : `Queue sell of ${shf(r.queued)}`;
  return (
    <>
      <details className="pd-det" open>
        <summary>More details {IC.chev}</summary>
        <div className="rows num">
          <Kv k="Avg price" v={cf(n ? qAll.avg : bid(o, s))} />
          <Kv k="You receive" v={n ? `${usd(r.queued ? qNow.usd : qAll.usd)}${r.queued ? " now" : ""}` : usd(0)} cls="g" />
          <Kv k={<>Incl. yield <Info text={INFO.earned} /></>} v={n ? `${sUsd((ySh * qAll.avg) / 100)} (${shf(ySh)} sh)` : `${usd(0)} (${shf(0)} sh)`} cls="e" />
          <Kv k="P&L on these shares" v={n ? <span className={qAll.usd - cost >= 0 ? "pos" : "neg"}>{sUsd(qAll.usd - cost)}</span> : usd(0)} />
        </div>
      </details>
      <div className="pd-eb sell">
        <div className="pd-eb-h">
          <span>
            {IC.bolt}Sell in one step <Info text={INFO.split} />
          </span>
          <b className="num">{usd(n ? (r.queued ? qNow.usd : qAll.usd) : 0)}</b>
        </div>
        <div className="pd-route num">{steps}</div>
        {r.fromVault > 0 && myShare < 0.999 && (
          <p className="pd-note sm">
            Your {pct(myShare * 100, 0)} matched is your share of the pairs; sells use the market&apos;s unmatched {L} first.
          </p>
        )}
        {n > 0 && r.needUsd < 0.005 ? (
          <p className="pd-okl">{IC.check}No USDC needed: this sell uses unmatched shares</p>
        ) : (
          <div className="pd-liq num">
            <span>
              {usdIco}Free in Earn pool <Info text={INFO.free} />
            </span>
            <span className="pd-meter">
              <i style={{ width: `${clamp(freePct, 0.8, 100).toFixed(1)}%` }} />
            </span>
            <b>{k2(r.free)}</b>
            <span className={`mini ${r.queued > 0 ? "warn" : "ok"}`}>{r.queued > 0 ? "Short" : "Enough"}</span>
          </div>
        )}
        {r.queued > 0 && (
          <div className="pd-warn">
            {IC.warn}
            <div>
              <b>Earn pool is {pct(100 - freePct, 1)} borrowed</b>
              {shf(r.nowSh)} {L} sell now. {shf(r.queued)} wait for USDC to free up and keep earning meanwhile; the sell completes automatically.
            </div>
          </div>
        )}
        {(r.needUsd >= 0.005 || tight) && (
          <button type="button" className="pd-demo" onClick={act.tight}>
            {tight ? "Demo: normal liquidity" : "Demo: tight liquidity"}
          </button>
        )}
      </div>
      {queuedBlock}
      <PreviewNote />
      <button type="button" className="pd-cta" disabled={dis} onClick={act.exec}>
        {lbl}
      </button>
      <p className="pd-fine">
        {held ? `You hold ${shf(held)} ${L} in the vault. ` : ""}Unmatched shares go first; the rest is withdrawn from the Earn pool as USDC, split into {L} + {other} ({other} stays in the vault) and sold.
      </p>
    </>
  );
}

/** The trade panel of an event page. */
export const TradePanel = forwardRef<HTMLElement, { e: PredictEvent; o: Outcome; st: PanelState; act: PanelActions; oselOpen: boolean; setOsel: (v: boolean) => void; payOpen: boolean; setPayOpen: (v: boolean) => void }>(
  function TradePanel({ e, o, st, act, oselOpen, setOsel, payOpen, setPayOpen }, ref) {
    const buy = st.mode === "buy";
    const s = st.side;
    const list = openOuts(e);
    const multi = list.length > 1;
    const oselRef = useRef<HTMLDivElement>(null);
    const payRef = useRef<HTMLSpanElement>(null);
    usePopClose(oselOpen, () => setOsel(false), oselRef);
    usePopClose(payOpen, () => setPayOpen(false), payRef);
    const L = lab(o, s);
    const p = posOf(e, o, s);
    const qd = p ? p.q || 0 : 0;
    const wallet = sampleWallet();
    const pp = buy ? cpair(ask(o, "yes"), ask(o, "no")) : cpair(bid(o, "yes"), bid(o, "no"));
    const a = parseAmt(st.amt);
    const amtUsd = buy ? `~ ${usd(a)}` : `~ ${usd(qSell(o, s, sellN(e, o, s, a)).usd)}`;
    const k = ({ match: "Market", date: "Date", strike: "Target", multi: "Outcome" } as Record<string, string>)[e.type] || "Market";
    return (
      <section className="pd-panel" aria-label="Trade" ref={ref}>
        <div className="pd-ph">
          <div className="pd-ph-t">
            <IcFor e={e} o={e.type === "match" ? o : null} cls="xs" />
            <b>{e.title}</b>
          </div>
          <div className="pd-bs" role="group" aria-label="Buy or sell">
            <button type="button" className={buy ? "on" : ""} aria-pressed={buy} onClick={() => act.setMode("buy")}>
              Buy
            </button>
            <button type="button" className={!buy ? "on" : ""} aria-pressed={!buy} onClick={() => act.setMode("sell")}>
              Sell
            </button>
          </div>
        </div>
        {multi && (
          <div className="pd-osel" ref={oselRef}>
            <button type="button" className="pd-osel-b" aria-haspopup="listbox" aria-expanded={oselOpen} onClick={() => setOsel(!oselOpen)}>
              <span className="k">{k}</span>
              <span className="v">{o.name}</span>
              <span className="p num">{pc(o.y)}</span>
              {IC.chev}
            </button>
            {oselOpen && (
              <div className="pop pd-olist" role="listbox">
                {list.map((x) => (
                  <button key={x.k} type="button" className={`mi ${x.k === o.k ? "on" : ""}`} role="option" aria-selected={x.k === o.k} onClick={() => act.choose(x.k)}>
                    <span className="nm">{x.name}</span>
                    <span className="num">{pc(x.y)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="pd-yn num">
          {(["yes", "no"] as const).map((x, i) => (
            <button key={x} type="button" className={`${x === "yes" ? "pd-y" : "pd-n"} ${s === x ? "on" : ""}`} aria-pressed={s === x} onClick={() => act.setSide(x)}>
              <span>{lab(o, x).toUpperCase()}</span>
              <span className="pd-op">{pp[i]}</span>
            </button>
          ))}
        </div>
        <div className="pd-amt">
          <div className="pd-amt-t">
            {buy ? (
              <span className="pd-tokw" ref={payRef}>
                <button type="button" className="pd-tok" aria-haspopup="menu" aria-expanded={payOpen} onClick={() => setPayOpen(!payOpen)}>
                  <Icon sym={st.pay} />
                  {st.pay}
                  {IC.chev}
                </button>
                {payOpen && (
                  <div className="pop" role="menu">
                    {(["USDC", "CASH"] as const).map((t) => (
                      <button key={t} type="button" className={`mi ${st.pay === t ? "on" : ""}`} role="menuitem" onClick={() => act.setPay(t)}>
                        <Icon sym={t} />
                        {t}
                        <small className="num">{nf(wallet[t] || 0, 2)}</small>
                      </button>
                    ))}
                  </div>
                )}
              </span>
            ) : (
              <span className="pd-tok sh">
                <span className={`pd-sd ${s}`}>{L.toUpperCase()}</span>shares
              </span>
            )}
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={st.amt}
              aria-label={buy ? "Amount to spend" : "Shares to sell"}
              onChange={(ev) => {
                let v = ev.target.value.replace(/[^0-9.]/g, "");
                const i = v.indexOf(".");
                if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, "").slice(0, 2);
                act.setAmt(v);
              }}
            />
          </div>
          <p className="pd-amt-u num">{amtUsd}</p>
          <div className="pd-amt-f">
            <span className="pd-pcs">
              {[10, 25, 50, 100].map((x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => {
                    const base = buy ? wallet[st.pay] || 0 : heldOf(e, o, s);
                    act.setAmt(String(Math.floor(base * (x / 100) * 100) / 100));
                  }}
                >
                  {x}%
                </button>
              ))}
            </span>
            <span className="pd-bal num">
              {buy ? `Sample bal: ${nf(wallet[st.pay] || 0, 2)} ${st.pay}` : `In vault: ${shf(heldOf(e, o, s))} ${L}${qd ? ` · ${shf(qd)} queued` : ""}`}
            </span>
          </div>
        </div>
        <div className="pd-prev">
          {o.res ? (
            <button type="button" className="pd-cta" disabled>
              Market resolved
            </button>
          ) : buy ? (
            <BuyPreview e={e} o={o} st={st} act={act} />
          ) : (
            <SellPreview e={e} o={o} st={st} act={act} />
          )}
        </div>
      </section>
    );
  },
);
