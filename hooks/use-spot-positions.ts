'use client';

/**
 * The margin account's SPOT positions, derived from real data only:
 *
 * - LONG  = a volatile (non-stable) token held in the margin account;
 * - SHORT = a volatile token the account owes (debt).
 *
 * Kamino receipts (kSOL, kUSDC, …) and the Phoenix venue line are not spot positions (they belong to
 * Farm and Perps) and are left out.
 *
 * Entry prices come from the account's own on-chain history (`fetchMarginHistory`, decoded from the
 * program's events — no indexer, no cache): a weighted-average cost over `swap` rows. Buys raise the
 * average, sells reduce the size at the same average. Deposits / borrowed-but-unsold tokens have no
 * cost the chain can tell us, so when history can't explain the whole balance the row says so
 * (`entry: null`, `source: "deposit" | "partial" | "unsold"`) instead of inventing an entry.
 *
 * Mark, liquidation price, health maths: `useV3Account()` (program-exact account model).
 *
 * The pure part (`computeSpotPositions`) takes plain inputs so the Portfolio page and scripts can
 * reuse it without React.
 */
import { useEffect, useMemo } from 'react';
import { useUserStore } from '@/store/user';
import { refreshMarginAccount, useMarginAccountInfoStore } from '@/store/margin-account-info-store';
import { useMarginHistory } from '@/hooks/use-margin';
import { useV3Account } from '@/hooks/use-v3-account';
import { isStable } from '@/lib/account-model';
import { findToken } from '@/lib/solana/tokens';
import type { MarginHistoryRow } from '@/lib/solana/history';

export type SpotSide = 'long' | 'short';

/**
 * Where a row's entry price comes from:
 * - `swaps`   — the whole size is explained by swaps in the on-chain history (entry = weighted average);
 * - `partial` — only part of it was bought (long) / sold (short) here; the rest was deposited,
 *               borrowed and kept, or predates the history scan (entry = null, see `explainedQty`);
 * - `deposit` — none of it came from a swap (deposited, or older than the scanned history);
 * - `unsold`  — a short whose borrowed tokens were never sold through a swap (still held).
 */
export type SpotEntrySource = 'swaps' | 'partial' | 'deposit' | 'unsold';

export interface SpotPosition {
  /** Stable row id: `${symbol}-${side}`. */
  id: string;
  symbol: string;
  side: SpotSide;
  /** Long: tokens held in the margin vault. Short: tokens owed (debt incl. accrued interest). */
  qty: number;
  /** On-chain (oracle) price, USD; 0 when unknown. */
  mark: number;
  /** qty × mark. */
  sizeUsd: number;
  /** Weighted-average entry, USD per token; null when history can't explain the whole size. */
  entry: number | null;
  source: SpotEntrySource;
  /** Tokens of `qty` that the swap history explains (≤ qty). */
  explainedQty: number;
  /** Average price of the explained part (even when `entry` is null), USD; null when nothing is explained. */
  explainedAvg: number | null;
  /** (mark − entry) × qty for a long, (entry − mark) × qty for a short; null without an entry. */
  pnl: number | null;
  /** pnl ÷ (entry × qty) × 100; null without an entry. */
  pnlPct: number | null;
  /** Price of this token at which the whole account reaches HF 1.10 (adverse direction only); null = none / no debt. */
  liqPrice: number | null;
  /** (liqPrice − mark) ÷ mark × 100 (negative = a fall liquidates). null with no liqPrice. */
  liqDistancePct: number | null;
  /** Aggregator of the latest swap that built this position (Jupiter / Titan), when known. */
  via: 'Jupiter' | 'Titan' | null;
  /** ms since epoch the position (re)opened in the scanned history; null when it predates it. */
  openedAt: number | null;
  /** Human explanation of `source` for a tooltip. */
  note: string;
}

export interface SpotPositionsInput {
  /** Margin history rows (any order; newest-first as `fetchMarginHistory` returns them is fine). */
  rows: readonly MarginHistoryRow[];
  /** True when the history scan reached the wallet's first signature. */
  historyComplete: boolean;
  /** Token balances in the margin vaults (UI units, by registry symbol). */
  holdings: readonly { symbol: string; amount: number }[];
  /** Debts (UI units incl. accrued interest, by registry symbol). */
  debts: readonly { symbol: string; amount: number }[];
  priceOf: (symbol: string) => number;
  liqPriceOf: (symbol: string, side?: SpotSide) => number | null;
}

