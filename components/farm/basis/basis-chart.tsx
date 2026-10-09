"use client";

/**
 * Small SVG line / bar chart for the Farm vault pages (APY vs borrow, share price, funding) — the
 * design's farm.js `lineChart` / `barChart`, styled by `.fm-chart` (farm-v3.css). Measures its own
 * width, draws nice y-axis steps and dated x labels, and reports the hovered index through
 * `onHover` so the card can show a readout line. With fewer than two points it draws nothing and
 * shows `empty` instead (a real series is never padded).
 */
import { useEffect, useId, useRef, useState } from "react";

/** "Oct 9" (UTC) for a series timestamp. */
export const dayLabel = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

interface BasisChartProps {
  data: number[];
  /** Unix ms of each point (for the date labels). */
  dates: number[];
  /** Shown instead of the chart when there are fewer than two points. */
  empty?: string;
  kind?: "line" | "bar";
  /** Dashed horizontal reference line (e.g. the borrow APY). */
  reference?: number;
  /** Keep 0 inside the y range. */
  includeZero?: boolean;
  formatAxis: (value: number, step: number) => string;
  onHover?: (index: number | null) => void;
  /** `.fm-chart.sm` (200px) instead of 220px. */
  small?: boolean;
  ariaLabel: string;
}

const PAD = { l: 52, r: 10, t: 10, b: 24 };

function niceStep(span: number): number {
  const raw = span / 5 || 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

export function BasisChart({ data, dates, empty, kind = "line", reference, includeZero, formatAxis, onHover, small, ariaLabel }: BasisChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const gid = useId().replace(/:/g, "");
  const [size, setSize] = useState({ w: 600, h: small ? 200 : 220 });
  const [hover, setHover] = useState<number | null>(null);
  const drawn = data.length >= 2;

  // Re-attach when the chart replaces the empty state (a different element).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ w: Math.max(260, entry.contentRect.width), h: entry.contentRect.height || (small ? 200 : 220) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [small, drawn]);

  const n = data.length;
  if (n < 2)
    return (
      <div ref={ref} className={`fm-chart fm-chart-e ${small ? "sm" : ""}`} role="img" aria-label={ariaLabel}>
        <span>{empty ?? "Not enough history yet"}</span>
      </div>
    );
  const W = size.w;
  const H = size.h;

  // y range
  let lo: number;
  let hi: number;
  if (kind === "bar") {
    lo = Math.min(0, ...data);
    hi = Math.max(...data) * 1.08;
  } else {
    const lo0 = Math.min(...data, reference ?? Infinity, includeZero ? 0 : Infinity);
    const hi0 = Math.max(...data, reference ?? -Infinity);
    const pad = (hi0 - lo0) * 0.12 || Math.abs(hi0) * 0.01 || 1;
    lo = includeZero ? lo0 : lo0 - pad;
    hi = hi0 + pad;
  }
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (hi === lo) hi = lo + step;
  const y = (v: number) => PAD.t + ((hi - v) / (hi - lo)) * (H - PAD.t - PAD.b);
  const innerW = W - PAD.l - PAD.r;
  const barW = innerW / Math.max(1, n);
  const x = (i: number) => (kind === "bar" ? PAD.l + (i + 0.5) * barW : PAD.l + (i * innerW) / Math.max(1, n - 1));

  const ticks: number[] = [];
  for (let k = 0, t = lo; t <= hi + step / 1000 && k < 40; k++, t = lo + k * step) ticks.push(t);
  const labelCount = Math.min(5, n);
  const xLabels = [...Array(labelCount).keys()].map((j) => Math.round((j * (n - 1)) / Math.max(1, labelCount - 1)));
  const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d).toFixed(1)}`);
  const base = H - PAD.b;

  const move = (e: React.PointerEvent<SVGRectElement>) => {
    const b = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((e.clientX - b.left) * W) / b.width;
    const i = kind === "bar" ? Math.floor((px - PAD.l) / barW) : Math.round((px - PAD.l) / (innerW / Math.max(1, n - 1)));
    const clamped = Math.max(0, Math.min(n - 1, i));
    setHover(clamped);
    onHover?.(clamped);
  };
  const leave = () => {
    setHover(null);
    onHover?.(null);
  };

  return (
    <div ref={ref} className={`fm-chart ${small ? "sm" : ""}`} role="img" aria-label={ariaLabel}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#703ae6" stopOpacity={0.22} />
            <stop offset="1" stopColor="#703ae6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <g className="ax">
          {ticks.map((t) => (
            <g key={t}>
              <line className={Math.abs(t) < step / 1000 ? "zero" : "gl"} x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
              <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end">
                {formatAxis(t, step)}
              </text>
            </g>
          ))}
          {xLabels.map((i, j) => (
            <text key={`${i}-${j}`} x={x(i)} y={H - 6} textAnchor={j === 0 ? "start" : j === labelCount - 1 ? "end" : "middle"}>
              {dayLabel(dates[i])}
            </text>
          ))}
        </g>
        {kind === "bar" ? (
          data.map((d, i) => (
            <rect
              key={i}
              className={d >= 0 ? "bp" : "bn"}
              x={PAD.l + i * barW + barW * 0.15}
              width={Math.max(1, barW * 0.7)}
              y={Math.min(y(d), y(0))}
              height={Math.max(1, Math.abs(y(d) - y(0)))}
              rx={Math.min(2, barW * 0.2)}
              opacity={hover === null || hover === i ? 1 : 0.55}
            />
          ))
        ) : (
          <>
            <path fill={`url(#${gid})`} d={`M${pts[0]} L${pts.join(" L")} L${x(n - 1)},${base} L${x(0)},${base}Z`} />
            {reference !== undefined && <line className="ref" x1={PAD.l} x2={W - PAD.r} y1={y(reference)} y2={y(reference)} />}
            <polyline className="ln" points={pts.join(" ")} />
            <circle className="end" cx={x(n - 1)} cy={y(data[n - 1])} r={3.5} />
          </>
        )}
        {hover !== null && (
          <g>
            <line className="hv" x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} />
            {kind === "line" && <circle className="dot" cx={x(hover)} cy={y(data[hover])} r={4} />}
          </g>
        )}
        <rect x={PAD.l} y={0} width={Math.max(1, innerW)} height={H} fill="transparent" onPointerMove={move} onPointerLeave={leave} />
      </svg>
    </div>
  );
}
