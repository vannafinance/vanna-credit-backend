/**
 * Portfolio V3 maths — pure functions over on-chain reads, so the page and a verification script
 * compute the exact same numbers. Nothing here invents a figure: where the chain can't back a
 * number (history older than the scan window, a cost basis it can't prove) the result is `null`
 * and the page shows "—".
 */
import type { EarnHistoryRow, EarnedInterest, HistoryPage, MarginHistoryRow } from "@/lib/solana/history";
import { accruedInterestBySymbol } from "@/lib/margin/amounts";
import { getToken } from "@/lib/solana/tokens";

type Prices = Record<string, number>;

/** Wallet tokens at oracle prices, USD. */
export function walletUsd(balances: Record<string, string | number>, prices: Prices): number {
  return Object.entries(balances).reduce((t, [sym, amt]) => t + (parseFloat(String(amt)) || 0) * (prices[sym] ?? 0), 0);
}

/** Lending supply at its current value (shares × the pool's exchange rate, interest included), USD. */
export function lendingUsd(positions: Record<string, { assets: number }>, prices: Prices): number {
  return Object.entries(positions).reduce((t, [sym, p]) => t + (p.assets || 0) * (prices[sym] ?? 0), 0);
}

/**
 * Lending interest earned, USD: Σ provable per-asset interest (`computeEarnedInterest`) × price.
 * `null` when no asset's interest can be proven but some lending activity exists.
 */
export function lendingEarnedUsd(earned: Record<string, EarnedInterest> | null, prices: Prices): number | null {
  if (!earned) return null;
  let sum = 0;
  let known = false;
  let unknown = false;
  for (const e of Object.values(earned)) {
    if (e.earned === null) {
      unknown = true;
      continue;
    }
    known = true;
    sum += e.earned * (prices[e.symbol] ?? 0);
  }
  return known || !unknown ? sum : null;
}

/**
 * Perps P&L from the margin's own flows: Phoenix value now + USDC settled back − USDC funded
 * into Phoenix. Fees and funding included; realized = that minus the open positions' equity.
 * Only honest when the scanned history is complete (otherwise an older funding is missing).
 */
export function perpsFlowPnl(history: HistoryPage<MarginHistoryRow> | undefined, venueValueUsd: number, openEquityUsd: number) {
  if (!history?.complete) return { total: null as number | null, realized: null as number | null };
  let funded = 0;
  let settled = 0;
  for (const r of history.rows) {
    if (r.type === "perp-open") funded += Number(r.amount) || 0;
    else if (r.type === "perp-settle") settled += Number(r.amount) || 0;
  }
  if (funded === 0 && settled === 0) return { total: 0, realized: 0 };
  const total = venueValueUsd + settled - funded;
  return { total, realized: total - openEquityUsd };
}

/**
 * Kamino farm earnings per underlying symbol: underlying redeemable now − (Σ supplied − Σ redeemed)
 * from the decoded farm-deposit / farm-withdraw events. null per symbol (and overall) when the
 * history is incomplete. A liquidation resets the count (positions before it were seized).
 *
 * Only Kamino rows count here: Basis / Perena vault rows (`vaultId` set) are also farm-deposit /
 * farm-withdraw rows in USDC, but `positions` holds Kamino cTokens only, so counting them read every
 * USDC put into a vault as a Kamino USDC loss. Vault earnings come from {@link vaultEarnedUsd}.
 */
export function farmEarnedBySymbol(
  history: HistoryPage<MarginHistoryRow> | undefined,
  positions: { symbol: string; underlying: number }[],
): Record<string, number> | null {
  if (!history?.complete) return null;
  const net: Record<string, number> = {};
  for (const r of history.rows) {
    if (r.type === "liquidation") break; // newest first: older rows belong to seized positions
    if (r.vaultId) continue; // Basis / Perena vault, not Kamino
    if (r.type === "farm-deposit") net[r.symbol] = (net[r.symbol] ?? 0) + (Number(r.amount) || 0);
    else if (r.type === "farm-withdraw") net[r.symbol] = (net[r.symbol] ?? 0) - (Number(r.amount) || 0);
  }
  const out: Record<string, number> = {};
  const held = Object.fromEntries(positions.map((p) => [p.symbol, p.underlying]));
  for (const sym of new Set([...Object.keys(net), ...Object.keys(held)])) out[sym] = (held[sym] ?? 0) - (net[sym] ?? 0);
  return out;
}

/**
 * Basis / Perena vault earnings, USD: Σ per vault (receipts held now at the oracle's NAV price −
 * net USDC put in), each from `positionOf` (lib/farm/basis-live.ts). null when any held vault's
 * cost basis is unknown (history incomplete), so a partial sum is never shown as the total.
 */
export function vaultEarnedUsd(perVault: { earnedUsd: number | null }[]): number | null {
  let sum = 0;
  for (const v of perVault) {
    if (v.earnedUsd === null) return null;
    sum += v.earnedUsd;
  }
  return sum;
}