/** True for a symbol that can be a spot position (volatile registry token, not a receipt / venue). */
export function isSpotSymbol(symbol: string): boolean {
  if (!symbol || /^k[A-Z]/.test(symbol) || symbol === 'Phoenix' || symbol === 'phUSD') return false;
  return Boolean(findToken(symbol)) && !isStable(symbol);
}

/** Relative tolerance when matching history against balances (interest, rounding, fee dust). */
const EXPLAIN_TOL = 0.01;

/** Inventory of one token as the history tells it. */
interface Book {
  /** Long inventory with a known USD cost. */
  knownQty: number;
  knownCost: number;
  /** Long inventory with no known cost (deposited, farm yield, bought with an unknown-cost token). */
  unknownQty: number;
  /** Tokens parked in Kamino (left via farm-deposit), with their share of known cost. */
  parkedKnownQty: number;
  parkedKnownCost: number;
  parkedUnknownQty: number;
  /** Borrowed tokens still held (not yet sold). */
  borrowedUnsold: number;
  /** Borrowed tokens sold for a known USD amount (the short's entry) / for an unknown amount. */
  shortQty: number;
  shortProceeds: number;
  shortUnknownQty: number;
  longVia: 'Jupiter' | 'Titan' | null;
  shortVia: 'Jupiter' | 'Titan' | null;
  longOpenedAt: number | null;
  shortOpenedAt: number | null;
}

const newBook = (): Book => ({
  knownQty: 0,
  knownCost: 0,
  unknownQty: 0,
  parkedKnownQty: 0,
  parkedKnownCost: 0,
  parkedUnknownQty: 0,
  borrowedUnsold: 0,
  shortQty: 0,
  shortProceeds: 0,
  shortUnknownQty: 0,
  longVia: null,
  shortVia: null,
  longOpenedAt: null,
  shortOpenedAt: null,
});

const EPS = 1e-12;
const longTotal = (b: Book) => b.knownQty + b.unknownQty + b.borrowedUnsold;

/** Remove `q` from the long inventory proportionally (average-cost method); returns the removed known qty / cost. */
function takeLong(b: Book, q: number): { knownQty: number; knownCost: number; unknownQty: number } {
  const inv = b.knownQty + b.unknownQty;
  if (inv <= EPS || q <= EPS) return { knownQty: 0, knownCost: 0, unknownQty: Math.max(0, q) };
  const f = Math.min(1, q / inv);
  const out = { knownQty: b.knownQty * f, knownCost: b.knownCost * f, unknownQty: b.unknownQty * f };
  b.knownQty -= out.knownQty;
  b.knownCost -= out.knownCost;
  b.unknownQty -= out.unknownQty;
  // Selling more than the book holds (history incomplete): the excess had an unknown cost.
  if (q > inv) out.unknownQty += q - inv;
  return out;
}

/** Reduce the short book by `q` tokens at its average (a buy-back + repay). */
function takeShort(b: Book, q: number) {
  const tot = b.shortQty + b.shortUnknownQty;
  if (tot <= EPS) return;
  const f = Math.min(1, q / tot);
  b.shortProceeds -= b.shortProceeds * f;
  b.shortQty -= b.shortQty * f;
  b.shortUnknownQty -= b.shortUnknownQty * f;
}

/**
 * Orders history rows oldest → newest, keeping each transaction's own event order (a "borrow then
 * swap" transaction must apply the borrow first). `fetchMarginHistory` sorts newest-first with a
 * stable sort, so rows of one signature are contiguous in event order.
 */
function chronological(rows: readonly MarginHistoryRow[]): MarginHistoryRow[] {
  const group = new Map<string, number>();
  const intra = new Map<MarginHistoryRow, number>();
  const counts = new Map<string, number>();
  rows.forEach((r) => {
    if (!group.has(r.signature)) group.set(r.signature, group.size);
    const n = counts.get(r.signature) ?? 0;
    intra.set(r, n);
    counts.set(r.signature, n + 1);
  });
  return [...rows].sort(
    (a, b) => a.timestamp - b.timestamp || group.get(b.signature)! - group.get(a.signature)! || intra.get(a)! - intra.get(b)!,
  );
}

