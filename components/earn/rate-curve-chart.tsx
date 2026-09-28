'use client';

/**
 * Interest-rate curve for one lending pool: borrow APY and supply APY as a function of
 * utilization, evaluated with the program's own rate math (`annualBorrowRate` /
 * `annualSupplyRate` from lib/solana/math.ts) on the reserve's on-chain rate-curve
 * coefficients and reserve factor. This is real data — the exact curve the program accrues
 * with — not a history. A marker shows the pool's current utilization.
 *
 * Inline SVG, one y-axis (APY %), crosshair + tooltip on hover, legend + direct labels so
 * identity is never color-alone. Colors validated with the dataviz palette validator
 * (light: #703AE6 / #12A594, dark: #8B5CF6 / #169C82).
 */
import { useMemo, useRef, useState } from "react";
import { useTheme } from "@/contexts/theme-context";
import { annualBorrowRate, annualSupplyRate, WAD, type RateCurve } from "@/lib/solana/math";

interface RateCurveChartProps {
  curve: RateCurve;
  reserveFactorBps: bigint;
  /** Current utilization (fraction 0..1). */
  utilization: number;
  height?: number;
}

const STEPS = 100;
const PAD = { top: 16, right: 20, bottom: 32, left: 48 };

/** Utilization fraction → WAD bigint (1e-6 precision is plenty for plotting). */
const utilWad = (u: number): bigint => (BigInt(Math.round(Math.min(Math.max(u, 0), 1) * 1_000_000)) * WAD) / 1_000_000n;

export const RateCurveChart = ({ curve, reserveFactorBps, utilization, height = 300 }: RateCurveChartProps) => {
  const { isDark } = useTheme();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;

  const colors = isDark
    ? { borrow: "#8B5CF6", supply: "#169C82", grid: "rgba(226,226,226,0.1)", text: "#A7A7A7", ink: "#FFFFFF", surface: "#1A1A1A" }
    : { borrow: "#703AE6", supply: "#12A594", grid: "rgba(0,0,0,0.08)", text: "#777777", ink: "#111111", surface: "#FFFFFF" };

  const points = useMemo(
    () =>
      Array.from({ length: STEPS + 1 }, (_, i) => {
        const u = i / STEPS;
        const w = utilWad(u);
        return { u, borrow: annualBorrowRate(curve, w) * 100, supply: annualSupplyRate(curve, w, reserveFactorBps) * 100 };
      }),
    [curve, reserveFactorBps],
  );
  const current = useMemo(() => {
    const w = utilWad(utilization);
    return { u: utilization, borrow: annualBorrowRate(curve, w) * 100, supply: annualSupplyRate(curve, w, reserveFactorBps) * 100 };
  }, [curve, reserveFactorBps, utilization]);

  const yMax = Math.max(1, ...points.map((p) => p.borrow)) * 1.08;
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const x = (u: number) => PAD.left + u * innerW;
  const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
  const path = (key: "borrow" | "supply") => points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.u).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const yTicks = Array.from({ length: 5 }, (_, i) => (yMax / 4) * i);
  const hovered = hover === null ? null : points[hover];

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(u * STEPS));
  };

  const last = points[points.length - 1];

  return (
    <div ref={wrapRef} className="relative w-full">
      {/* Legend */}
      <div className="flex items-center gap-4 pb-2 text-[12px] font-medium" style={{ color: colors.text }}>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-[2px] rounded" style={{ background: colors.borrow }} />Borrow APY</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-[2px] rounded" style={{ background: colors.supply }} />Supply APY</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full border-2" style={{ borderColor: colors.ink }} />Current utilization</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label="Borrow and supply APY versus utilization">
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={colors.grid} strokeWidth={1} />
            <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill={colors.text}>{t.toFixed(t >= 10 ? 0 : 1)}%</text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((u) => (
          <text key={u} x={x(u)} y={height - 10} textAnchor="middle" fontSize={11} fill={colors.text}>{Math.round(u * 100)}%</text>
        ))}
        <text x={width - PAD.right} y={height - 22} textAnchor="end" fontSize={10} fill={colors.text}>Utilization</text>

        <path d={path("borrow")} fill="none" stroke={colors.borrow} strokeWidth={2} strokeLinejoin="round" />
        <path d={path("supply")} fill="none" stroke={colors.supply} strokeWidth={2} strokeLinejoin="round" />

        {/* Direct labels at the line ends */}
        <text x={x(1) - 4} y={y(last.borrow) - 6} textAnchor="end" fontSize={11} fontWeight={600} fill={colors.ink}>Borrow</text>
        <text x={x(1) - 4} y={Math.min(y(last.supply) - 6, y(last.borrow) + 16)} textAnchor="end" fontSize={11} fontWeight={600} fill={colors.ink}>Supply</text>

        {/* Current utilization marker */}
        <line x1={x(current.u)} x2={x(current.u)} y1={PAD.top} y2={PAD.top + innerH} stroke={colors.text} strokeDasharray="3 3" strokeWidth={1} />
        <circle cx={x(current.u)} cy={y(current.borrow)} r={5} fill={colors.borrow} stroke={colors.surface} strokeWidth={2} />
        <circle cx={x(current.u)} cy={y(current.supply)} r={5} fill={colors.supply} stroke={colors.surface} strokeWidth={2} />

        {hovered && (
          <g pointerEvents="none">
            <line x1={x(hovered.u)} x2={x(hovered.u)} y1={PAD.top} y2={PAD.top + innerH} stroke={colors.ink} strokeOpacity={0.3} strokeWidth={1} />
            <circle cx={x(hovered.u)} cy={y(hovered.borrow)} r={4} fill={colors.borrow} stroke={colors.surface} strokeWidth={2} />
            <circle cx={x(hovered.u)} cy={y(hovered.supply)} r={4} fill={colors.supply} stroke={colors.surface} strokeWidth={2} />
          </g>
        )}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={innerW}
          height={innerH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      {hovered && (
        <div
          className={`absolute pointer-events-none rounded-lg border px-3 py-2 text-[12px] font-medium shadow-md ${
            isDark ? "bg-[#222222] border-[#333333] text-white" : "bg-white border-[#E8E8E8] text-[#111111]"
          }`}
          style={{ left: `${Math.min(75, Math.max(5, (x(hovered.u) / width) * 100))}%`, top: 28 }}
        >
          <div className="font-semibold">Utilization {(hovered.u * 100).toFixed(0)}%</div>
          <div>Borrow APY {hovered.borrow.toFixed(2)}%</div>
          <div>Supply APY {hovered.supply.toFixed(2)}%</div>
        </div>
      )}
      <p className="pt-1 text-[12px] font-medium" style={{ color: colors.text }}>
        Now: {(current.u * 100).toFixed(2)}% utilized · Borrow {current.borrow.toFixed(2)}% · Supply {current.supply.toFixed(2)}%
      </p>
    </div>
  );
};
