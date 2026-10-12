"use client";

/**
 * Predict list (design predict.js `viewList`, V4): hero with the live USDC pool rate, the account
 * stats strip, the linked wallets bar, category chips + search + My positions, and one card per
 * World event (World groups multi-outcome questions and games into one event, so a game is one
 * card with its teams and the draw). Real data: events from GET /api/predict/events, the account
 * from GET /api/predict/positions/:owner, the rate from the USDC pool on chain.
 */
import "./predict-v3.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { IC, Icon } from "@/components/v3/icons";
import { Banner, Info, StatStrip } from "@/components/v3/ui";
import { pct, sUsd, usd, usdC } from "@/components/v3/format";
import { useWallet } from "@/hooks/use-wallet";
import { usePredictEvents } from "@/hooks/use-predict";
import { anyPooled, byChance, canTrade, isDraw, mainOuts, predictHref, type PosRow } from "@/lib/predict/view";
import type { PredictEvent } from "@/lib/predict/types";
import { CATS, INFO, EarnChip, EvIc, PIC, QBtn, Tags, TeamLogo, VsBadge, cf, p2, partyCol, pc, type CatKey } from "./ui";
import { PosTable, importOf, rowsOf, useStartEarning, usePredictAccount } from "./positions";
import { LinkedSheet, openLinkedSheet, shortAddr } from "./linked-sheet";
import { VannaLoader } from "@/components/v3/vanna-loader";

/** Value-weighted APY of the account's pooled rows in one event (null when it holds none there). */
function mineApy(rows: PosRow[], eventId: string): number | null {
  const xs = rows.filter((r) => r.eventId === eventId && r.kind === "pool");
  if (!xs.length) return null;
  const v = xs.reduce((t, r) => t + r.value, 0);
  return v ? xs.reduce((t, r) => t + r.value * r.p.apy, 0) / v : xs[0].p.apy;
}

