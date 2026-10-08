"use client";

/**
 * Predict (BETA) event chart (design predict.js `chartBlock` / `priceChart`): chance history per
 * outcome (deterministic sample walk ending at today's price), or — for price targets and Up/Down —
 * the underlying's sample price with every target / the open as dashed lines. UI only.
 */
import { AreaChart, type ChartSeries } from "@/components/v3/ui";
import { nf } from "@/components/v3/format";
import { PX, byChance, clamp, hash, isOther, openOuts, rng, yl, type Outcome, type PredictEvent } from "@/lib/predict-sample";
import { PAL, partyCol, pc } from "./ui";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Sample "today" of the design. */
const TODAY = new Date(2026, 9, 7);
const dAgo = (n: number) => {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return `${MON[d.getMonth()]} ${d.getDate()}`;
};
const HN = 120;
const HC: Record<string, number[]> = {};
/** Chance history of one outcome (120 days, ends at today's price). */
function hist(o: Outcome) {
  const key = o.uid;
  if (HC[key]) return HC[key];
  const r = rng(hash(key));
  const end = o.res ? (o.res === "yes" ? 100 : 0) : o.y;
  const start = clamp(end + (r() - 0.5) * 44, 2, 97);
  const ws: number[] = [];
  let w = 0;
  for (let i = 0; i < HN; i++) {
    w += (r() - 0.5) * 4.2;
    ws.push(w);
  }
  const last = ws[HN - 1];
  const pts: number[] = [];
  for (let i = 0; i < HN; i++) {
    const t = i / (HN - 1);
    pts.push(+clamp(start + (end - start) * t + ws[i] - t * last, 0.5, 99.5).toFixed(1));
  }
  pts[HN - 1] = end;
  return (HC[key] = pts);
}
const PHC: Record<string, number[]> = {};
/** Underlying price since the market opened (hourly); never touches an open target. */
function priceHist(e: PredictEvent) {
  if (PHC[e.id]) return PHC[e.id];
  const r = rng(hash(`${e.id}/px`));
  const now = PX[e.asset ?? "SOL"];
  const n = e.type === "strike" ? 6 * 24 + 16 : 52;
  const lo = e.type === "strike" ? 80600 : 0;
  const hi = e.type === "strike" ? 89400 : Infinity;
  const start = e.type === "updown" ? (e.open ?? now) : now * 1.018;
  const vol = e.type === "strike" ? 0.0045 : 0.006;
  const ws: number[] = [];
  let w = 0;
  for (let i = 0; i < n; i++) {
    w += (r() - 0.5) * 2 * vol;
    ws.push(w);
  }
  const pts = ws.map((x, i) => {
    const t = i / (n - 1);
    return clamp((start + (now - start) * t) * (1 + x - t * ws[n - 1]), lo, hi);
  });
  pts[n - 1] = now;
  return (PHC[e.id] = pts);
}
/** Round y-axis ticks (1, 2, 2.5, 5 × 10^k), like Earn. */
function niceScale(lo: number, hi: number, n = 5) {
  const span = Math.max(hi - lo, 1e-9);
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw - 1e-12) ?? 10 * mag;
  const min = Math.floor(lo / step + 1e-9) * step;
  const max = Math.ceil(hi / step - 1e-9) * step;
  return { min, max, ticks: Math.max(1, Math.round((max - min) / step)), step };
}
const TGT = ["#14b8a6", "#f59e0b", "#3b82f6", "#64748b"];

function chartSeries(e: PredictEvent) {
  if (e.type === "binary") {
    const o = e.outs[0];
    return [{ name: yl(o), color: PAL[0], pts: hist(o), last: o.y }];
  }
  if (e.type === "match") return e.outs.filter((o) => !o.grp).map((o) => ({ name: o.name, color: partyCol(e, o), pts: hist(o), last: o.y }));
  return openOuts(e)
    .filter((o) => !isOther(o))
    .sort(byChance)
    .slice(0, 4)
    .map((o, i) => ({ name: o.name, color: PAL[i], pts: hist(o), last: o.y }));
}

