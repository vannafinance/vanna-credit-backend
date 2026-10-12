"use client";

/**
 * The terminal's price chart (the design's SVG chart): Phoenix candles for the market and timeframe,
 * the last price tag, your positions' entry and liquidation lines, and a crosshair that drives the
 * OHLC legend. Redraws on new candles, on resize and on theme changes (colours come from CSS).
 */
import { useEffect, useRef } from "react";
import { nf } from "./format";
import type { Candle, PhoenixTimeframe } from "./use-phoenix-live";
import { PHOENIX_TIMEFRAMES } from "./use-phoenix-live";
import { Img, SearchIcon, SideIcon, marketIcon } from "./ui";
import { VannaLoader } from "@/components/v3/vanna-loader";

export interface ChartLine {
  v: number;
  cls: "ent" | "liq";
  t: string;
}

const TF_LABEL: Record<PhoenixTimeframe, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
const NAMES: Record<string, string> = { SOL: "Solana", ETH: "Ethereum", BTC: "Bitcoin", TSLA: "Tesla", META: "Meta" };

function niceStep(span: number, n: number) {
  const raw = span / (n || 7) || 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

function draw(host: HTMLDivElement, ohlcEl: HTMLDivElement, data: Candle[], tf: PhoenixTimeframe, lines: ChartLine[]) {
  const W = Math.max(280, host.clientWidth);
  const H = Math.max(200, host.clientHeight);
  if (data.length === 0) {
    // No candles yet: clear the drawing; the component overlays the branded VannaLoader meanwhile.
    host.innerHTML = "";
    ohlcEl.innerHTML = "";
    return;
  }
  const P = { l: 4, r: 76, t: 58, b: 28 };
  let lo = Math.min(...data.map((d) => d.l));
  let hi = Math.max(...data.map((d) => d.h));
  lines.forEach((L) => {
    if (L.v > lo * 0.85 && L.v < hi * 1.15) {
      lo = Math.min(lo, L.v);
      hi = Math.max(hi, L.v);
    }
  });
  const pad = (hi - lo) * 0.05 || hi * 0.01;
  const st = niceStep(hi - lo + 2 * pad, Math.max(4, Math.round((H - P.t - P.b) / 60)));
  const y0 = Math.floor((lo - pad) / st) * st;
  const y1 = Math.ceil((hi + pad) / st) * st;
  const y = (v: number) => P.t + ((y1 - v) / (y1 - y0)) * (H - P.t - P.b);
  const n = data.length;
  const bw = (W - P.l - P.r) / n;
  const x = (i: number) => P.l + (i + 0.5) * bw;
  const last = data[n - 1];
  const dec = last.c >= 10 ? 2 : 4;
  const fy = (v: number) => nf(v, dec);

  // Axis tags: the last price keeps its place; position tags are pushed apart so none overlap.
  const vis = lines.filter((L) => y(L.v) > P.t - 4 && y(L.v) < H - P.b).map((L) => ({ ...L, ty: 0 }));
  const placed = [y(last.c)];
  vis
    .sort((a, b) => Math.abs(y(a.v) - y(last.c)) - Math.abs(y(b.v) - y(last.c)))
    .forEach((L) => {
      let ty = y(L.v);
      const dir = ty >= y(last.c) ? 1 : -1;
      while (placed.some((q) => Math.abs(q - ty) < 19)) ty += dir * 2;
      L.ty = ty;
      placed.push(ty);
    });

  let g = "";
  for (let k = 0, v = y0; v <= y1 + st / 1000 && k < 40; k++, v = y0 + k * st) {
    if (y(v) < P.t - 1) continue;
    const free = placed.every((ty) => Math.abs(ty - y(v)) > 17) && y(v) < H - P.b - 6;
    g += `<line class="gl" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/>${free ? `<text x="${W - P.r + 8}" y="${y(v) + 4}">${fy(v)}</text>` : ""}`;
  }
  const fmtT = (t: number) => {
    const d = new Date(t);
    const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const hm = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return tf === "1d" ? day : tf === "4h" ? `${day} ${hm}` : hm;
  };
  const nx = Math.max(3, Math.min(7, Math.floor((W - P.r) / 130)));
  for (let j = 0; j < nx; j++) {
    const i = Math.round(((j + 0.5) * (n - 1)) / nx);
    g += `<line class="gl" x1="${x(i)}" x2="${x(i)}" y1="${P.t - 50}" y2="${H - P.b}"/><text x="${x(i)}" y="${H - 9}" text-anchor="middle">${fmtT(data[i].t)}</text>`;
  }
  const cs = data
    .map((d, i) => {
      const cls = d.c >= d.o ? "up" : "dn";
      const top = y(Math.max(d.o, d.c));
      const h = Math.max(1, Math.abs(y(d.o) - y(d.c)));
      return `<line class="${cls}" x1="${x(i)}" x2="${x(i)}" y1="${y(d.h)}" y2="${y(d.l)}"/><rect class="${cls}" x="${x(i) - bw * 0.34}" y="${top}" width="${Math.max(1, bw * 0.68)}" height="${h}"/>`;
    })
    .join("");
  const tag = (v: number, cls: string, ty: number) =>
    `<g class="tg ${cls}"><rect x="${W - P.r + 1}" y="${ty - 9}" width="${P.r - 2}" height="18" rx="3"/><text x="${W - P.r + 7}" y="${ty + 4}">${fy(v)}</text></g>`;
  let pl = "";
  vis.forEach((L) => {
    pl += `<line class="pl ${L.cls}" x1="${P.l}" x2="${W - P.r}" y1="${y(L.v)}" y2="${y(L.v)}"/><text class="pl-t ${L.cls}" x="${P.l + 8}" y="${y(L.v) + (L.ty > y(L.v) ? 14 : -5)}">${L.t} ${fy(L.v)}</text>${tag(L.v, L.cls, L.ty)}`;
  });
  const lcls = last.c >= last.o ? "up" : "dn";
  const ly = y(last.c);
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><g class="ax">${g}</g>${cs}${pl}
    <line class="last ${lcls}" x1="${P.l}" x2="${W - P.r}" y1="${ly}" y2="${ly}"/>${tag(last.c, `lt ${lcls}`, ly)}
    <g class="xh" style="display:none"><line class="xv" y1="${P.t - 50}" y2="${H - P.b}"/><line class="xhl" x1="${P.l}" x2="${W - P.r}"/><g class="tg xt"><rect x="${W - P.r + 1}" width="${P.r - 2}" height="18" rx="3"/><text x="${W - P.r + 7}"></text></g></g>
    <rect class="hit" x="0" y="0" width="${W - P.r}" height="${H - P.b}" fill="transparent"/></svg>`;

  const ohlc = (i: number) => {
    const d = data[i];
    const ch = d.c - d.o;
    const c = ch >= 0 ? "px-cu" : "px-cdn";
    ohlcEl.innerHTML = `<span>O<b class="${c}">${fy(d.o)}</b></span><span>H<b class="${c}">${fy(d.h)}</b></span><span>L<b class="${c}">${fy(d.l)}</b></span><span>C<b class="${c}">${fy(d.c)}</b></span><b class="${c}">${ch >= 0 ? "+" : "−"}${fy(Math.abs(ch))} (${ch >= 0 ? "+" : "−"}${nf(Math.abs((ch / d.o) * 100), 2)}%)</b>`;
  };
  ohlc(n - 1);
  const svg = host.querySelector("svg")!;
  const hit = svg.querySelector(".hit")!;
  const xh = svg.querySelector(".xh") as SVGGElement;
  hit.addEventListener("pointermove", (e) => {
    const ev = e as PointerEvent;
    const b = svg.getBoundingClientRect();
    const px = ev.clientX - b.left;
    const py = ev.clientY - b.top;
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - P.l) / bw)));
    xh.style.display = "";
    const v = y1 - ((py - P.t) / (H - P.t - P.b)) * (y1 - y0);
    const xv = xh.querySelector(".xv")!;
    xv.setAttribute("x1", String(x(i)));
    xv.setAttribute("x2", String(x(i)));
    const xhl = xh.querySelector(".xhl")!;
    xhl.setAttribute("y1", String(py));
    xhl.setAttribute("y2", String(py));
    xh.querySelector("rect")!.setAttribute("y", String(py - 9));
    const tt = xh.querySelector("text")!;
    tt.setAttribute("y", String(py + 4));
    tt.textContent = fy(v);
    ohlc(i);
  });
  hit.addEventListener("pointerleave", () => {
    xh.style.display = "none";
    ohlc(n - 1);
  });
}

export function PriceChart({
  marketKey,
  tf,
  onTf,
  candles,
  lines,
  bookOpen,
  onShowBook,
}: {
  marketKey: string;
  tf: PhoenixTimeframe;
  onTf: (tf: PhoenixTimeframe) => void;
  candles: Candle[];
  lines: ChartLine[];
  bookOpen: boolean;
  onShowBook: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const ohlc = useRef<HTMLDivElement>(null);
  const linesKey = lines.map((l) => `${l.cls}:${l.v.toFixed(4)}:${l.t}`).join("|");

  useEffect(() => {
    const h = host.current;
    const o = ohlc.current;
    if (!h || !o) return;
    const redraw = () => draw(h, o, candles, tf, lines);
    redraw();
    const ro = new ResizeObserver(redraw);
    ro.observe(h);
    return () => ro.disconnect();
    // lines are keyed by value (a new array each render must not redraw needlessly)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, tf, linesKey]);

  return (
    <section className="px-chart" aria-label={`${marketKey} price chart`}>
      <div className="px-ch-bar">
        <span className="px-ch-sym">
          <SearchIcon />
          {marketKey}USD
        </span>
        <span className="px-ch-sep" />
        <div className="px-tfs" role="tablist" aria-label="Timeframe">
          {PHOENIX_TIMEFRAMES.map((t) => (
            <button key={t} type="button" className={tf === t ? "on" : ""} role="tab" aria-selected={tf === t} onClick={() => onTf(t)}>
              {TF_LABEL[t]}
            </button>
          ))}
        </div>
        {!bookOpen && (
          <button type="button" className="px-bk-show" aria-pressed="false" onClick={onShowBook}>
            <SideIcon />
            Order book
          </button>
        )}
      </div>
      <div className="px-cbox">
        <div className="px-lgd num">
          <div className="px-lgd-t">
            <Img src={marketIcon(marketKey)} className="px-lgd-ic" />
            <span>
              {NAMES[marketKey] ?? marketKey} / U.S. Dollar · {TF_LABEL[tf]} · Phoenix
            </span>
            <i className="px-dot" />
          </div>
          <div className="px-ohlc" ref={ohlc} />
        </div>
        <div className="px-svg" ref={host} />
        {candles.length === 0 && <VannaLoader className="vl-cover" caption="Loading Phoenix candles" />}
      </div>
    </section>
  );
}