function CardFoot({ e, more = 0, mine, rate }: { e: PredictEvent; more?: number; mine: number | null; rate: number }) {
  return (
    <div className="pd-c-f num">
      <span className="pd-c-l">
        <span>{e.last ? `Last trade ${e.last}` : "No trades yet"}</span>
        {anyPooled(e) && <EarnChip mine={mine} rate={rate} />}
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
function Card({ e, mine, rate }: { e: PredictEvent; mine: number | null; rate: number }) {
  const router = useRouter();
  const open = () => router.push(predictHref(e.id));
  const title = (
    <Link className="pd-c-t" href={predictHref(e.id)} onClick={(ev) => ev.stopPropagation()}>
      {e.title}
    </Link>
  );
  const ps = mainOuts(e);
  const teams = ps.filter((o) => !isDraw(o));
  let body: React.ReactNode;
  if (e.type === "match" && teams.length === 2) {
    const tot = ps.reduce((t, o) => t + (o.y ?? 0), 0) || 1;
    const [a, b] = teams;
    const dr = ps.find(isDraw);
    body = (
      <>
        <div className="pd-c-top">
          <VsBadge e={e} />
          <div className="pd-c-q">
            <Tags e={e} />
            {title}
          </div>
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
            {[a, ...(dr ? [dr] : []), b].map((o) => (
              <i key={o.k} style={{ width: `${(((o.y ?? 0) / tot) * 100).toFixed(1)}%`, ["--c" as string]: partyCol(e, o) }} />
            ))}
          </div>
        </div>
        <div className={`pd-parts num ${dr ? "three" : ""}`}>
          {[a, ...(dr ? [dr] : []), b].map((o) =>
            canTrade(o) ? (
              <Link key={o.k} className="pd-pt" href={predictHref(e.id, o.k, "yes")} aria-label={`Buy Yes: ${o.name}`} onClick={(ev) => ev.stopPropagation()}>
                <TeamLogo e={e} o={o} cls="xs" />
                <span>{isDraw(o) ? "Draw" : o.name}</span>
                <b>{cf(o.y)}</b>
              </Link>
            ) : (
              <button key={o.k} type="button" className="pd-pt" disabled onClick={(ev) => ev.stopPropagation()}>
                <TeamLogo e={e} o={o} cls="xs" />
                <span>{isDraw(o) ? "Draw" : o.name}</span>
                <b>{cf(null)}</b>
              </button>
            ),
          )}
        </div>
        <CardFoot e={e} mine={mine} rate={rate} />
      </>
    );
  } else if (e.outs.length === 1) {
    const o = e.outs[0];
    body = (
      <>
        <div className="pd-c-top">
          <EvIc e={e} />
          <div className="pd-c-q">
            <Tags e={e} />
            {title}
          </div>
          <div className="pd-c-p num">
            <b>{pc(o.y)}</b>
            <small>{o.yl ?? "chance"}</small>
          </div>
        </div>
        <div className="pd-yn num">
          <QBtn e={e} o={o} s="yes" />
          <QBtn e={e} o={o} s="no" />
        </div>
        <CardFoot e={e} mine={mine} rate={rate} />
      </>
    );
  } else {
    const rows = e.outs.slice().sort(byChance);
    body = (
      <>
        <div className="pd-c-top">
          <EvIc e={e} />
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
        <CardFoot e={e} more={rows.length - 2} mine={mine} rate={rate} />
      </>
    );
  }
  return (
    <article className="pd-card" onClick={open}>
      {body}
    </article>
  );
}

/** Linked wallets bar: the connected wallet, and its World positions that are not earning yet. */
function LinkedBar({ rows, idle, idleV, address, onStart, busy }: { rows: PosRow[]; idle: number; idleV: number; address: string; onStart: () => void; busy: boolean }) {
  const n = rows.filter((r) => r.kind === "wallet").length;
  return (
    <section className="pd-lb">
      <div className="pd-lb-l">
        <span className="pd-lb-k">Linked wallets</span>
        <div className="pd-wchips">
          <button type="button" className="pd-wchip" onClick={openLinkedSheet}>
            <Icon sym="SOL" className="pd-i18" />
            <span>{shortAddr(address)}</span>
            <small className="num">{n}</small>
          </button>
          <button type="button" className="pd-wchip add" disabled title="Coming soon">
            {PIC.plus}Add wallet <span className="pd-soon">Coming soon</span>
          </button>
        </div>
      </div>
      {idle > 0 ? (
        <div className="pd-lb-r">
          <span className="num">
            <b>
              {idle} World position{idle > 1 ? "s" : ""} not earning
            </b>
            <small>{usd(idleV)} in your wallet</small>
          </span>
          <button type="button" className="btn-v" disabled={busy} onClick={onStart}>
            Start earning
          </button>
        </div>
      ) : (
        <div className="pd-lb-r">
          <span className="pd-lb-ok">
            {IC.check}
            {n > 0 ? "Every World position that can earn is earning" : "No World positions waiting to earn"}
          </span>
        </div>
      )}
    </section>
  );
}

/** The Predict list page. */
export function PredictList() {
  const { data: events, isLoading, error } = usePredictEvents();
  const acct = usePredictAccount();
  const { connectWallet } = useWallet();
  const earn = useStartEarning();
  const [cat, setCat] = useState<CatKey>("trending");
  const [q, setQ] = useState("");
  const [mine, setMine] = useState(false);
  /** Cards shown (World lists a few hundred events; more load on "Show more"). */
  const [limit, setLimit] = useState(36);
  const rate = acct.rate;
  const EV = useMemo(() => events ?? [], [events]);
  const rows = useMemo(() => rowsOf(acct.data), [acct.data]);
  const evMap = useMemo(() => new Map(EV.map((e) => [e.id, e])), [EV]);

  // Hero: USDC lent from every listed pool, and how many markets it comes from (live pool balances).
  const lent = EV.reduce((t, e) => t + e.outs.reduce((s, o) => s + o.poolDetail.invested, 0), 0);
  const lentMarkets = EV.reduce((t, e) => t + e.outs.filter((o) => o.poolDetail.invested > 0).length, 0);

  const sm = acct.data?.summary;
  const idle = acct.data?.importable ?? [];
  const idleV = idle.reduce((t, x) => t + x.value, 0);

  let list = EV.slice();
  if (cat !== "trending" && cat !== "all") list = list.filter((e) => e.cat === cat);
  if (cat === "trending") list.sort((a, b) => Number(b.outs.some((o) => o.tradable)) - Number(a.outs.some((o) => o.tradable)) || b.v24 - a.v24);
  const qq = q.trim().toLowerCase();
  if (qq) list = list.filter((e) => `${e.title} ${e.tag} ${e.outs.map((o) => o.name).join(" ")}`.toLowerCase().includes(qq));
  const head = CATS.find((c) => c[0] === cat)?.[1] ?? "";

  let body: React.ReactNode;
  if (mine) {
    const tv = rows.reduce((t, r) => t + r.value, 0);
    body = !acct.connected ? (
      <>
        <div className="pd-sec">
          <h2>My positions</h2>
        </div>
        <div className="pd-empty">
          Connect a wallet to see your positions.
          <button type="button" className="btn-v" onClick={() => connectWallet()}>
            Connect wallet
          </button>
        </div>
      </>
    ) : (
      <>
        <div className="pd-sec">
          <h2>My positions</h2>
          <span className="num">
            {rows.length} position{rows.length === 1 ? "" : "s"}, {usd(tv)}
          </span>
        </div>
        <PosTable
          rows={rows}
          events={evMap}
          busy={earn.busy}
          onEarn={(r) => {
            const x = importOf(acct.data, r);
            if (x) earn.start([x]);
          }}
          empty={acct.loading ? <VannaLoader size="block" caption="Loading your positions" /> : "No positions yet. Buy Yes or No on any market."}
        />
      </>
    );
  } else if (isLoading) {
    body = (
      <div className="pd-load">
        <VannaLoader className="vl-flush" caption="Loading markets from World. The first load can take up to a minute." />
      </div>
    );
  } else if (error && !EV.length) {
    body = <div className="pd-empty">Markets could not be loaded: {(error as Error).message}</div>;
  } else {
    body = (
      <>
        <div className="pd-sec">
          <h2>{head}</h2>
          <span className="num">
            {list.length} event{list.length === 1 ? "" : "s"}
          </span>
        </div>
        {list.length ? (
          <div className="pd-grid">
            {list.slice(0, limit).map((e) => (
              <Card key={e.id} e={e} mine={mineApy(rows, e.id)} rate={rate} />
            ))}
          </div>
        ) : (
          <div className="pd-empty">No events match your search.</div>
        )}
        {list.length > limit && (
          <div className="pd-more">
            <button type="button" className="btn-o" onClick={() => setLimit(limit + 36)}>
              Show more ({list.length - limit} left)
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="v3 page">
      <div className="pd-wrap">
        {/* Same banner (theme, carousel) as Margin and Farm. The live pool rate is in the second slide. */}
        <Banner
          page="predict"
          slides={[
            ["Trade the world's outcomes", "Buy Yes or No on real events from World. Your shares earn in Vanna's USDC pool while you wait for the result."],
            [`Earn up to ${pct(rate, 1)} APY while you wait`, `${usdC(lent)} is earning in Vanna's USDC pool from ${lentMarkets} market${lentMarkets === 1 ? "" : "s"}. Paired Yes and No shares are lent out until the event resolves.`],
            ["Bet slip", "Pick several outcomes of one event and buy them all with a single wallet approval."],
          ]}
        />

        {acct.connected && (
          <div className="pd-strip">
            <StatStrip
              center
              n={5}
              items={[
                // Values only (no sub-lines under the figures, per the product request).
                { icon: IC.target, label: "Predictions value", value: usd(sm?.value ?? 0) },
                { icon: IC.coins, label: <>Earning in USDC pool <Info text={INFO.inPool} /></>, value: usd(sm?.inVault ?? 0) },
                { icon: IC.pct, label: <>Passive yield <Info text={INFO.apy} /></>, value: `${p2(sm?.apy ?? 0)} APY` },
                { icon: IC.spark, label: <>Earned <Info text={INFO.earned} /></>, value: <span className="pos">{sUsd(sm?.earned ?? 0)}</span> },
                { icon: IC.shield, label: <>Pays if right <Info text={INFO.paysMax} /></>, value: usd(sm?.payout ?? 0) },
              ]}
            />
          </div>
        )}

        {acct.connected && acct.address && (
          <LinkedBar rows={rows} idle={idle.length} idleV={idleV} address={acct.address} busy={earn.busy} onStart={() => earn.start(idle)} />
        )}

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
              {PIC.list}My positions
            </button>
          </div>
        </div>

        <section>{body}</section>
      </div>
      <LinkedSheet />
    </div>
  );
}