function PriceChart({ e }: { e: PredictEvent }) {
  const pts = priceHist(e);
  const n = pts.length;
  const now = PX[e.asset ?? "SOL"];
  const big = e.asset === "BTC";
  const lines = e.type === "updown" ? [{ name: "Open", v: e.open ?? 0, color: TGT[1] }] : openOuts(e).map((o, i) => ({ name: o.name, v: o.lv ?? 0, color: TGT[i % TGT.length] }));
  const vals = pts.concat(lines.map((l) => l.v));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.03;
  const ns = niceScale(lo - pad, hi + pad, 5);
  const series: ChartSeries[] = [{ name: e.asset, color: PAL[0], pts, fill: true }, ...lines.map((l) => ({ name: l.name, color: l.color, pts: pts.map(() => l.v), fill: false, dash: true }))];
  const t0 = Date.UTC(2026, 9, e.type === "strike" ? 1 : 5, e.type === "strike" ? 0 : 12);
  const tipAt = (i: number) => {
    const d = new Date(t0 + i * 3600e3);
    return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, "0")}:00`;
  };
  const xl = (i: number) => (e.type === "strike" ? tipAt(i).split(",")[0] : tipAt(i).replace(",", ""));
  const xLabels = [xl(0), xl(Math.round((n - 1) / 3)), xl(Math.round(((n - 1) * 2) / 3)), "Now"];
  const fmt = ns.step >= 1000 ? (v: number) => `$${nf(v / 1000, ns.step % 1000 ? 1 : 0)}K` : ns.step >= 1 ? (v: number) => `$${nf(v, 0)}` : (v: number) => `$${nf(v, 2)}`;
  return (
    <div className="pd-chart">
      <div className="pd-leg num">
        <span>
          <i style={{ ["--c" as string]: PAL[0] }} />
          {e.asset}
          <b>${nf(now, big ? 0 : 2)}</b>
        </span>
        {e.type === "strike" ? (
          openOuts(e).map((o, i) => (
            <span key={o.k}>
              <i className="ln" style={{ ["--c" as string]: TGT[i % TGT.length] }} />
              {o.name}
              <b>{pc(o.y)}</b>
            </span>
          ))
        ) : (
          <span>
            <i className="ln" style={{ ["--c" as string]: TGT[1] }} />
            Open<b>${nf(e.open ?? 0, 2)}</b>
          </span>
        )}
      </div>
      <AreaChart series={series} h={200} yFmt={fmt} xLabels={xLabels} xTips={pts.map((_, i) => tipAt(i))} min={ns.min} max={ns.max} ticks={ns.ticks} fmtKey={big ? "usd0" : "usd"} />
      <p className="pd-src-note">{e.source} · since the market opened (sample)</p>
    </div>
  );
}

/** The event's chart with its 1W / 1M / ALL range buttons. */
export function EventChart({ e, range, onRange }: { e: PredictEvent; range: "1W" | "1M" | "ALL"; onRange: (r: "1W" | "1M" | "ALL") => void }) {
  if (e.type === "strike" || e.type === "updown") return <PriceChart e={e} />;
  const ser = chartSeries(e);
  const n = range === "1W" ? 8 : range === "1M" ? 31 : HN;
  const single = ser.length === 1;
  const st = (n - 1) / 3;
  const idx = [0, Math.round(st), Math.round(st * 2), n - 1];
  const xLabels = idx.map((i) => (i === n - 1 ? "Today" : dAgo(n - 1 - i)));
  const xTips = Array.from({ length: n }, (_, i) => (i === n - 1 ? "Today" : dAgo(n - 1 - i)));
  const series: ChartSeries[] = ser.map((s) => ({ name: s.name, color: s.color, pts: s.pts.slice(-n), fill: single }));
  const top = Math.max(...series.flatMap((s) => s.pts));
  const ax = top > 70 ? [100, 4] : top > 45 ? [75, 3] : top > 20 ? [50, 5] : [25, 5];
  const one = single ? niceScale(Math.max(0, Math.min(...series[0].pts) - 1), Math.min(100, Math.max(...series[0].pts) + 1), 4) : null;
  return (
    <div className="pd-chart">
      {!single && (
        <div className="pd-leg num">
          {ser.map((s) => (
            <span key={s.name}>
              <i style={{ ["--c" as string]: s.color }} />
              {s.name}
              <b>{pc(s.last)}</b>
            </span>
          ))}
        </div>
      )}
      <AreaChart
        series={series}
        h={200}
        yFmt={(v) => `${nf(v, 0)}%`}
        xLabels={xLabels}
        xTips={xTips}
        min={one ? one.min : 0}
        max={one ? one.max : ax[0]}
        ticks={one ? one.ticks : ax[1]}
        fmtKey="pct1"
      />
      <div className="pd-rng" role="group" aria-label="Chart range">
        {(["1W", "1M", "ALL"] as const).map((x) => (
          <button key={x} type="button" className={x === range ? "on" : ""} onClick={() => onRange(x)}>
            {x}
          </button>
        ))}
      </div>
    </div>
  );
}
