/**
 * Delta-neutral ("basis") vaults for the Farm page — UI preview only.
 *
 * Each vault buys spot on Jupiter and holds an equal 1x short on Phoenix, earning the funding the
 * short is paid. The program side is not built yet, so every vault figure here (TVL, cap, funding,
 * APY, share price, rebalance time) is SAMPLE DATA generated deterministically from a seed, ported
 * from the "Vanna Basis Vaults" design prototype v2. The UI labels it "Preview · sample data".
 * Things that are real on the page (margin balances, debts, borrow APY, health factor) come from the
 * account snapshot / pool hooks, not from this module.
 *
 * Replace `BASIS_VAULTS` + `buildSeries` with the vault program's on-chain state when integrating.
 */

/** Days in every sample series; the last point is "today". */
export const SERIES_DAYS = 120;
const DAY_MS = 864e5;
/** Half of a deposit buys spot, half backs the 1x short. */
export const HEDGE = 0.5;

export interface BasisVaultConfig {
  id: string;
  name: string;
  /** Asset held spot and shorted, "SOL" | "BTC" | "ETH". */
  asset: string;
  /** Phoenix market shorted. */
  perp: string;
  icon: string;
  /** Sample index price, USD. */
  price: number;
  /** Mean annualised funding (%) the series is generated around, and its daily volatility. */
  fundingMean: number;
  fundingVol: number;
  /** Annualised Phoenix position + borrow fees on the short half (%). */
  perpFee: number;
  /** Annualised Jupiter execution / rebalancing drag (%). */
  exec: number;
  /** Vault fee, % of profit. */
  fee: number;
  /** Daily mark-to-market noise of the share price. */
  mtm: number;
  tvl: number;
  cap: number;
  seed: number;
  /** Day indexes forced to negative funding. */
  negativeDays: number[];
  /** Spot minus short, % of the vault. */
  delta: number;
  /** Receipt token. */
  share: string;
  rebalanced: string;
}

export interface BasisVaultSeries {
  /** Daily annualised funding (%). */
  funding: number[];
  /** Daily vault APY before / after the vault fee (%). */
  grossApy: number[];
  apy: number[];
  /** USDC per share, net and gross of the vault fee (starts at 1). */
  sharePrice: number[];
  sharePriceGross: number[];
  fundingNow: number;
  funding7: number;
  funding30: number;
  apy7: number;
  apy30: number;
  apy90: number;
  /** Since launch, %. */
  roi: number;
  apyAll: number;
  sharpe: number;
  maxDrawdown: number;
  negativeDays30: number;
}

export type BasisVault = BasisVaultConfig & BasisVaultSeries;

/** Sample vaults (illustrative figures — see the module comment). */
const BASIS_VAULT_CONFIGS: BasisVaultConfig[] = [
  { id: "sol", name: "SOL Basis", asset: "SOL", perp: "SOL-PERP", icon: "/coins/sol.svg", price: 210, fundingMean: 26.0, fundingVol: 7, perpFee: 1.8, exec: 0.3, fee: 10, mtm: 0.0004, tvl: 1.84e6, cap: 5e6, seed: 4, negativeDays: [97, 98, 107], delta: 0.06, share: "vbSOL", rebalanced: "2h ago" },
  { id: "btc", name: "BTC Basis", asset: "BTC", perp: "BTC-PERP", icon: "/coins/btc.svg", price: 118000, fundingMean: 17.2, fundingVol: 5, perpFee: 1.2, exec: 0.2, fee: 10, mtm: 0.0003, tvl: 2.61e6, cap: 5e6, seed: 1, negativeDays: [93, 108], delta: -0.03, share: "vbBTC", rebalanced: "5h ago" },
  { id: "eth", name: "ETH Basis", asset: "ETH", perp: "ETH-PERP", icon: "/coins/eth.svg", price: 4350, fundingMean: 21.4, fundingVol: 6, perpFee: 1.4, exec: 0.3, fee: 10, mtm: 0.00035, tvl: 1.12e6, cap: 5e6, seed: 20, negativeDays: [99, 100, 110], delta: 0.11, share: "vbETH", rebalanced: "40m ago" },
];

/** Tokens a basis vault deposit can come from (held in the margin account). */
export const BASIS_DEPOSIT_TOKENS = ["USDC", "USDT", "SOL"] as const;

// ── Deterministic sample series ─────────────────────────────────────────────

