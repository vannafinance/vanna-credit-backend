"use client";

/** Small shared pieces of the Perps terminal: tooltip, icons, the design's slider, popover state. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { PERP_MARKETS } from "@/lib/solana/phoenix";

export const PHOENIX_ICON = "/protocols/phoenix.png";
export const VANNA_ICON = "/logos/vanna-icon.png";

/** The (i) tooltip next to a label. */
export const Info = ({ text, placement = "top" }: { text: string; placement?: "top" | "bottom" | "right" }) => (
  <InfoTooltip content={text} label={text} placement={placement} />
);

export const Img = ({ src, className, alt = "" }: { src: string; className?: string; alt?: string }) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img src={src} alt={alt} className={className} style={{ borderRadius: "50%", objectFit: "cover" }} />
);

/** A market's token icon ("SOL" → /coins/sol.svg …). */
export const marketIcon = (key: string) => PERP_MARKETS.find((m) => m.key === key)?.icon ?? "/coins/default.svg";

export const Chev = ({ up, small }: { up?: boolean; small?: boolean }) => (
  <span className={`px-chev ${small ? "sm" : ""} ${up ? "up" : ""}`}>
    <svg width={small ? 12 : 16} height={small ? 12 : 16} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>
);

export const SideIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M10.25 3v10" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

export const Arrow = () => (
  <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true">
    <path d="M1 5h9M7 2l3 3-3 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Go = () => (
  <span className="px-go">
    <Arrow />
  </span>
);

export const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const MinusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
export const ClockIcon = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M6 3.6V6l1.6 1" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
  </svg>
);
export const WarnIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M7 1.5L13 12.5H1L7 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M7 5.5V8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <circle cx="7" cy="10" r="0.7" fill="currentColor" />
  </svg>
);
export const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/**
 * The design's slider: 4px track with the red→violet fill, a marker per stop, the Vanna thumb and
 * clickable labels under the markers.
 */
export function Slider({
  id,
  value,
  min,
  max,
  step,
  marks,
  label,
  aria,
  onChange,
  disabled,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  marks: number[];
  label: (v: number) => string;
  aria: string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const f = (v: number) => (max > min ? (v - min) / (max - min) : 0);
  const pct = Math.max(0, Math.min(100, f(value) * 100));
  return (
    <div className="px-sl" data-px-sl={id} style={{ ["--p" as string]: `${pct.toFixed(2)}%` }}>
      <div className="px-sl-tr">
        <i className="px-sl-fill" />
        {marks.map((m) => (
          <i key={m} className={`px-sl-dot ${value >= m - 1e-9 ? "on" : ""}`} style={{ ["--m" as string]: f(m) }} />
        ))}
      </div>
      <input
        type="range"
        className="px-sl-in"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={aria}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="px-sl-lb">
        {marks.map((m, i) => (
          <button
            key={m}
            type="button"
            disabled={disabled}
            onClick={() => onChange(m)}
            className={`${Math.abs(value - m) < 1e-9 ? "on" : ""} ${i === 0 ? "first" : i === marks.length - 1 ? "last" : ""}`}
            style={{ ["--m" as string]: f(m) }}
          >
            {label(m)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One open popover at a time per terminal; closes on an outside click or Escape. */
export function usePopover() {
  const [open, setOpen] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(`[data-pop="${open}"]`)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, toggle: (id: string) => setOpen((o) => (o === id ? null : id)), close: () => setOpen(null), root };
}

/** Modal shell (close / close all), drawn above the page; Escape and the backdrop close it. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="px-modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="px-modal" role="dialog" aria-modal="true" aria-label={title}>
        <button type="button" className="px-modal-x" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
