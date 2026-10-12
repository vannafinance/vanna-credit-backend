/**
 * Pure Predict maths (unit-tested in math.test.ts): prices from maker fills, trade sizing, and the
 * outcome_yield_pool share maths (bit-for-bit with programs/outcome_yield_pool/src/math.rs).
 */
import { POOL_SWAP_DUST_UNITS, POOL_SWAP_SLACK_PPM, POOL_SWAP_SLACK_UNITS, POOL_VIRTUAL_ASSETS, POOL_VIRTUAL_SHARES } from "./constants";
import type { MarketPrices } from "./types";

export interface Fill {
  price: number;
  ts: number;
}

/** Spread the fork maker adds when a side has no trade of its own. */
export const SYNTHETIC_SPREAD = 0.02;

export const clampPrice = (p: number) => Math.min(0.99, Math.max(0.01, p));

/**
 * Asks and bids for a market from its last mainnet fills. A side without its own trade is derived
 * from the other outcome (YES + NO always redeem 1 CASH together). Crypto windows with no trade yet
 * open at 50/50 ± half the spread.
 */
export function pricesFromFills(
  fills: { yesBuy?: Fill; noBuy?: Fill; yesSell?: Fill; noSell?: Fill },
  kind: "updown" | "binary",
  startMs: number | null,
): MarketPrices {
  const { yesBuy: yb, noBuy: nb, yesSell: ys, noSell: ns } = fills;
  const lastTradeAt = Math.max(yb?.ts ?? 0, nb?.ts ?? 0, ys?.ts ?? 0, ns?.ts ?? 0) || null;

  if (!yb && !nb && !ys && !ns) {
    if (kind === "updown" && startMs !== null) {
      return { yesAsk: 0.51, noAsk: 0.51, yesBid: 0.49, noBid: 0.49, lastTradeAt: null, source: "reference" };
    }
    return { yesAsk: null, noAsk: null, yesBid: null, noBid: null, lastTradeAt: null, source: "none" };
  }

  let yesMid = yb?.price ?? ys?.price ?? (nb ? 1 - nb.price : ns ? 1 - ns.price : 0.5);
  let noMid = nb?.price ?? ns?.price ?? 1 - yesMid;
  // YES + NO redeem exactly 1 CASH, so prices from different moments must roughly sum to 1:
  // when they don't, keep the newer side and derive the older one from it.
  const yesTs = Math.max(yb?.ts ?? 0, ys?.ts ?? 0);
  const noTs = Math.max(nb?.ts ?? 0, ns?.ts ?? 0);
  if (yesTs && noTs && Math.abs(yesMid + noMid - 1) > 0.08) {
    if (yesTs >= noTs) noMid = 1 - yesMid;
    else yesMid = 1 - noMid;
  }
  const fresh = (f: Fill | undefined, sideTs: number) => (f && f.ts >= sideTs - 60_000 ? f.price : undefined);
  const newest = Math.max(yesTs, noTs);
  const yesAsk = clampPrice(fresh(yb, newest) ?? yesMid + SYNTHETIC_SPREAD / 2);
  const noAsk = clampPrice(fresh(nb, newest) ?? noMid + SYNTHETIC_SPREAD / 2);
  let yesBid = clampPrice(fresh(ys, newest) ?? Math.min(yesMid, 1 - noAsk) - SYNTHETIC_SPREAD / 2);
  let noBid = clampPrice(fresh(ns, newest) ?? Math.min(noMid, 1 - yesAsk) - SYNTHETIC_SPREAD / 2);
  if (yesBid >= yesAsk) yesBid = clampPrice(yesAsk - SYNTHETIC_SPREAD);
  if (noBid >= noAsk) noBid = clampPrice(noAsk - SYNTHETIC_SPREAD);
  return { yesAsk, noAsk, yesBid, noBid, lastTradeAt, source: "trades" };
}

/** An oracle older than this is not quoted from (World's keeper rewrites live ones every 1–3 min). */
export const QUOTE_MAX_AGE_MS = 15 * 60_000;

