"use client";

/**
 * Small SVG line / bar chart for the basis-vault pages (APY vs borrow, share price, funding,
 * position value). Measures its own width, draws nice y-axis steps and dated x labels, and reports
 * the hovered index through `onHover` so the card can show a readout line.
 */
import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/contexts/theme-context";
import { seriesLabel } from "@/lib/farm/basis-vaults";

interface BasisChartProps {
  data: number[];
  /** Series index of data[0] (for the date labels). */
  start: number;
  kind?: "line" | "bar";
  /** Dashed horizontal reference line (e.g. the borrow APY). */
  reference?: number;
  /** Keep 0 inside the y range. */
  includeZero?: boolean;
  formatAxis: (value: number, step: number) => string;
  onHover?: (index: number | null) => void;
  height?: number;
  ariaLabel: string;
}

const PAD = { l: 52, r: 10, t: 10, b: 24 };

function niceStep(span: number): number {
  const raw = span / 5 || 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

export function BasisChart({ data, start, kind = "line", reference, includeZero, formatAxis, onHover, height = 220, ariaLabel }: BasisChartProps) {
  const { isDark } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(260, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = data.length;
  const W = width;
  const H = height;
  const colors = {
    grid: isDark ? "#222222" : "#EFEFF3",
    zero: isDark ? "#333333" : "#E2E2E2",
    axis: isDark ? "#777777" : "#9CA3AF",
    ref: isDark ? "#888888" : "#777777",
    card: isDark ? "#1A1A1A" : "#FFFFFF",
    pos: isDark ? "#3FC0A3" : "#0B7A63",
    neg: isDark ? "#F0666E" : "#FC5457",
  };

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
    const i =
      kind === "bar"
        ? Math.floor((px - PAD.l) / barW)
        : Math.round((px - PAD.l) / (innerW / Math.max(1, n - 1)));
    const clamped = Math.max(0, Math.min(n - 1, i));
    setHover(clamped);
    onHover?.(clamped);
  };
  const leave = () => {
    setHover(null);
    onHover?.(null);
  };
  const gradId = `basis-area-${kind}`;

  return (
    <div ref={ref} className="w-full" style={{ height }} role="img" aria-label={ariaLabel}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none" className="block overflow-visible">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#703AE6" stopOpacity={0.22} />
            <stop offset="1" stopColor="#703AE6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <g fontSize={11} fill={colors.axis}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke={Math.abs(t) < step / 1000 ? colors.zero : colors.grid} />
              <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end">
                {formatAxis(t, step)}
              </text>
            </g>
          ))}
          {xLabels.map((i, j) => (
            <text key={`${i}-${j}`} x={x(i)} y={H - 6} textAnchor={j === 0 ? "start" : j === labelCount - 1 ? "end" : "middle"}>
              {seriesLabel(start + i)}
            </text>
          ))}
        </g>
        {kind === "bar" ? (
          data.map((d, i) => (
            <rect
              key={i}
              x={PAD.l + i * barW + barW * 0.15}
              width={Math.max(1, barW * 0.7)}
              y={Math.min(y(d), y(0))}
              height={Math.max(1, Math.abs(y(d) - y(0)))}
              rx={Math.min(2, barW * 0.2)}
              fill={d >= 0 ? colors.pos : colors.neg}
              opacity={hover === null || hover === i ? 1 : 0.55}
            />
          ))
        ) : (
          <>
            <path d={`M${pts[0]} L${pts.join(" L")} L${x(n - 1)},${base} L${x(0)},${base}Z`} fill={`url(#${gradId})`} />
            {reference !== undefined && (
              <line x1={PAD.l} x2={W - PAD.r} y1={y(reference)} y2={y(reference)} stroke={colors.ref} strokeDasharray="5 4" strokeWidth={1.5} />
            )}
            <polyline points={pts.join(" ")} fill="none" stroke="#703AE6" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(n - 1)} cy={y(data[n - 1])} r={3.5} fill="#703AE6" />
          </>
        )}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke={colors.zero} />
            {kind === "line" && <circle cx={x(hover)} cy={y(data[hover])} r={4} fill={colors.card} stroke="#703AE6" strokeWidth={2} />}
          </g>
        )}
        <rect x={PAD.l} y={0} width={innerW} height={H} fill="transparent" onPointerMove={move} onPointerLeave={leave} />
      </svg>
    </div>
  );
}

/** Range chips (1 Week / 1 Month / 3 Months / All Time) used above every basis chart. */
export function RangeChips({ value, options, onChange }: { value: number; options: [number, string][]; onChange: (days: number) => void }) {
  const { isDark } = useTheme();
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map(([days, label]) => (
        <button
          key={days}
          type="button"
          onClick={() => onChange(days)}
          className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border whitespace-nowrap cursor-pointer transition-colors ${
            value === days
              ? "bg-[#703AE6] border-[#703AE6] text-white"
              : isDark
                ? "bg-[#2A2A2A] border-[#333333] text-[#A7A7A7]"
                : "bg-[#F0F0F0] border-[#E2E2E2] text-[#888888]"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
