/**
 * Number formatting for the Perps terminal (the design prototype's helpers): typographic minus,
 * compact USD, signed percentages, price precision by magnitude.
 */
import type { LiqRoom } from "./account-model";

export const nf = (n: number, d = 0): string => {
  const v = Number(n);
  const t = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return v < 0 && /[1-9]/.test(t) ? `−${t}` : t;
};
export const usd = (n: number, d = 2) => `${n < 0 ? "−$" : "$"}${nf(Math.abs(n), d)}`;
/** $1.23M / $4.5K / $120. */
export const usdC = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${nf(a / 1e6, 2)}M` : a >= 1e3 ? `${(+(a / 1e3).toFixed(1)).toLocaleString("en-US")}K` : nf(a, 0);
  return `${n < 0 ? "−$" : "$"}${s}`;
};
export const sUsd = (n: number, d = 2) => `${n >= 0 ? "+$" : "−$"}${nf(Math.abs(n), d)}`;
export const spct = (n: number, d = 2) => `${n >= 0 ? "+" : "−"}${nf(Math.abs(n), d)}%`;
export const price = (n: number) => (n >= 10 ? nf(n, 2) : nf(n, 4));
export const levFmt = (l: number) => `${nf(Number.isFinite(l) ? l : 0, 2)}x`;
export const hfFmt = (h: number) => (Number.isFinite(h) && h < 100 ? nf(h, 2) : "No debt");
export const upDn = (v: number) => (v >= 0 ? "pos" : "neg");

/** Token size decimals per market (about one cent of precision). */
const TOKEN_DECIMALS: Record<string, number> = { BTC: 5, ETH: 4, SOL: 3, TSLA: 3, META: 3 };
export const tokAmt = (n: number, key: string) => nf(n, TOKEN_DECIMALS[key] ?? 4);

export const roomText = (r: LiqRoom) =>
  r.state === "nodebt" ? "No debt" : r.state === "now" ? "Liquidatable now" : r.state === "none" ? "None" : `${r.key} ${r.pct < 0 ? "−" : "+"}${nf(Math.abs(r.pct), 1)}%`;
const roomAll = (all: number | null) =>
  all === null ? "no move of all prices together liquidates it" : `all prices ${all < 0 ? "−" : "+"}${nf(Math.abs(all), 1)}% together`;
export const roomSub = (r: LiqRoom) =>
  r.state === "nodebt"
    ? "nothing to liquidate"
    : r.state === "now"
      ? `health factor ${hfFmt(r.hf)}, at or below 1.10`
      : r.state === "none"
        ? r.all === null
          ? "no price move liquidates it"
          : `no single price move; ${roomAll(r.all)}`
        : roomAll(r.all);
export const roomZone = (r: LiqRoom) => (r.state === "now" ? "z-danger" : r.state === "ok" && Math.abs(r.pct) < 10 ? "z-warn" : "");
