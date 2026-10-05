"use client";

/** Shared building blocks of the basis-vault pages (cards, segmented toggles, small chips). */
import type { ReactNode } from "react";
import { useTheme } from "@/contexts/theme-context";
import { InfoTooltip } from "@/components/ui/info-tooltip";

export function useBasisColors() {
  const { isDark } = useTheme();
  return {
    isDark,
    title: isDark ? "text-white" : "text-[#181822]",
    text: isDark ? "text-white" : "text-[#111111]",
    label: isDark ? "text-[#A7A7A7]" : "text-[#777777]",
    quiet: isDark ? "text-[#777777]" : "text-[#9CA3AF]",
    pos: isDark ? "text-[#3FC0A3]" : "text-[#0B7A63]",
    neg: isDark ? "text-[#F0666E]" : "text-[#C9333B]",
    warn: isDark ? "text-[#E0AC5C]" : "text-[#8A5A06]",
    line: isDark ? "border-[#2A2A2A]" : "border-[#E8E8E8]",
    card: isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]",
    tile: isDark ? "bg-[#222222]" : "bg-[#F7F7F7]",
    chip: isDark ? "bg-[#2A2A2A] text-[#A7A7A7]" : "bg-[#F0F0F0] text-[#555555]",
    track: isDark ? "bg-[#2C2C2C]" : "bg-[#ECECF0]",
  };
}

/** Green / red text class for a signed value. */
export function useSignClass() {
  const c = useBasisColors();
  return (v: number) => (v >= 0 ? c.pos : c.neg);
}

export function BasisCard({ title, sub, right, children, className = "" }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  const c = useBasisColors();
  return (
    <section className={`rounded-2xl border p-4 min-w-0 ${c.card} ${className}`}>
      {(title || right) && (
        <div className="flex justify-between items-start gap-x-3 gap-y-2 flex-wrap mb-3.5">
          <div className="min-w-0">
            {title && <h3 className={`text-[15px] font-semibold ${c.title}`}>{title}</h3>}
            {sub && <div className={`text-[12px] mt-0.5 ${c.label}`}>{sub}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = "md" }: { value: T; options: [T, string][]; onChange: (v: T) => void; size?: "sm" | "md" }) {
  const c = useBasisColors();
  return (
    <div className={`inline-flex gap-1 p-1 rounded-xl border ${c.isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"}`} role="tablist">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          onClick={() => onChange(id)}
          className={`rounded-lg whitespace-nowrap cursor-pointer transition-colors ${size === "sm" ? "text-[12px] px-2.5 py-1" : "text-[14px] px-3 py-1.5"} ${
            value === id ? "bg-[#703AE6] text-white font-semibold" : `${c.isDark ? "text-[#555555]" : "text-[#A7A7A7]"} font-medium`
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Info({ text, label }: { text: string; label: string }) {
  return <InfoTooltip content={text} label={label} />;
}

export function MiniTag({ children, className = "" }: { children: ReactNode; className?: string }) {
  const c = useBasisColors();
  return <span className={`inline-block px-1.5 py-0.5 rounded-md text-[11px] font-semibold leading-[1.4] whitespace-nowrap ${c.chip} ${className}`}>{children}</span>;
}

/** Labels the vault figures as illustrative until the vault program is integrated. */
export function SampleDataBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold rounded-md px-2 py-0.5 bg-[#F59E0B]/10 text-[#B7791F] border border-[#F59E0B]/30 whitespace-nowrap">
      Preview · sample data
    </span>
  );
}

export const RANGES: [number, string][] = [
  [7, "1 Week"],
  [30, "1 Month"],
  [90, "3 Months"],
  [120, "All Time"],
];
