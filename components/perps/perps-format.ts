/**
 * Display helpers shared by the Perps page components.
 */

/** Pair slugs the route accepts → the market key the perps hooks take. */
export const PERP_PAIRS: Record<string, string> = {
  solusdc: "SOL",
  ethusdc: "ETH",
  btcusdc: "BTC",
  tslausdc: "TSLA",
  metausdc: "META",
};

export const DEFAULT_PERP_PAIR = "ethusdc";

export const pairSlug = (marketKey: string) => `${marketKey.toLowerCase()}usdc`;

/** Price with precision scaled to its magnitude (BTC 2dp, small prices more). */
export function fmtPrice(value: number | null | undefined): string {
  // Unknown / not-yet-loaded prints the zero form ("0.00"), never a placeholder dash.
  if (value == null || !Number.isFinite(value)) value = 0;
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 3 : 5;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}

/** USD amount with 2 decimals. */
export function fmtUsd(value: number | null | undefined, digits = 2): string {
  // Unknown / not-yet-loaded prints the zero form ("0.00"), never a placeholder dash.
  if (value == null || !Number.isFinite(value)) value = 0;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Base-asset exposure, with enough precision for small BTC/ETH orders. */
export function fmtTokenSize(value: number | null | undefined): string {
  // Unknown / not-yet-loaded (or a nonsensical negative size) prints "0", never a placeholder dash.
  if (value == null || !Number.isFinite(value) || value < 0) value = 0;
  if (value > 0 && value < 0.00000001) return "<0.00000001";
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export function fmtSigned(value: number, digits = 2): string {
  const s = fmtUsd(Math.abs(value), digits);
  return value > 0 ? `+${s}` : value < 0 ? `-${s}` : s;
}

/** Health factor label + colour: red ≤ 1.10 (liquidatable), amber < 1.25, green otherwise. */
export function healthFactorDisplay(hf: number | null): { label: string; color: string } {
  if (hf == null || !Number.isFinite(hf)) return { label: "∞", color: "text-[#24A0A9]" };
  const color = hf <= 1.1 ? "text-[#FC5457]" : hf < 1.25 ? "text-[#F5A524]" : "text-[#24A0A9]";
  return { label: hf.toFixed(2), color };
}
