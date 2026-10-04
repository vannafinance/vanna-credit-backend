/**
 * Display helpers shared by the Perps page components.
 */

/** Pair slugs the route accepts → the market key the perps hooks take. */
export const PERP_PAIRS: Record<string, string> = {
  ethusdc: "ETH",
  btcusdc: "BTC",
  solusdc: "SOL",
};

export const DEFAULT_PERP_PAIR = "ethusdc";

export const pairSlug = (marketKey: string) => `${marketKey.toLowerCase()}usdc`;

/** Price with precision scaled to its magnitude (BTC 2dp, small prices more). */
export function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 3 : 5;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}

/** USD amount with 2 decimals. */
export function fmtUsd(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
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
