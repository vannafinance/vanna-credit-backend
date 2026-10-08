"use client";

/**
 * Predict (BETA) — event list (design predict.js `viewList`): hero with the APY while you wait,
 * the account stats strip, the "bring your positions" prompts, category chips + search +
 * My Positions, and one card per event type. UI only: sample data from lib/predict-sample.ts.
 */
import "./predict-v3.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { IC, Icon } from "@/components/v3/icons";
import { Info, StatStrip } from "@/components/v3/ui";
import { pct, sUsd, usd, usdC } from "@/components/v3/format";
import {
  RATE, events, impLeft, impx, openOuts, byChance, posIn, pmLink, predictHref, openPredictImport,
  usePredictSample, type PredictEvent,
} from "@/lib/predict-sample";
import { CATS, INFO, PreviewNote, PredictToast, EarnChip, IcFor, VsBadge, Tags, QBtn, partyCol, pc, cf, p2, type CatKey } from "./ui";
import { ImportSheet } from "./import-sheet";

function CardFoot({ e, more = 0 }: { e: PredictEvent; more?: number }) {
  return (
    <div className="pd-c-f num">
      <span className="pd-c-l">
        <span>Last trade {e.last}</span>
        <EarnChip e={e} />
      </span>
      <span className="pd-c-m">
        {more > 0 && <span>+{more} more</span>}
        <span>Vol {usdC(e.vol)}</span>
        {(e.type === "binary" || e.type === "updown") && <span>OI {usdC(e.oi)}</span>}
      </span>
    </div>
  );
}

/** One event card; the whole card opens the event, its buttons open it with a market + side picked. */
function Card({ e }: { e: PredictEvent }) {
  const router = useRouter();
  const open = () => router.push(predictHref(e.id));
  const title = (
    <Link className="pd-c-t" href={predictHref(e.id)} onClick={(ev) => ev.stopPropagation()}>
      {e.title}
    </Link>
  );
  let body: React.ReactNode;
  if (e.type === "match") {
    const ps = e.outs.filter((o) => !o.grp);
    const tot = ps.reduce((t, o) => t + o.y, 0) || 1;
    const a = ps[0];
    const b = ps[ps.length - 1];
    const dr = ps.find((o) => o.k === "draw");
    body = (
      <>
        <div className="pd-c-top">
          <VsBadge e={e} />
          <div className="pd-c-q">
            <Tags e={e} />
            {title}
          </div>
          {e.live && (
            <div className="pd-c-p num">
              <b>{e.score}</b>
              <small>score</small>
            </div>
          )}
        </div>
        <div className="pd-ms num">
          <div className="lb">
            <span>
              {a.name} <b>{pc(a.y)}</b>
            </span>
            {dr && (
              <span>
                Draw <b>{pc(dr.y)}</b>
              </span>
            )}
            <span>
              <b>{pc(b.y)}</b> {b.name}
            </span>
          </div>
          <div className="pd-bar3">
            {ps.map((o) => (
              <i key={o.k} style={{ width: `${((o.y / tot) * 100).toFixed(1)}%`, ["--c" as string]: partyCol(e, o) }} />
            ))}
          </div>
        </div>
        <div className="pd-parts num">
          {ps.map((o) => (
            <Link key={o.k} className="pd-pt" href={predictHref(e.id, o.k, "yes")} aria-label={`Buy Yes: ${o.name}`} onClick={(ev) => ev.stopPropagation()}>
              <i style={{ ["--c" as string]: partyCol(e, o) }} />
              <span>{o.ab === "DRAW" ? "Draw" : o.ab}</span>
              <b>{cf(o.y)}</b>
            </Link>
          ))}
        </div>
        <CardFoot e={e} />
      </>
    );
  } else if (e.type === "binary" || e.type === "updown") {
    const o = e.outs[0];
    body = (
      <>
        <div className="pd-c-top">
          <IcFor e={e} />
          <div className="pd-c-q">
            <Tags e={e} />
            {title}
          </div>
          <div className="pd-c-p num">
            <b>{pc(o.y)}</b>
            <small>{e.type === "updown" ? "Up" : "chance"}</small>
          </div>
        </div>
        <div className="pd-yn num">
          <QBtn e={e} o={o} s="yes" />
          <QBtn e={e} o={o} s="no" />
        </div>
        <CardFoot e={e} />
      </>
    );
  } else {
    const rows = openOuts(e).slice().sort(byChance);
    body = (
      <>
        <div className="pd-c-top">
          <IcFor e={e} />
          <div className="pd-c-q">
            <Tags e={e} />
            {title}
          </div>
        </div>
        <div className="pd-mrows num">
          {rows.slice(0, 2).map((o) => (
            <div key={o.k} className="pd-mr">
              <span className="nm">{o.name}</span>
              <span className="pc">{pc(o.y)}</span>
              <QBtn e={e} o={o} s="yes" />
              <QBtn e={e} o={o} s="no" />
            </div>
          ))}
        </div>
        <CardFoot e={e} more={rows.length - 2} />
      </>
    );
  }
  return (
    <article className="pd-card" onClick={open}>
      {body}
    </article>
  );
}