/**
 * Asks and bids from JanusFI's live oracle (see constants.ts): YES ask = mid + half-spread + the
 * maker's markup, NO ask = (1 − mid) + the same; bids mirror them. A side that would cost ≥ 1 CASH
 * (or pay ≤ 0) is not offered (null), like World's own book on near-settled outcomes. Null when the
 * oracle is paused (flags 3) or stale, so the caller falls back to fills.
 */
export function pricesFromQuote(
  q: { mid: number; halfSpread: number; flags: number; updatedMs: number },
  markup: number,
  now = Date.now(),
): MarketPrices | null {
  if (q.flags === 3 || now - q.updatedMs > QUOTE_MAX_AGE_MS) return null;
  const s = q.halfSpread + markup;
  const side = (p: number) => {
    const r = Math.round(p * 1e6) / 1e6;
    return r > 0 && r < 1 ? r : null;
  };
  const p = {
    yesAsk: side(q.mid + s),
    noAsk: side(1 - q.mid + s),
    yesBid: side(q.mid - s),
    noBid: side(1 - q.mid - s),
  };
  if (p.yesAsk === null && p.noAsk === null) return null;
  return { ...p, lastTradeAt: null, source: "quote" };
}

/**
 * The trader's price of one fill: CASH moved / outcome tokens moved. Null outside (0.001, 1.05)
 * (dust, or a trade funded in another currency). Capped at 0.999.
 */
export function fillPrice(cashRaw: number, outcomeRaw: number): number | null {
  if (!cashRaw || !outcomeRaw) return null;
  const price = Math.abs(cashRaw) / Math.abs(outcomeRaw);
  if (!(price > 0.001 && price < 1.05)) return null;
  return Math.min(price, 0.999);
}

/** Price (0–1) → cents with 0.1¢ precision; null passes through. */
export const toCents = (p: number | null | undefined): number | null => (p == null ? null : Math.round(p * 1000) / 10);

/** Shares (raw, 6 decimals) a buy of `cashRaw` CASH at `price` receives. */
export const buyShares = (cashRaw: bigint, price: number): bigint => BigInt(Math.floor(Number(cashRaw) / price));
/** CASH (raw) a sell of `sharesRaw` at `price` returns. */
export const sellCash = (sharesRaw: bigint, price: number): bigint => BigInt(Math.floor(Number(sharesRaw) * price));

/** UI amount → raw u64 units (6 decimals by default), rounded to the nearest unit. */
export const toRawUnits = (ui: number, decimals = 6): bigint => BigInt(Math.round(ui * 10 ** decimals));
export const fromRawUnits = (raw: bigint, decimals = 6): number => Number(raw) / 10 ** decimals;

/**
 * Exact redeemable value (outcome-token raw units) of `sharesRaw` pool shares of one side: the
 * program's `to_assets_down` over dangling + invested. Must match the program bit-for-bit — the
 * redeem's Jupiter route is sized off this number.
 */
export function previewRedeemValue(sharesRaw: bigint, dangling: bigint, invested: bigint, shareSupply: bigint): bigint {
  if (sharesRaw <= 0n || shareSupply <= 0n) return 0n;
  return (sharesRaw * (dangling + invested + POOL_VIRTUAL_ASSETS)) / (shareSupply + POOL_VIRTUAL_SHARES);
}

/**
 * Fewest shares whose redeem value covers `assetsRaw` (inverse of previewRedeemValue, rounded up),
 * capped at `held`. Returns `held` when even all of them fall short.
 */
export function sharesForAssets(assetsRaw: bigint, held: bigint, dangling: bigint, invested: bigint, shareSupply: bigint): bigint {
  if (assetsRaw <= 0n) return 0n;
  const totalAssets = dangling + invested + POOL_VIRTUAL_ASSETS;
  const supply = shareSupply + POOL_VIRTUAL_SHARES;
  let shares = (assetsRaw * supply + totalAssets - 1n) / totalAssets;
  // Ceil-division can still undershoot by the floor in to_assets_down; nudge up until it covers.
  while (shares < held && previewRedeemValue(shares, dangling, invested, shareSupply) < assetsRaw) shares += 1n;
  return shares > held ? held : shares;
}

/**
 * Most shares whose redeem value is at most `assetsRaw` (the largest s with
 * `floor(s × (dangling + invested + 1) / (supply + 1000)) ≤ assetsRaw`), capped at `held`.
 */
