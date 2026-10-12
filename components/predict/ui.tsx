"use client";

/**
 * Predict small views and formatters: ports of the V4 design's predict.js helpers (cents format,
 * tiles, cells, key/value rows, event artwork / team logos, source badges, side tags, quick Yes/No
 * buttons, pool-balance bar). Every number comes from the real World data (`/api/predict/*`);
 * an unpriced outcome (no live World quote and no World trade yet) shows "No price" and cannot be bought.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { IC, Icon, VMark } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { nf, pct, usd } from "@/components/v3/format";
import { canTrade, isDraw, lab, mainOuts, predictHref } from "@/lib/predict/view";
import type { Cat, PredictEvent, PredictOutcome as Outcome, Side } from "@/lib/predict/types";

// ---------------------------------------------------------------------------------------------
// Formatters (design predict.js)
// ---------------------------------------------------------------------------------------------
const r1 = (c: number) => Math.round(c * 10) / 10;
const frac = (c: number) => Math.abs(r1(c) - Math.round(r1(c))) > 1e-9;
/** One cents format: "95¢", tenths only when there are tenths ("0.8¢", "99.3¢"); "No price" when unpriced. */
export const cf = (c: number | null | undefined) => (c == null ? "No price" : `${nf(r1(c), frac(c) ? 1 : 0)}¢`);
/** Both sides of a pair, same decimals. */
export const cpair = (a: number | null, b: number | null): [string, string] => {
  const d = (a != null && frac(a)) || (b != null && frac(b)) ? 1 : 0;
  return [a == null ? "No price" : `${nf(r1(a), d)}¢`, b == null ? "No price" : `${nf(r1(b), d)}¢`];
};
/** Chance: "<1%" below one percent; "N/A" when the outcome has no price. */
export const pc = (v: number | null | undefined) => (v == null ? "N/A" : `${v > 0 && v < 1 ? "<1" : nf(Math.min(100, v), 0)}%`);
/** APY: two decimals (only "up to" figures use one). */
export const p2 = (v: number) => pct(v, 2);
/** Earn's compact format ($17.45K). */
export const k2 = (n: number) => (Math.abs(n) >= 1e3 ? `$${nf(n / 1e3, 2)}K` : usd(n));
/** Shares: two decimals under 1,000. */
export const shf = (n: number) => nf(n, Math.abs(n) >= 1000 ? 0 : 2);
/** Paired share 0..1 as "69%". */
export const pp = (v: number) => `${nf(Math.round(v * 100), 0)}%`;
/** Parse a typed amount. */
export const parseAmt = (s: string) => {
  const n = parseFloat(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
/** Keep digits and one dot, two decimals at most (the design's `cleanAmt`). */
export const cleanAmt = (raw: string) => {
  let v = raw.replace(/[^0-9.]/g, "");
  const i = v.indexOf(".");
  if (i >= 0) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/\./g, "").slice(0, 2);
  return v;
};

// ---------------------------------------------------------------------------------------------
// Icons and copy
// ---------------------------------------------------------------------------------------------
const sv = (d: number, p: ReactNode) => (
  <svg width={d} height={d} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {p}
  </svg>
);
export const PIC = {
  flame: sv(14, <path d="M12 2.5c.9 3.2 4.8 5.1 4.8 10a4.8 4.8 0 0 1-9.6 0c0-2.3 1.2-3.8 2.3-4.9.3 1.5.9 2.5 2 3.1-.7-2.8-.3-5.6.5-8.2z" />),
  btc: sv(14, <path d="M8.5 6.5h5a2.6 2.6 0 0 1 0 5.2h-5zM8.5 11.7h6a2.6 2.6 0 0 1 0 5.3h-6zM8.5 6.5V17M10.5 4.5v2M10.5 17v2.3M13.5 4.5v2M13.5 17v2.3" />),
  trophy: sv(14, <path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8M10 17h4" />),
  landmark: sv(14, <path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" />),
  chart: sv(14, <path d="M4 4v16h16M7 15l4-4 3 3 5-6" />),
  grid: sv(14, <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>),
  back: sv(14, <path d="M19 12H5M11 6l-6 6 6 6" />),
  plus: sv(14, <path d="M12 5v14M5 12h14" />),
  x: sv(14, <path d="M6 6l12 12M18 6L6 18" />),
  list: sv(14, <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />),
};
export type CatKey = "trending" | Cat | "all";
export const CATS: [CatKey, string, ReactNode][] = [
  ["trending", "Trending", PIC.flame], ["crypto", "Crypto", PIC.btc], ["sports", "Sports", PIC.trophy],
  ["politics", "Politics", PIC.landmark], ["economics", "Economics", PIC.chart], ["all", "All", PIC.grid],
];
export const CATN: Record<Cat, string> = { crypto: "Crypto", sports: "Sports", politics: "Politics", economics: "Economics", other: "Culture" };
/** Chart / party colours (readable on white and on #161616). */
export const PAL = ["#703ae6", "#14b8a6", "#f59e0b", "#3b82f6"];
export const DRAW = "#6b7280";
export const INFO = {
  inPool: "Today’s value of your shares that are paired and earning in Vanna’s USDC pool. They are still Yes or No shares, worth $0 if your side loses.",
  apy: "Yearly yield on your shares in Vanna’s pool while you wait for the result. Only paired shares earn.",
  earned: "Yield so far. It is paid in extra shares of your side, so it pays out only if your side wins.",
  paired: "Your shares earn when they can be paired with the opposite side in this market’s pool. Unpaired shares wait until more of the other side arrives.",
  pays: "What these shares pay if your side wins: $1 each, extra yield shares included.",
  paysMax: "The most all your positions can pay together. Where only one outcome can win, only your best case there counts.",
  estYield: "What your paired shares earn per month at today’s USDC pool rate, paid in extra shares of your side.",
  rate: "Supply APY of Vanna’s USDC pool, live from the chain. Paired shares earn it.",
  pairs: "Each pair is one Yes and one No share from this market. Each pair is $1 lent in Vanna’s USDC pool.",
  sideApy: "Yearly yield for shares on this side at today’s pool balance.",
  slip: "What each outcome pays if it happens, for the amounts in this slip.",
  notPooled: "This market is not in Vanna’s pool yet, so shares bought here stay in your wallet and do not earn.",
  prices: "Prices are World’s live maker quotes, or the latest World trades when a market has no quote. A buy fills at the ask, a sell at the bid.",
};

// ---------------------------------------------------------------------------------------------
// Small views
// ---------------------------------------------------------------------------------------------
export const Tile = ({ k, v, cls = "", sub }: { k: ReactNode; v: ReactNode; cls?: string; sub?: ReactNode }) => (
  <div className="pd-tile">
    <p>{k}</p>
    <b className={cls}>{v}</b>
    {sub ? <small>{sub}</small> : null}
  </div>
);
export const Cell = ({ k, v, sub }: { k: ReactNode; v: ReactNode; sub?: ReactNode }) => (
  <div className="pd-cell">
    <p>{k}</p>
    <b>{v}</b>
    {sub ? <small>{sub}</small> : null}
  </div>
);
export const Kv = ({ k, v, cls = "" }: { k: ReactNode; v: ReactNode; cls?: string }) => (
  <div className="pd-kv">
    <span>{k}</span>
    <span className={cls}>{v}</span>
  </div>
);
/** Label + info tooltip. */
export const KI = ({ k, tip }: { k: ReactNode; tip: string }) => (
  <>
    {k} <Info text={tip} />
  </>
);
/** Progress meter 0..1. */
export const Meter = ({ v, cls = "" }: { v: number; cls?: string }) => (
  <span className={`pd-meter ${cls}`}>
    <i style={{ width: `${Math.max(0, Math.min(100, v * 100)).toFixed(1)}%` }} />
  </span>
);

/** World artwork URL, if any. */
// eslint-disable-next-line @next/next/no-img-element
const Img = ({ src }: { src: string }) => <img src={src} alt="" aria-hidden="true" loading="lazy" draggable={false} />;

/** Event avatar: World's artwork, else the event's short code. */
export function EvIc({ e, cls = "" }: { e: PredictEvent; cls?: string }) {
  return <span className={`pd-ic ${cls}`}>{e.image ? <Img src={e.image} /> : e.ic}</span>;
}

/** Colour of a party (draw grey, otherwise the palette by position). */
export const partyCol = (e: PredictEvent, o: Outcome) => {
  if (isDraw(o)) return DRAW;
  const ps = mainOuts(e).filter((x) => !isDraw(x));
  return PAL[Math.max(0, ps.indexOf(o)) % PAL.length];
};
/** Team logo: World's team artwork when it has one, else a coloured disc with the initial. */
export function TeamLogo({ e, o, cls = "" }: { e: PredictEvent; o: Outcome; cls?: string }) {
  const art = o.image && !/\/img\//.test(o.image) ? o.image : null;
  return (
    <span className={`pd-team ${cls} ${art ? "img" : ""}`} style={{ ["--t" as string]: partyCol(e, o) }} aria-hidden="true">
      {art ? <Img src={art} /> : isDraw(o) ? "=" : o.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
/** Two-party badge (both teams' logos). */
export function VsBadge({ e, cls = "" }: { e: PredictEvent; cls?: string }) {
  const ps = mainOuts(e).filter((o) => !isDraw(o)).slice(0, 2);
  return (
    <span className={`pd-vs ${cls}`}>
      {ps.map((o) => (
        <TeamLogo key={o.k} e={e} o={o} />
      ))}
    </span>
  );
}
/** Event logo: the two teams of a game, else the event artwork. */
export const EvLogo = ({ e, cls = "" }: { e: PredictEvent; cls?: string }) =>
  e.type === "match" && mainOuts(e).filter((o) => !isDraw(o)).length === 2 ? <VsBadge e={e} cls={cls} /> : <EvIc e={e} cls={cls} />;

/** Same text as the tag (World tags some events "Politics" in the Politics category): shown once. */
export const catDup = (e: PredictEvent) => e.tag.trim().toLowerCase() === CATN[e.cat].toLowerCase();

export function Tags({ e }: { e: PredictEvent }) {
  return (
    <div className="pd-tags">
      <span className="pd-tag">{e.tag}</span>
      {!catDup(e) && <span className="pd-cat">{CATN[e.cat]}</span>}
      {e.live && <span className="pd-live">LIVE</span>}
      {e.when && <span className="pd-when">{e.when}</span>}
    </div>
  );
}
/** Quick Yes / No buy button on a card: opens the event with that market and side selected. */
export function QBtn({ e, o, s }: { e: PredictEvent; o: Outcome; s: Side }) {
  const price = cpair(o.y, o.n)[s === "yes" ? 0 : 1];
  if (!canTrade(o))
    return (
      <button type="button" className={s === "yes" ? "pd-y" : "pd-n"} disabled aria-label={`${lab(o, s)}: no price yet`} onClick={(ev) => ev.stopPropagation()}>
        <span>{lab(o, s)}</span>
      </button>
    );
  return (
    <Link href={predictHref(e.id, o.k, s)} className={s === "yes" ? "pd-y" : "pd-n"} aria-label={`Buy ${lab(o, s)}: ${o.name}`} onClick={(ev) => ev.stopPropagation()}>
      <span>{lab(o, s)}</span>
      <span className="pd-op">{price}</span>
    </Link>
  );
}
/** "Earning x%" when the account holds the event in the pool, else "Earn up to" the pool rate (pooled markets only). */
export function EarnChip({ mine, rate }: { mine: number | null; rate: number }) {
  return (
    <span className="pd-earn">
      {IC.coins}
      {mine !== null ? `Earning ${p2(mine)}` : `Earn up to ${pct(rate, 1)}`}
    </span>
  );
}
const ChainT = () => <span className="pd-chain-t">Solana</span>;
/** Source badges: World (shares in the wallet), Vanna (in Vanna's pool), Polymarket (not integrated). */
export function SrcBadge({ src }: { src: "vanna" | "world" | "polymarket" }) {
  if (src === "world")
    return (
      <span className="pd-sb world">
        <Icon sym="WORLD" className="pd-i14" />
        World
        <ChainT />
      </span>
    );
  if (src === "polymarket")
    return (
      <span className="pd-sb poly">
        <Icon sym="POLY" className="pd-i14" />
        Polymarket<span className="pd-chain-t">Polygon</span>
      </span>
    );
  return (
    <span className="pd-sb vanna">
      <VMark size={13} />
      Vanna
      <ChainT />
    </span>
  );
}
export const SideTag = ({ s, L }: { s: Side; L: string }) => <span className={`pd-sd ${s}`}>{L.toUpperCase()}</span>;

/** Pool balance: Yes vs No shares in the pool, the paired part of each side filled. */
export function PoolBar({ o }: { o: Outcome }) {
  const y = o.pool.yes;
  const n = o.pool.no;
  const tot = y + n || 1;
  const m = Math.min(y, n);
  const empty = y + n === 0;
  return (
    <div className="pd-pb" role="img" aria-label={`Yes ${nf(y)}, No ${nf(n)}, ${nf(m)} pairs`}>
      <span className="y" style={{ width: `${empty ? 50 : ((y / tot) * 100).toFixed(2)}%` }}>
        <i style={{ width: `${(y ? (m / y) * 100 : 0).toFixed(2)}%` }} />
      </span>
      <span className="n" style={{ width: `${empty ? 50 : ((n / tot) * 100).toFixed(2)}%` }}>
        <i style={{ width: `${(n ? (m / n) * 100 : 0).toFixed(2)}%` }} />
      </span>
    </div>
  );
}
