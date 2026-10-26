"use client";

/**
 * Live Phoenix market data for the Perps terminal, straight from Phoenix's public API (no key, CORS
 * open): https://docs.phoenix.trade/api/websocket.
 *
 * One WebSocket shared by every hook instance (kept 10 s after the last one unmounts):
 * - `market` for every listed symbol → mark / oracle / mid price, 24h change, 24h volume, open
 *   interest, hourly funding (header, pair menu, the order maths);
 * - `orderbook`, `trades` and `candles` for the focused symbol only.
 * REST seeds what the socket only streams from now on: the last fills and the candle history.
 *
 * Trading itself runs on Vanna's fork, whose Phoenix book is re-copied from mainnet right before each
 * order (lib/solana/perps.ts) — so this live mainnet book is the one an order actually fills against.
 */
import { useEffect, useRef, useState } from "react";

const API = "https://perp-api.phoenix.trade";
const WS_URL = "wss://perp-api.phoenix.trade/v1/ws";
/** The orderbook streams many updates a second; the UI repaints it at most this often. */
const BOOK_FLUSH_MS = 250;
const MAX_TRADES = 40;
const CANDLE_LIMIT = 120;

export interface PhoenixMarketStats {
  markPx: number;
  oraclePx: number;
  midPx: number;
  /** Price 24 hours ago (for the 24h change). */
  prevDayPx: number;
  /** 24h notional volume, USD. */
  dayNtlVlm: number;
  /** Open interest in base units (tokens). */
  openInterest: number;
  /** Current hourly funding rate, percent (positive: longs pay shorts). */
  funding: number;
}

/** [price, size in base units]. Bids best (highest) first, asks best (lowest) first. */
export type BookLevel = [number, number];

export interface PhoenixBook {
  bids: BookLevel[];
  asks: BookLevel[];
}

export interface PhoenixTrade {
  id: string;
  price: number;
  size: number;
  /** Taker bought (lifted an ask). */
  buy: boolean;
  /** Unix ms. */
  time: number;
}

export interface Candle {
  /** Open time, unix ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Phoenix candle timeframes, as the API names them. */
export const PHOENIX_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type PhoenixTimeframe = (typeof PHOENIX_TIMEFRAMES)[number];

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function toStats(m: Record<string, unknown>): PhoenixMarketStats {
  return {
    markPx: num(m.markPx),
    oraclePx: num(m.oraclePx),
    midPx: num(m.midPx),
    prevDayPx: num(m.prevDayPx),
    dayNtlVlm: num(m.dayNtlVlm),
    openInterest: num(m.openInterest),
    funding: num(m.funding),
  };
}

function toLevels(rows: unknown, desc: boolean): BookLevel[] {
  if (!Array.isArray(rows)) return [];
  const out = rows
    .map((r) => (Array.isArray(r) ? ([num(r[0]), num(r[1])] as BookLevel) : null))
    .filter((r): r is BookLevel => r !== null && r[0] > 0 && r[1] > 0);
  return out.sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]));
}

/** Candle time arrives in ms from REST and in seconds from the socket. */
const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);

