/** Formatting helpers. Unknown values render as an em dash; callers say why next to the value. */
export const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const usdFull = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });

export const usd = (v: number | null | undefined) => (finite(v) ? usdFull.format(v) : "-");
/** Compact only where it stays exact enough to read; small values keep their cents. */
export const usdC = (v: number | null | undefined) => (!finite(v) ? "-" : Math.abs(v) >= 10000 ? usdCompact.format(v) : usdFull.format(v));
export const num = (v: number | null | undefined, max = 4) => (finite(v) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: max }).format(v) : "-");
export const pct = (v: number | null | undefined, digits = 2) => (finite(v) ? `${(v * 100).toFixed(digits)}%` : "-");
export const pct1 = (v: number | null | undefined) => pct(v, 1);
export const hfText = (v: number | null | undefined) => (!finite(v) ? "-" : v >= 1000 ? ">1,000" : v >= 100 ? v.toFixed(0) : v.toFixed(2));
export const levText = (v: number | null | undefined) => (finite(v) ? `${v >= 100 ? ">100" : v.toFixed(2)}×` : "-");
export const short = (a: string | null | undefined, head = 4, tail = 4) => (a ? (a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`) : "-");

/** Chain timestamps come from the fork's own clock, which is not this device's wall clock. */
export const forkTime = (t: number | null | undefined) =>
  finite(t) ? new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Unavailable";
export const clock = (ms: number | null | undefined) =>
  finite(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "-";
export const ago = (seconds: number | null | undefined) => {
  if (!finite(seconds)) return "-";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ago`;
};
export const span = (seconds: number | null | undefined) => {
  if (!finite(seconds)) return "-";
  const s = Math.round(seconds);
  return s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`;
};

/** Plain-language label for how an asset is priced (the raw feed text names oracle products and fallbacks). */
export const priceSourceLabel = (feed: string): string =>
  feed.includes("× Kamino rate")
    ? "Kamino deposit rate"
    : feed.replace("Kamino Scope", "Kamino feed").replace(" × factor fallback", " (adjusted)").replace(" fallback", "").replace(" → ", " · backup: ");