/** mulberry32 — seeded so the sample charts are stable across renders and reloads. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  let u = 0;
  let v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sdev = (a: number[]) => {
  const m = avg(a);
  return Math.sqrt(avg(a.map((x) => (x - m) ** 2)));
};

function buildSeries(v: BasisVaultConfig): BasisVaultSeries {
  const N = SERIES_DAYS;
  const r = rng(v.seed);
  const funding: number[] = [];
  let x = v.fundingMean;
  for (let i = 0; i < N; i++) {
    x = v.fundingMean + 0.75 * (x - v.fundingMean) + gauss(r) * v.fundingVol * 0.6;
    funding.push(Math.max(3, x));
  }
  const m = avg(funding);
  for (let i = 0; i < N; i++) funding[i] += v.fundingMean - m;
  v.negativeDays.forEach((i) => {
    funding[i] = -(1.5 + 4 * r());
  });
  const grossApy = funding.map((f) => f * HEDGE - v.perpFee * HEDGE - v.exec);
  const apy = grossApy.map((g) => (g > 0 ? g * (1 - v.fee / 100) : g));
  let acc = 1;
  let accG = 1;
  let mm = 0;
  const sharePrice = [1];
  const sharePriceGross = [1];
  for (let i = 1; i < N; i++) {
    acc *= 1 + apy[i] / 36500;
    accG *= 1 + grossApy[i] / 36500;
    mm = 0.55 * mm + gauss(r) * v.mtm;
    sharePrice.push(acc * (1 + mm));
    sharePriceGross.push(accG * (1 + mm));
  }
  const ret = sharePrice.slice(1).map((p, i) => p / sharePrice[i] - 1);
  let peak = sharePrice[0];
  let mdd = 0;
  sharePrice.forEach((p) => {
    peak = Math.max(peak, p);
    mdd = Math.min(mdd, p / peak - 1);
  });
  const f30 = funding.slice(N - 30);
  return {
    funding,
    grossApy,
    apy,
    sharePrice,
    sharePriceGross,
    fundingNow: funding[N - 1],
    funding7: avg(funding.slice(N - 7)),
    funding30: avg(f30),
    apy7: avg(apy.slice(N - 7)),
    apy30: avg(apy.slice(N - 30)),
    apy90: avg(apy.slice(N - 90)),
    roi: (sharePrice[N - 1] / sharePrice[0] - 1) * 100,
    apyAll: (Math.pow(sharePrice[N - 1] / sharePrice[0], 365 / (N - 1)) - 1) * 100,
    sharpe: (avg(ret) / sdev(ret)) * Math.sqrt(365),
    maxDrawdown: mdd * 100,
    negativeDays30: f30.filter((f) => f < 0).length,
  };
}

export const BASIS_VAULTS: BasisVault[] = BASIS_VAULT_CONFIGS.map((c) => ({ ...c, ...buildSeries(c) }));

export function findBasisVault(id: string | null | undefined): BasisVault | undefined {
  return BASIS_VAULTS.find((v) => v.id === id);
}

// ── Dates ───────────────────────────────────────────────────────────────────

/** UTC midnight of today; the last series point. */
function seriesEnd(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
export const seriesDate = (i: number) => new Date(seriesEnd() - (SERIES_DAYS - 1 - i) * DAY_MS);
export const seriesLabel = (i: number) =>
  seriesDate(i).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// ── Monthly returns grid (Neutral Trade style) ──────────────────────────────

export interface MonthlyReturns {
  /** year → month (0-11) → { value %, month-to-date } */
  rows: Record<number, Record<number, { value: number; mtd: boolean }>>;
  ytd: Record<number, number>;
  since: number;
}

export function monthlyReturns(v: BasisVault, fees: "gross" | "net", basis: "roi" | "apy"): MonthlyReturns {
  const s = fees === "gross" ? v.sharePriceGross : v.sharePrice;
  const N = SERIES_DAYS;
  const months = new Map<string, { y: number; m: number; i0: number; i1: number }>();
  for (let i = 0; i < N; i++) {
    const d = seriesDate(i);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    const cur = months.get(key);
    if (cur) cur.i1 = i;
    else months.set(key, { y: d.getUTCFullYear(), m: d.getUTCMonth(), i0: i, i1: i });
  }
  const annualise = (roi: number, days: number) => (basis === "apy" ? Math.pow(1 + roi, 365 / days) - 1 : roi);
  const rows: MonthlyReturns["rows"] = {};
  months.forEach((o) => {
    const base = o.i0 > 0 ? s[o.i0 - 1] : s[0];
    const value = annualise(s[o.i1] / base - 1, o.i1 - o.i0 + 1) * 100;
    (rows[o.y] ??= {})[o.m] = { value, mtd: o.i1 === N - 1 && seriesDate(N - 1).getUTCDate() < 28 };
  });
  const ytd: Record<number, number> = {};
  Object.keys(rows).forEach((ys) => {
    const y = Number(ys);
    const idx = [...Array(N).keys()].filter((i) => seriesDate(i).getUTCFullYear() === y);
    const roi = s[idx[idx.length - 1]] / (idx[0] > 0 ? s[idx[0] - 1] : s[0]) - 1;
    ytd[y] = annualise(roi, idx.length) * 100;
  });
  return { rows, ytd, since: (s[N - 1] / s[0] - 1) * 100 };
}

// ── Formatting (only glyphs Plus Jakarta Sans has) ──────────────────────────

const nf = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtNum = nf;
export const fmtUsd = (n: number, d = 2) => `${n < 0 ? "−$" : "$"}${nf(Math.abs(n), d)}`;
export const fmtUsdCompact = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e6 ? `${nf(a / 1e6, 2)}M` : a >= 1e3 ? `${nf(a / 1e3, 1)}K` : nf(a, 0);
  return `${n < 0 ? "−$" : "$"}${s}`;
};
export const fmtPct = (n: number, d = 1) => `${n < 0 ? "−" : ""}${nf(Math.abs(n), d)}%`;
export const fmtSignedPct = (n: number, d = 1) => `${n >= 0 ? "+" : "−"}${nf(Math.abs(n), d)}%`;