function toCandle(c: Record<string, unknown>): Candle {
  return { t: toMs(num(c.time)), o: num(c.open), h: num(c.high), l: num(c.low), c: num(c.close) };
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Phoenix ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

async function fetchCandles(symbol: string, tf: PhoenixTimeframe): Promise<Candle[]> {
  const rows = await fetchJson<Record<string, unknown>[]>(`/v1/candles/${symbol}?timeframe=${tf}&limit=${CANDLE_LIMIT}`);
  return rows.map(toCandle).filter((c) => c.o > 0).sort((a, b) => a.t - b.t);
}

async function fetchFills(symbol: string): Promise<PhoenixTrade[]> {
  const body = await fetchJson<{ data?: Record<string, unknown>[] }>(`/v1/trades/${symbol}/fills?limit=${MAX_TRADES}`);
  return (body.data ?? []).map((f, i) => {
    const base = num(f.baseQty);
    return {
      id: `${String(f.transactionSignature ?? "")}-${i}`,
      price: num(f.price),
      size: Math.abs(base),
      buy: base > 0,
      time: Date.parse(String(f.timestamp ?? "")) || 0,
    };
  });
}

type Subscription = Record<string, string>;
type Message = Record<string, unknown>;

/** How long the socket stays open with no listener, so a remount (market change) reuses it. */
const IDLE_CLOSE_MS = 10_000;
/** How long an unheld channel stays subscribed, so a remount keeps it. */
const UNSUBSCRIBE_GRACE_MS = 1_000;

/**
 * One shared socket for every hook instance. Subscriptions are ref-counted: switching market or
 * timeframe unsubscribes the old channels and subscribes the new ones on the open socket instead
 * of reconnecting. All active subscriptions are re-sent on every (re)connect.
 */
const phoenix = {
  ws: null as WebSocket | null,
  subs: new Map<string, { sub: Subscription; n: number; release: ReturnType<typeof setTimeout> | null }>(),
  listeners: new Set<(m: Message) => void>(),
  statusListeners: new Set<(open: boolean) => void>(),
  retry: 0,
  retryTimer: null as ReturnType<typeof setTimeout> | null,
  idleTimer: null as ReturnType<typeof setTimeout> | null,
};

const isOpen = () => phoenix.ws?.readyState === WebSocket.OPEN;

function sendSub(type: "subscribe" | "unsubscribe", subscription: Subscription) {
  if (isOpen()) phoenix.ws!.send(JSON.stringify({ type, subscription }));
}

function setOpen(open: boolean) {
  for (const l of phoenix.statusListeners) l(open);
}

function connectPhoenix() {
  if (phoenix.ws) return;
  const ws = new WebSocket(WS_URL);
  phoenix.ws = ws;
  ws.onopen = () => {
    phoenix.retry = 0;
    for (const { sub } of phoenix.subs.values()) sendSub("subscribe", sub);
    setOpen(true);
  };
  ws.onmessage = (event) => {
    let m: Message;
    try {
      m = JSON.parse(String(event.data));
    } catch {
      return;
    }
    for (const l of phoenix.listeners) l(m);
  };
  ws.onclose = () => {
    if (phoenix.ws !== ws) return;
    phoenix.ws = null;
    setOpen(false);
    if (phoenix.listeners.size === 0) return;
    phoenix.retry += 1;
    phoenix.retryTimer = setTimeout(() => {
      phoenix.retryTimer = null;
      if (phoenix.listeners.size > 0) connectPhoenix();
    }, Math.min(15_000, 1_000 * 2 ** Math.min(phoenix.retry, 4)));
  };
  ws.onerror = () => ws.close();
}

function addPhoenixListener(onMessage: (m: Message) => void, onStatus: (open: boolean) => void): () => void {
  if (phoenix.idleTimer) clearTimeout(phoenix.idleTimer);
  phoenix.idleTimer = null;
  phoenix.listeners.add(onMessage);
  phoenix.statusListeners.add(onStatus);
  connectPhoenix();
  return () => {
    phoenix.listeners.delete(onMessage);
    phoenix.statusListeners.delete(onStatus);
    if (phoenix.listeners.size > 0) return;
    phoenix.idleTimer = setTimeout(() => {
      phoenix.idleTimer = null;
      if (phoenix.listeners.size > 0) return;
      if (phoenix.retryTimer) clearTimeout(phoenix.retryTimer);
      phoenix.retryTimer = null;
      const ws = phoenix.ws;
      phoenix.ws = null;
      ws?.close();
    }, IDLE_CLOSE_MS);
  };
}

/** Holds `subs` on the shared socket until the returned release is called. */
function holdSubscriptions(subs: Subscription[]): () => void {
  for (const sub of subs) {
    const key = JSON.stringify(sub);
    const entry = phoenix.subs.get(key);
    if (entry) {
      entry.n += 1;
      if (entry.release) clearTimeout(entry.release);
      entry.release = null;
    } else {
      phoenix.subs.set(key, { sub, n: 1, release: null });
      sendSub("subscribe", sub);
    }
  }
  return () => {
    for (const sub of subs) {
      const key = JSON.stringify(sub);
      const entry = phoenix.subs.get(key);
      if (!entry) continue;
      entry.n -= 1;
      if (entry.n > 0) continue;
      // A remount re-holds within the grace period, so its channels are never dropped.
      entry.release = setTimeout(() => {
        if (entry.n > 0 || phoenix.subs.get(key) !== entry) return;
        phoenix.subs.delete(key);
        sendSub("unsubscribe", sub);
      }, UNSUBSCRIBE_GRACE_MS);
    }
  };
}

export interface PhoenixLive {
  /** Live stats per symbol ("SOL", "ETH", …); missing until the first message. */
  stats: Record<string, PhoenixMarketStats>;
  book: PhoenixBook | null;
  trades: PhoenixTrade[];
  candles: Candle[];
  /** The socket is open and subscribed. */
  connected: boolean;
}

/**
 * Subscribes to Phoenix for `symbols` (market stats) and `focus` (book, trades, `timeframe` candles).
 * Changing market or timeframe swaps subscriptions on the shared socket; it reconnects with backoff
 * when the socket drops.
 */
export function usePhoenixLive(symbols: string[], focus: string, timeframe: PhoenixTimeframe): PhoenixLive {
  const [stats, setStats] = useState<Record<string, PhoenixMarketStats>>({});
  // Focused-market data is tagged with the market (and timeframe) it belongs to, so switching market
  // shows nothing stale while the new data loads.
  const [book, setBook] = useState<{ key: string; book: PhoenixBook } | null>(null);
  const [trades, setTrades] = useState<{ key: string; rows: PhoenixTrade[] }>({ key: "", rows: [] });
  const [candles, setCandles] = useState<{ key: string; rows: Candle[] }>({ key: "", rows: [] });
  const [connected, setConnected] = useState(() => typeof WebSocket !== "undefined" && isOpen());
  const symbolsKey = symbols.join(",");
  const candleKey = `${focus}:${timeframe}`;

  // REST seeds for the focused market.
  useEffect(() => {
    let alive = true;
    fetchFills(focus)
      .then((rows) => alive && setTrades((prev) => (prev.key === focus && prev.rows.length ? prev : { key: focus, rows })))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [focus]);
  useEffect(() => {
    let alive = true;
    fetchCandles(focus, timeframe)
      .then((rows) => alive && setCandles({ key: `${focus}:${timeframe}`, rows }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [focus, timeframe]);

  const pendingBook = useRef<{ key: string; book: PhoenixBook } | null>(null);
  useEffect(() => {
    const id = setInterval(() => {
      if (pendingBook.current) {
        setBook(pendingBook.current);
        pendingBook.current = null;
      }
    }, BOOK_FLUSH_MS);
    return () => clearInterval(id);
  }, []);

  // Message handling for the focused market; re-registering never touches the socket.
  useEffect(() => {
    pendingBook.current = null;
    return addPhoenixListener((m) => {
      const symbol = String(m.symbol ?? "");
      switch (m.channel) {
        case "market":
          if (symbol) setStats((prev) => ({ ...prev, [symbol]: toStats(m) }));
          break;
        case "orderbook": {
          if (symbol !== focus) break;
          const ob = (m.orderbook ?? m) as Record<string, unknown>;
          pendingBook.current = { key: focus, book: { bids: toLevels(ob.bids, true), asks: toLevels(ob.asks, false) } };
          break;
        }
        case "trades": {
          if (symbol !== focus || !Array.isArray(m.trades)) break;
          const fresh = (m.trades as Record<string, unknown>[]).map((t) => {
            const base = num(t.baseAmount);
            return {
              id: String(t.tradeSequenceNumber ?? `${t.slot}-${t.slotIndex}`),
              price: base > 0 ? num(t.quoteAmount) / base : 0,
              size: base,
              buy: t.side === "bid",
              time: toMs(num(t.timestamp)),
            };
          });
          setTrades((prev) => ({ key: focus, rows: [...fresh.filter((t) => t.price > 0).reverse(), ...(prev.key === focus ? prev.rows : [])].slice(0, MAX_TRADES) }));
          break;
        }
        case "candle": {
          if (symbol !== focus || m.timeframe !== timeframe || !m.candle) break;
          const c = toCandle(m.candle as Record<string, unknown>);
          setCandles((prev) => {
            const rows = prev.rows;
            if (prev.key !== `${focus}:${timeframe}` || rows.length === 0) return prev;
            const last = rows[rows.length - 1];
            if (c.t === last.t) return { ...prev, rows: [...rows.slice(0, -1), c] };
            if (c.t > last.t) return { ...prev, rows: [...rows.slice(1), c] };
            return prev;
          });
          break;
        }
      }
    }, setConnected);
  }, [focus, timeframe]);

  // Channels held on the shared socket: a change swaps subscriptions instead of reconnecting.
  useEffect(() => holdSubscriptions((symbolsKey ? symbolsKey.split(",") : []).map((symbol) => ({ channel: "market", symbol }))), [symbolsKey]);
  useEffect(
    () => holdSubscriptions([{ channel: "market", symbol: focus }, { channel: "orderbook", symbol: focus }, { channel: "trades", symbol: focus }]),
    [focus],
  );
  useEffect(() => holdSubscriptions([{ channel: "candles", symbol: focus, timeframe }]), [focus, timeframe]);

  return {
    stats,
    book: book?.key === focus ? book.book : null,
    trades: trades.key === focus ? trades.rows : [],
    candles: candles.key === candleKey ? candles.rows : [],
    connected,
  };
}

/**
 * Walks the book for a market order of `qty` base units: the average fill price and whether the
 * whole size fills inside `limit` (the slippage bound). Longs take asks, shorts take bids.
 */
export function walkBook(book: PhoenixBook | null, buy: boolean, qty: number, limit: number): { avgPrice: number | null; fills: boolean } {
  const levels = book ? (buy ? book.asks : book.bids) : [];
  if (!(qty > 0) || levels.length === 0) return { avgPrice: levels[0]?.[0] ?? null, fills: qty <= 0 };
  let left = qty;
  let cost = 0;
  for (const [price, size] of levels) {
    if (left <= 1e-12) break;
    if (buy ? price > limit : price < limit) break;
    const take = Math.min(left, size);
    cost += take * price;
    left -= take;
  }
  const got = qty - left;
  return { avgPrice: got > 0 ? cost / got : levels[0][0], fills: left <= qty * 1e-9 };
}