export function maxSharesForAssets(assetsRaw: bigint, held: bigint, dangling: bigint, invested: bigint, shareSupply: bigint): bigint {
  if (assetsRaw < 0n) return 0n;
  const totalAssets = dangling + invested + POOL_VIRTUAL_ASSETS;
  const supply = shareSupply + POOL_VIRTUAL_SHARES;
  const shares = ((assetsRaw + 1n) * supply - 1n) / totalAssets;
  return shares > held ? held : shares;
}

/** redeem.rs: how far the declared route input may exceed `shortfall` (`SWAP_SLACK_PPM`, `SWAP_SLACK_UNITS`). */
export const redeemSwapSlack = (shortfall: bigint): bigint => (shortfall * POOL_SWAP_SLACK_PPM) / 1_000_000n + POOL_SWAP_SLACK_UNITS;

export interface RedeemSizing {
  /** Shares to burn (≤ requested; fewer only when the pool cannot fund the route's headroom, see below). */
  shares: bigint;
  /** Outcome tokens the redeem pays at least (value at the read, which interest only raises). */
  value: bigint;
  /** Declared USDC input of the USDC → CASH route; 0n when the dangling tokens cover the redeem. */
  usdcIn: bigint;
}

/**
 * Sizes one `redeem` so its route passes the program's `SwapAmountMismatch` check when it lands, not
 * when it was read. The program computes the shortfall AFTER `PublicRefreshReserve` accrues interest,
 * so it only grows with time, and requires `shortfall ≤ usdc_in ≤ shortfall + slack(shortfall)`.
 * The route is therefore sized for the shortfall at `investedAhead` (invested projected
 * `POOL_REDEEM_HORIZON_SECS` ahead) plus `SWAP_DUST_UNITS` (so a route a few units under par still
 * splits the full payout), never above `shortfall_now + slack(shortfall_now)` (≤ the program's
 * slack, since its shortfall is ≥ ours) nor above `investedNow` (what the pool can surely redeem
 * from Vanna). When that last cap bites — the side's last holders redeeming nearly all of it —
 * the shares are trimmed so the projected shortfall fits, leaving accrued dust in the pool.
 */
export function sizeRedeem(sharesRaw: bigint, dangling: bigint, investedNow: bigint, investedAhead: bigint, shareSupply: bigint): RedeemSizing {
  let shares = sharesRaw;
  const valueAhead = (s: bigint) => previewRedeemValue(s, dangling, investedAhead, shareSupply);
  if (valueAhead(shares) - dangling + POOL_SWAP_DUST_UNITS > investedNow && valueAhead(shares) > dangling) {
    shares = maxSharesForAssets(dangling + investedNow - POOL_SWAP_DUST_UNITS, shares, dangling, investedAhead, shareSupply);
  }
  const value = previewRedeemValue(shares, dangling, investedNow, shareSupply);
  const ahead = valueAhead(shares);
  // Dangling tokens cover it even at the horizon: no route (the program ignores swap_data then).
  if (ahead <= dangling) return { shares, value, usdcIn: 0n };
  // Covered now but maybe not when it lands: a route is attached anyway (ignored if unneeded).
  const shortfall = value > dangling ? value - dangling : 0n;
  const want = ahead - dangling + POOL_SWAP_DUST_UNITS;
  const cap = shortfall + redeemSwapSlack(shortfall);
  const usdcIn = [want, cap, investedNow].reduce((a, b) => (b < a ? b : a));
  return { shares, value, usdcIn: usdcIn < shortfall ? shortfall : usdcIn };
}

/**
 * The UI pool bar for one market: each side's dangling tokens plus the USDC its matched pairs
 * became (`min(yes, no)` = USDC lent + pairs pending merge).
 */
export function poolBar(yesDangling: number, noDangling: number, invested: number): { yes: number; no: number } {
  return { yes: yesDangling + invested, no: noDangling + invested };
}

/** "3m ago" from epoch ms. */
export function timeAgo(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** "4d 21h" / "12m" until `endMs`. */
export function countdown(endMs: number | null, now = Date.now()): string {
  if (!endMs) return "";
  const s = Math.max(0, Math.round((endMs - now) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "Oct 12, 2026" (UTC). */
export const shortDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "";