/** Replays the history into one Book per token. Exported for scripts / tests. */
export function replaySpotHistory(rows: readonly MarginHistoryRow[]): Map<string, Book> {
  const books = new Map<string, Book>();
  const book = (s: string) => {
    let b = books.get(s);
    if (!b) books.set(s, (b = newBook()));
    return b;
  };
  const openLong = (b: Book, t: number) => {
    if (longTotal(b) <= EPS) b.longOpenedAt = t;
  };
  for (const r of chronological(rows)) {
    const amt = Number(r.amount) || 0;
    switch (r.type) {
      case 'liquidation':
        // Whole-account liquidation: every collateral seized, every debt repaid.
        books.clear();
        break;
      case 'deposit':
        if (!isSpotSymbol(r.symbol)) break;
        openLong(book(r.symbol), r.timestamp);
        book(r.symbol).unknownQty += amt;
        break;
      case 'withdraw':
        if (isSpotSymbol(r.symbol)) takeLong(book(r.symbol), amt);
        break;
      case 'farm-deposit':
        if (isSpotSymbol(r.symbol)) {
          const b = book(r.symbol);
          const t = takeLong(b, amt);
          b.parkedKnownQty += t.knownQty;
          b.parkedKnownCost += t.knownCost;
          b.parkedUnknownQty += t.unknownQty;
        }
        break;
      case 'farm-withdraw':
        if (isSpotSymbol(r.symbol)) {
          // The underlying comes back at the cost it left with; anything above that (Kamino yield,
          // or a deposit older than the scan) has no known cost.
          const b = book(r.symbol);
          openLong(b, r.timestamp);
          const parked = b.parkedKnownQty + b.parkedUnknownQty;
          const back = Math.min(amt, parked);
          const f = parked > EPS ? back / parked : 0;
          b.knownQty += b.parkedKnownQty * f;
          b.knownCost += b.parkedKnownCost * f;
          b.unknownQty += b.parkedUnknownQty * f + (amt - back);
          b.parkedKnownQty -= b.parkedKnownQty * f;
          b.parkedKnownCost -= b.parkedKnownCost * f;
          b.parkedUnknownQty -= b.parkedUnknownQty * f;
        }
        break;
      case 'borrow':
        if (isSpotSymbol(r.symbol)) {
          const b = book(r.symbol);
          openLong(b, r.timestamp);
          if (b.shortQty + b.shortUnknownQty + b.borrowedUnsold <= EPS) b.shortOpenedAt = r.timestamp;
          b.borrowedUnsold += amt;
        }
        break;
      case 'repay':
        if (isSpotSymbol(r.symbol)) {
          // Repay always pays from the margin vault: first the borrowed tokens never sold, then the
          // short (the tokens bought back sit in the long inventory and leave it now).
          const b = book(r.symbol);
          const a = Math.min(amt, b.borrowedUnsold);
          b.borrowedUnsold -= a;
          const rest = amt - a;
          if (rest > EPS) {
            takeShort(b, rest);
            takeLong(b, rest);
          }
        }
        break;
      case 'swap': {
        const from = r.symbol;
        const to = r.toSymbol ?? '';
        const spent = amt;
        const got = Number(r.toAmount) || 0;
        if (!from || !to || spent <= 0 || got <= 0) break;
        const fromStable = isStable(from);
        const toStable = isStable(to);
        // USD value of the spent side when the chain tells it exactly (a stablecoin leg, $1).
        let usdKnown: number | null = fromStable ? spent : toStable ? got : null;
        // Received-side cost basis carried from the spent token (volatile → volatile).
        let carriedKnownFrac = 1;
        if (isSpotSymbol(from)) {
          const b = book(from);
          // Borrowed tokens are sold first: that sale opens / grows the short.
          const fromBorrowed = Math.min(spent, b.borrowedUnsold);
          if (fromBorrowed > EPS) {
            b.borrowedUnsold -= fromBorrowed;
            if (usdKnown !== null) {
              b.shortQty += fromBorrowed;
              b.shortProceeds += (usdKnown * fromBorrowed) / spent;
            } else b.shortUnknownQty += fromBorrowed;
            if (r.via) b.shortVia = r.via;
          }
          const fromInv = spent - fromBorrowed;
          if (fromInv > EPS) {
            const t = takeLong(b, fromInv);
            if (usdKnown === null) {
              // Volatile → volatile: the received token inherits the spent tokens' known cost.
              const knownPart = fromInv > EPS ? t.knownQty / spent : 0;
              carriedKnownFrac = knownPart;
              usdKnown = t.knownQty > EPS ? (t.knownCost / t.knownQty) * spent : null;
            }
          } else if (usdKnown === null) carriedKnownFrac = 0;
        }
        if (isSpotSymbol(to)) {
          const b = book(to);
          openLong(b, r.timestamp);
          if (usdKnown !== null && carriedKnownFrac > EPS) {
            b.knownQty += got * carriedKnownFrac;
            b.knownCost += usdKnown * carriedKnownFrac;
            b.unknownQty += got * (1 - carriedKnownFrac);
          } else b.unknownQty += got;
          if (r.via) b.longVia = r.via;
        }
        break;
      }
      default:
        break;
    }
  }
  return books;
}

