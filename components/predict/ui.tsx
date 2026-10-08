"use client";

/**
 * Predict (BETA) small views and formatters — ports of the design's predict.js helpers
 * (cents format, tiles, cells, key/value rows, event badges, quick Yes/No buttons, toast).
 * UI only: every number comes from the in-memory sample in lib/predict-sample.ts.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { IC } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { nf, pct, usd } from "@/components/v3/format";
import {
  RATE, lab, posIn, pmx, yourApy, predictHref, usePredictStore,
  type Outcome, type PredictEvent, type Side, type Cat,
} from "@/lib/predict-sample";

// ---------------------------------------------------------------------------------------------
// Formatters (design predict.js)
// ---------------------------------------------------------------------------------------------
const r1 = (c: number) => Math.round(c * 10) / 10;
const frac = (c: number) => Math.abs(r1(c) - Math.round(r1(c))) > 1e-9;
/** One cents format: "95¢", tenths only when there are tenths ("0.8¢", "99.3¢"). */
export const cf = (c: number) => `${nf(r1(c), frac(c) ? 1 : 0)}¢`;
/** Both sides of a pair, same decimals. */
export const cpair = (a: number, b: number): [string, string] => {
  const d = frac(a) || frac(b) ? 1 : 0;
  return [`${nf(r1(a), d)}¢`, `${nf(r1(b), d)}¢`];
};
/** Chance: "<1%" below one percent. */
export const pc = (v: number) => `${v > 0 && v < 1 ? "<1" : nf(v, 0)}%`;
/** APY: two decimals (only "up to" figures use one). */
export const p2 = (v: number) => pct(v, 2);
/** Earn's compact format ($17.45K). */
export const k2 = (n: number) => (Math.abs(n) >= 1e3 ? `$${nf(n / 1e3, 2)}K` : usd(n));
/** Shares: two decimals under 1,000. */
export const shf = (n: number) => nf(n, Math.abs(n) >= 1000 ? 0 : 2);
/** Parse a typed amount. */
export const parseAmt = (s: string) => {
  const n = parseFloat(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
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
  link: sv(16, <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />),
};
export type CatKey = "trending" | Cat | "all";
export const CATS: [CatKey, string, ReactNode][] = [
  ["trending", "Trending", PIC.flame], ["crypto", "Crypto", PIC.btc], ["sports", "Sports", PIC.trophy],
  ["politics", "Politics", PIC.landmark], ["economics", "Economics", PIC.chart], ["all", "All", PIC.grid],
];
export const CATN: Record<Cat, string> = { crypto: "Crypto", sports: "Sports", politics: "Politics", economics: "Economics" };
/** Chart / party colours (readable on white and on #161616). */
export const PAL = ["#703ae6", "#14b8a6", "#f59e0b", "#3b82f6"];
export const DRAW = "#9ca3af";
export const INFO = {
  vault: "Today’s value of your shares that are paired with the other side and lent as USDC in the Earn pool (still shares: worth $0 if your side loses).",
  apy: "Yearly yield on your shares while you wait: the smaller side of a market earns the full USDC Earn rate, the larger side only on its matched part.",
  earned: "Yield received so far, paid as extra shares of your side and worth $0 if that side loses.",
  matched: "The part of your shares paired with the other side: only this part is lent and earns.",
  free: "USDC in the Earn pool that is not lent out right now, which a sell can withdraw at once.",
  pays: "What these shares pay if your side wins: $1 each, yield shares included.",
  paysMax: "The most all your positions can pay together, counting only your best case where just one outcome can win.",
  split: "A sell first uses this market’s unmatched shares, then withdraws $1 of USDC per remaining share from the Earn pool and turns it back into your side.",
  newUsd: "New USDC this buy adds to the Earn pool, $1 per new Yes+No pair; buying the larger side adds none.",
  estYield: "What your matched shares earn per month at the USDC Earn rate, paid in extra shares of your side.",
  small: "The side with fewer shares in the vault is fully matched, so it earns the full USDC Earn rate.",
  buyStep: "Your USDC buys the shares on World at the best prices in the order book.",
  vaultStep: "The shares go into Vanna’s yield vault, where matched Yes+No pairs are merged into USDC.",
  lent: "USDC lent in the Earn pool from this event’s matched Yes+No pairs, $1 per pair.",
  gap: "How much more a share costs on Vanna than it sells for on Polymarket.",
  moveCost: "How many fewer shares you hold after the move, and what they are worth today.",
  slip: "How far each fill is from the best price; the move sets a limit just above this and reverts if prices move further.",
  rate: "The USDC Earn pool’s supply APY (a sample rate), which the smaller side of each market earns in full.",
  unlisted: "This market is not listed on Vanna, so it stays on Polymarket.",
  sideApy: "Yearly yield for this side of the market at today’s vault balance.",
};

/** "Preview — sample data, no transactions" note shown wherever an action happens. */
export function PreviewNote({ className = "" }: { className?: string }) {
  return (
    <p className={`pd-prevnote ${className}`}>
      {IC.warn}
      <span>
        <b>Preview</b> — sample data, no transactions. Actions only change this page until you reload.
      </span>
    </p>
  );
}

/** The page toast (sample-state confirmations). */
export function PredictToast() {
  const msg = usePredictStore((s) => s.toast);
  if (!msg) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      {msg}
    </div>
  );
}

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