/** Σ farm earnings × price, USD (null when unknown). */
export function farmEarnedUsd(bySymbol: Record<string, number> | null, prices: Prices): number | null {
  if (!bySymbol) return null;
  return Object.entries(bySymbol).reduce((t, [s, v]) => t + v * (prices[s] ?? 0), 0);
}

/**
 * Borrow interest accrued on the open debts, USD (per-symbol accrual from history; a symbol whose
 * debt-open event is outside the scan window is left out). null when every open debt is unknown.
 */
export function interestAccruedUsd(rows: MarginHistoryRow[], debtTokens: Record<string, number>, prices: Prices): number | null {
  const open = Object.fromEntries(Object.entries(debtTokens).filter(([, v]) => v > 0));
  if (!Object.keys(open).length) return 0;
  const per = accruedInterestBySymbol(rows, open);
  let sum = 0;
  let known = false;
  for (const [sym, v] of Object.entries(per)) {
    if (v === null) continue;
    known = true;
    sum += v * (prices[sym] ?? 0);
  }
  return known ? sum : null;
}

/**
 * Collateral the wallet deposited into the margin account (Σ deposits − Σ withdrawals per token,
 * since the last liquidation) at today's prices, USD. null when the history is incomplete.
 */
export function netDepositedUsd(history: HistoryPage<MarginHistoryRow> | undefined, prices: Prices): number | null {
  if (!history?.complete) return null;
  const net: Record<string, number> = {};
  for (const r of history.rows) {
    if (r.type === "liquidation") break;
    if (r.type === "deposit") net[r.symbol] = (net[r.symbol] ?? 0) + (Number(r.amount) || 0);
    else if (r.type === "withdraw") net[r.symbol] = (net[r.symbol] ?? 0) - (Number(r.amount) || 0);
  }
  return Object.entries(net).reduce((t, [s, v]) => t + Math.max(0, v) * (prices[s] ?? 0), 0);
}

const DAY = 86_400_000;

/**
 * Lending P&L (interest earned) over the last `days` days, one point per day plus "now", USD at
 * today's prices. Anchored on the chain: every supply / redeem event carries its exact exchange
 * rate (assets ÷ shares) and the position carries today's, so earned(t) = shares(t) × rate(t) −
 * net deposited(t); between two anchors the rate is interpolated linearly. Only assets whose
 * interest `computeEarnedInterest` can prove are drawn, so the last point equals the stat.
 * Returns null when there is nothing to draw.
 */
export function lendingPnlSeries(
  history: HistoryPage<EarnHistoryRow> | undefined,
  positions: Record<string, { sharesRaw: bigint; assetsRaw: bigint }>,
  earned: Record<string, EarnedInterest> | null,
  prices: Prices,
  nowMs: number,
  days = 30,
): { pts: number[]; labels: string[] } | null {
  if (!history || !earned) return null;
  const times = Array.from({ length: days + 1 }, (_, i) => nowMs - (days - i) * DAY);
  const pts = times.map(() => 0);
  let drawn = false;
  for (const e of Object.values(earned)) {
    if (e.earned === null) continue;
    const rows = history.rows.filter((r) => r.symbol === e.symbol).sort((a, b) => a.timestamp - b.timestamp);
    if (!rows.length) continue;
    const token = getToken(e.symbol);
    const scale = 10 ** token.decimals;
    const price = prices[e.symbol] ?? 0;
    // Exchange-rate anchors: (time, raw assets per raw share).
    const anchors: [number, number][] = rows.filter((r) => r.sharesRaw > 0n).map((r) => [r.timestamp, Number(r.amountRaw) / Number(r.sharesRaw)]);
    const pos = positions[e.symbol];
    if (pos && pos.sharesRaw > 0n) anchors.push([nowMs, Number(pos.assetsRaw) / Number(pos.sharesRaw)]);
    const rateAt = (t: number) => {
      if (!anchors.length) return 0;
      if (t <= anchors[0][0]) return anchors[0][1];
      for (let k = 1; k < anchors.length; k++) {
        const [t1, r1] = anchors[k];
        if (t <= t1) {
          const [t0, r0] = anchors[k - 1];
          return t1 === t0 ? r1 : r0 + ((r1 - r0) * (t - t0)) / (t1 - t0);
        }
      }
      return anchors[anchors.length - 1][1];
    };
    times.forEach((t, i) => {
      let shares = 0;
      let netAssets = 0;
      let any = false;
      for (const r of rows) {
        if (r.timestamp > t) break;
        any = true;
        const sign = r.type === "supply" ? 1 : -1;
        shares += sign * Number(r.sharesRaw);
        netAssets += sign * Number(r.amountRaw);
      }
      if (!any) return;
      // The last point is "now": use the exact on-chain value so it equals the stat.
      const value = i === times.length - 1 && pos ? Number(pos.assetsRaw) : shares * rateAt(t);
      pts[i] += ((value - netAssets) / scale) * price;
    });
    drawn = true;
  }
  if (!drawn) return null;
  const labels = times.map((t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  return { pts, labels };
}