/** Pure: margin holdings + debts + history → spot positions. */
export function computeSpotPositions(input: SpotPositionsInput): SpotPosition[] {
  const books = replaySpotHistory(input.rows);
  const out: SpotPosition[] = [];
  const older = input.historyComplete ? '' : ' (older history was not scanned)';
  const liq = (sym: string, side: SpotSide, mark: number) => {
    const lp = input.liqPriceOf(sym, side);
    return { liqPrice: lp, liqDistancePct: lp !== null && mark > 0 ? ((lp - mark) / mark) * 100 : null };
  };

  for (const h of input.holdings) {
    if (!isSpotSymbol(h.symbol) || !(h.amount > 0)) continue;
    const b = books.get(h.symbol) ?? newBook();
    const mark = input.priceOf(h.symbol);
    // History may not match the vault exactly (interest dust, scan window): scale proportionally,
    // which keeps the average and the known / unknown split.
    const tracked = longTotal(b);
    const scale = tracked > EPS ? Math.min(1, h.amount / tracked) : 0;
    const explainedQty = Math.min(h.amount, b.knownQty * scale);
    const explainedAvg = b.knownQty > EPS ? b.knownCost / b.knownQty : null;
    const full = explainedAvg !== null && explainedQty >= h.amount * (1 - EXPLAIN_TOL);
    const source: SpotEntrySource = full ? 'swaps' : explainedQty > EPS ? 'partial' : 'deposit';
    const entry = full ? explainedAvg : null;
    const pnl = entry !== null && mark > 0 ? (mark - entry) * h.amount : null;
    out.push({
      id: `${h.symbol}-long`,
      symbol: h.symbol,
      side: 'long',
      qty: h.amount,
      mark,
      sizeUsd: h.amount * mark,
      entry,
      source,
      explainedQty,
      explainedAvg,
      pnl,
      pnlPct: pnl !== null && entry ? (pnl / (entry * h.amount)) * 100 : null,
      ...liq(h.symbol, 'long', mark),
      via: b.longVia,
      openedAt: tracked > EPS ? b.longOpenedAt : null,
      note:
        source === 'swaps'
          ? `Average price of the ${h.symbol} bought in your margin account's swaps.`
          : source === 'partial'
            ? `Only ${fmtQty(explainedQty)} of ${fmtQty(h.amount)} ${h.symbol} was bought through swaps here (avg $${fmtPx(explainedAvg)}); the rest was deposited or borrowed${older}, so there is no single entry price.`
            : `This ${h.symbol} was deposited (or borrowed), not bought through a swap${older}, so the chain has no entry price for it.`,
    });
  }

  for (const d of input.debts) {
    if (!isSpotSymbol(d.symbol) || !(d.amount > 0)) continue;
    const b = books.get(d.symbol) ?? newBook();
    const mark = input.priceOf(d.symbol);
    const explainedAvg = b.shortQty > EPS ? b.shortProceeds / b.shortQty : null;
    const explainedQty = Math.min(d.amount, b.shortQty);
    // The debt grows with interest, so a sold amount slightly under the debt still explains it.
    const full = explainedAvg !== null && explainedQty >= d.amount * (1 - EXPLAIN_TOL * 2);
    const source: SpotEntrySource = full ? 'swaps' : explainedQty > EPS ? 'partial' : b.borrowedUnsold > EPS ? 'unsold' : 'deposit';
    const entry = full ? explainedAvg : null;
    const pnl = entry !== null && mark > 0 ? (entry - mark) * d.amount : null;
    out.push({
      id: `${d.symbol}-short`,
      symbol: d.symbol,
      side: 'short',
      qty: d.amount,
      mark,
      sizeUsd: d.amount * mark,
      entry,
      source,
      explainedQty,
      explainedAvg,
      pnl,
      pnlPct: pnl !== null && entry ? (pnl / (entry * d.amount)) * 100 : null,
      ...liq(d.symbol, 'short', mark),
      via: b.shortVia,
      openedAt: b.shortOpenedAt,
      note:
        source === 'swaps'
          ? `Average price the borrowed ${d.symbol} was sold at in your margin account's swaps.`
          : source === 'partial'
            ? `Only ${fmtQty(explainedQty)} of the ${fmtQty(d.amount)} ${d.symbol} owed was sold through swaps here (avg $${fmtPx(explainedAvg)}); the rest is still held or older than the scanned history.`
            : source === 'unsold'
              ? `The borrowed ${d.symbol} hasn't been sold through a swap yet (it is still in the account), so there is no short entry.`
              : `No sale of borrowed ${d.symbol} in the scanned history${older}, so there is no entry price.`,
    });
  }

  // Largest first.
  return out.sort((a, b) => b.sizeUsd - a.sizeUsd);
}