/** Event (or party) avatar: the event's short code, or a team's abbreviation. */
export function IcFor({ e, o, cls = "" }: { e: PredictEvent; o?: Outcome | null; cls?: string }) {
  const t = e.type === "match" && o && o.ab ? (o.ab === "DRAW" ? "X" : o.ab) : e.ic;
  return <span className={`pd-ic ${cls}`}>{t}</span>;
}
/** Two-party badge (both teams' avatars). */
export function VsBadge({ e, cls = "" }: { e: PredictEvent; cls?: string }) {
  return (
    <span className={`pd-vs ${cls}`}>
      {e.outs
        .filter((o) => !o.grp && o.k !== "draw")
        .map((o) => (
          <span key={o.k} className="pd-ic">
            {o.ab}
          </span>
        ))}
    </span>
  );
}
export function Tags({ e }: { e: PredictEvent }) {
  return (
    <div className="pd-tags">
      <span className="pd-tag">{e.tag}</span>
      <span className="pd-cat">{CATN[e.cat]}</span>
      {e.live && <span className="pd-live">LIVE</span>}
      {e.when && <span className="pd-when">{e.when}</span>}
    </div>
  );
}
/** Quick Yes / No buy button on a card: opens the event with that market and side selected. */
export function QBtn({ e, o, s }: { e: PredictEvent; o: Outcome; s: Side }) {
  return (
    <Link
      href={predictHref(e.id, o.k, s)}
      className={s === "yes" ? "pd-y" : "pd-n"}
      aria-label={`Buy ${lab(o, s)}: ${o.name}`}
      onClick={(ev) => ev.stopPropagation()}
    >
      <span>{lab(o, s)}</span>
      <span className="pd-op">{cpair(o.y, o.n)[s === "yes" ? 0 : 1]}</span>
    </Link>
  );
}
/** "Earning x%" when the account holds the event, else "Earn up to" the Earn rate. */
export function EarnChip({ e }: { e: PredictEvent }) {
  const mine = posIn(e).map(pmx);
  return (
    <span className="pd-earn">
      {IC.coins}
      {mine.length ? `Earning ${p2(yourApy(mine))}` : `Earn up to ${pct(RATE(), 1)}`}
    </span>
  );
}
/** Colour of a party in a match (draw grey; the last of 3 parties teal). */
export const partyCol = (e: PredictEvent, o: Outcome) => {
  const ps = e.outs.filter((x) => !x.grp);
  const i = ps.indexOf(o);
  return o.k === "draw" ? DRAW : PAL[i === ps.length - 1 && ps.length > 2 ? 1 : Math.max(0, i)];
};