/** The "positions in your wallet · Earn on them" / "Holding on Polymarket? Link account" prompts. */
function ImportBar() {
  const w = impLeft("wallet");
  const pm = pmLink();
  const items: React.ReactNode[] = [];
  if (w.length) {
    const v = w.reduce((t, x) => t + impx(x).value, 0);
    items.push(
      <div key="w" className="pd-ib hot">
        <span className="pd-ib-ic">
          <Icon sym="WORLD" className="pd-i24" />
        </span>
        <span className="pd-ib-t">
          <b>
            {w.length} position{w.length > 1 ? "s" : ""} in your wallet
          </b>
          <small className="num">{usd(v)} of World shares · not earning yet</small>
        </span>
        <button type="button" className="btn-v" onClick={() => openPredictImport("wallet")}>
          Earn on them
        </button>
      </div>,
    );
  }
  if (!pm)
    items.push(
      <div key="pm" className="pd-ib">
        <span className="pd-ib-ic">
          <Icon sym="POLY" className="pd-i24" />
        </span>
        <span className="pd-ib-t">
          <b>Holding on Polymarket?</b>
          <small>Link read-only, see your bets here, move them to earn</small>
        </span>
        <button type="button" className="btn-s" onClick={() => openPredictImport("polymarket")}>
          Link account
        </button>
      </div>,
    );
  else {
    const mv = impLeft("polymarket").filter((x) => x.ev);
    if (mv.length) {
      const v = mv.reduce((t, x) => t + impx(x).value, 0);
      items.push(
        <div key="pm" className="pd-ib">
          <span className="pd-ib-ic">
            <Icon sym="POLY" className="pd-i24" />
          </span>
          <span className="pd-ib-t">
            <b>
              {mv.length} Polymarket position{mv.length > 1 ? "s" : ""} can move here
            </b>
            <small className="num">{usd(v)} on Polygon · listed on Vanna</small>
          </span>
          <button type="button" className="btn-s" onClick={() => openPredictImport("polymarket")}>
            Review
          </button>
        </div>,
      );
    }
  }
  return items.length ? <section className="pd-ibar">{items}</section> : null;
}

/** The Predict list page. */
export function PredictList() {
  const api = usePredictSample();
  const [cat, setCat] = useState<CatKey>("trending");
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  const v = api.vault();
  const sm = api.summary();
  const rate = RATE();
  const EV = events();

  let list = EV.slice();
  if (mine) list = list.filter((e) => posIn(e).length > 0);
  else if (cat !== "trending" && cat !== "all") list = list.filter((e) => e.cat === cat);
  if (cat === "trending" && !mine) list.sort((a, b) => b.v24 - a.v24);
  const qq = q.trim().toLowerCase();
  if (qq) list = list.filter((e) => `${e.title} ${e.tag} ${e.outs.map((o) => o.name).join(" ")}`.toLowerCase().includes(qq));
  const head = mine ? "My Positions" : (CATS.find((c) => c[0] === cat)?.[1] ?? "");

  return (
    <div className="v3 page">
      <div className="pd-wrap">
        <section className="pd-hero">
          <div className="pd-hero-l">
            <span className="pd-hero-k">
              Vanna Predict
            </span>
            <h1>Trade the world&apos;s outcomes</h1>
            <p>Every YES or NO you buy earns while you wait: matched pairs lend in Vanna&apos;s USDC Earn pool until the market settles.</p>
          </div>
          <div className="pd-hero-r num">
            <b>{pct(rate, 1)}</b>
            <span>
              <span className="pd-hl">
                APY while you wait <Info text={INFO.rate} />
              </span>
              <small>
                up to, by side · sample rate · {usdC(v.deposited)} lent from {v.events} events
              </small>
            </span>
          </div>
        </section>

        <PreviewNote />

        <div className="pd-strip">
          <StatStrip
            n={5}
            items={[
              { icon: IC.target, label: "Predictions value", value: usd(sm.value), sub: <>{sm.count} positions · <span className={sm.pnl >= 0 ? "pos" : "neg"}>{sUsd(sm.pnl)}</span></> },
              { icon: IC.coins, label: <>In USDC vault <Info text={INFO.vault} /></>, value: usd(sm.inVault), sub: `matched shares, lent at ${p2(rate)}` },
              { icon: IC.pct, label: <>Passive yield <Info text={INFO.apy} /></>, value: `${p2(sm.apy)} APY`, sub: `+${usd(sm.perMonth)} / month` },
              { icon: IC.spark, label: <>Earned <Info text={INFO.earned} /></>, value: <span className="pos">{sUsd(sm.earned)}</span>, sub: "paid in extra shares" },
              { icon: IC.shield, label: <>Pays if right <Info text={INFO.paysMax} /></>, value: usd(sm.payout), sub: "max, if your picks win" },
            ]}
          />
        </div>

        <ImportBar />

        <div className="pd-filt">
          <div className="pd-chips" role="group" aria-label="Category">
            {CATS.map(([k, l, ic]) => (
              <button
                key={k}
                type="button"
                className={`pd-chip ${cat === k && !mine ? "on" : ""}`}
                onClick={() => {
                  setCat(k);
                  setMine(false);
                }}
              >
                {ic}
                {l}
              </button>
            ))}
          </div>
          <div className="pd-fr">
            <label className="pd-srch">
              {IC.search}
              <input placeholder="Search markets" value={q} onChange={(ev) => setQ(ev.target.value)} aria-label="Search markets" autoComplete="off" />
            </label>
            <button type="button" className={`pd-chip pd-mine ${mine ? "on" : ""}`} aria-pressed={mine} onClick={() => setMine(!mine)}>
              {IC.wallet}My Positions
            </button>
          </div>
        </div>

        <section>
          <div className="pd-sec">
            <h2>{head}</h2>
            <span className="num">
              {list.length} event{list.length === 1 ? "" : "s"}
            </span>
          </div>
          {list.length ? (
            <div className="pd-grid">
              {list.map((e) => (
                <Card key={e.id} e={e} />
              ))}
            </div>
          ) : (
            <div className="pd-empty">{mine ? "No positions yet. Buy YES or NO on any market: it starts earning right away." : "No events match your search."}</div>
          )}
        </section>
      </div>
      <ImportSheet />
      <PredictToast />
    </div>
  );
}