const fmtQty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 2 : 6 });
const fmtPx = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 2 : 4 }));

export interface SpotPositionsResult {
  positions: SpotPosition[];
  /** Still loading the margin account or its history. */
  loading: boolean;
  /** History scan reached the wallet's first signature (otherwise older entries are unknown). */
  historyComplete: boolean;
  /** The swap rows (newest first) — the Spot page's Position History. */
  swaps: MarginHistoryRow[];
}

/**
 * Spot positions of the connected wallet's margin account (see the module comment). Re-computes on
 * every margin refresh / ledger tick; works on any page (it loads the margin account itself).
 */
export function useSpotPositions(): SpotPositionsResult {
  const address = useUserStore((s) => s.address);
  const acct = useV3Account();
  const { history, rows, isLoading } = useMarginHistory();
  const snapshot = useMarginAccountInfoStore((s) => s.snapshot);
  const owner = useMarginAccountInfoStore((s) => s.ownerAddress);

  // Token amounts come from the margin store's snapshot; load it when this page didn't yet.
  useEffect(() => {
    if (address && (owner !== address || !snapshot)) void refreshMarginAccount(address);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const { priceOf, liqPriceOf, state } = acct;
  const positions = useMemo(() => {
    if (!address || !snapshot || snapshot.owner !== address || !snapshot.exists) return [];
    return computeSpotPositions({
      rows,
      historyComplete: history?.complete ?? false,
      holdings: snapshot.collateral.filter((c) => c.amount > 0).map((c) => ({ symbol: c.symbol, amount: c.amount })),
      debts: snapshot.debts.filter((d) => d.debt > 0).map((d) => ({ symbol: d.symbol, amount: d.debt })),
      priceOf,
      liqPriceOf,
    });
    // priceOf / liqPriceOf are re-created every render; `state` + `acct.view` are what they read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, snapshot, rows, history?.complete, state, acct.view]);

  const swaps = useMemo(() => rows.filter((r) => r.type === 'swap'), [rows]);
  return {
    positions,
    loading: Boolean(address) && (isLoading || !snapshot || acct.loading),
    historyComplete: history?.complete ?? false,
    swaps,
  };
}
