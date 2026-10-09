"use client";

/** The live Phoenix order book and trades column (asks above, bids below; market orders fill against it). */
import { nf, price, tokAmt, upDn } from "./format";
import type { PhoenixBook, PhoenixTrade } from "./use-phoenix-live";
import { Img, Info, PHOENIX_ICON, SideIcon } from "./ui";

const ROWS = 10;

/** Price decimals from the book's own tick (e.g. 0.1 → 1, 0.01 → 2). */
function priceDecimals(book: PhoenixBook | null, mark: number): number {
  const ps = [...(book?.asks ?? []), ...(book?.bids ?? [])].slice(0, 20).map((l) => l[0]);
  let d = 0;
  for (const p of ps) {
    const s = String(p);
    const frac = s.includes(".") ? s.split(".")[1].length : 0;
    d = Math.max(d, Math.min(frac, 4));
  }
  return ps.length ? d : mark >= 1000 ? 1 : 2;
}

export function OrderBook({
  marketKey,
  book,
  trades,
  mark,
  change,
  tab,
  onTab,
  onHide,
  connected,
}: {
  marketKey: string;
  book: PhoenixBook | null;
  trades: PhoenixTrade[];
  mark: number | null;
  change: number | null;
  tab: "book" | "trades";
  onTab: (t: "book" | "trades") => void;
  onHide: () => void;
  connected: boolean;
}) {
  const d = priceDecimals(book, mark ?? 0);
  return (
    <section className="px-pnl px-book" aria-label="Phoenix order book">
      <div className="px-bk-tabs" role="tablist">
        {(
          [
            ["book", "Order book"],
            ["trades", "Trades"],
          ] as const
        ).map(([v, l]) => (
          <button key={v} type="button" className={tab === v ? "on" : ""} role="tab" aria-selected={tab === v} onClick={() => onTab(v)}>
            {l}
          </button>
        ))}
        <span className="px-bk-src" title={connected ? "Live from Phoenix" : "Reconnecting to Phoenix…"}>
          <i className={`px-live ${connected ? "on" : ""}`} />
          <Img src={PHOENIX_ICON} className="px-bk-ic" />
          <Info text={`Live Phoenix order book for ${marketKey}-PERP: asks above, bids below; market orders fill against it.`} placement="bottom" />
        </span>
        <button type="button" className="px-bk-hide" aria-pressed="true" aria-label="Hide the order book" onClick={onHide}>
          <SideIcon />
        </button>
      </div>
      {tab === "book" ? <BookRows marketKey={marketKey} book={book} mark={mark} change={change} d={d} /> : <TradeRows marketKey={marketKey} trades={trades} d={d} />}
    </section>
  );
}

function BookRows({ marketKey, book, mark, change, d }: { marketKey: string; book: PhoenixBook | null; mark: number | null; change: number | null; d: number }) {
  const asks = (book?.asks ?? []).slice(0, ROWS);
  const bids = (book?.bids ?? []).slice(0, ROWS);
  const cumulative = (levels: [number, number][]) => {
    const out: { p: number; s: number; c: number }[] = [];
    for (const [p, s] of levels) out.push({ p, s, c: (out[out.length - 1]?.c ?? 0) + s });
    return out;
  };
  const ar = cumulative(asks);
  const br = cumulative(bids);
  const max = Math.max(ar[ar.length - 1]?.c ?? 0, br[br.length - 1]?.c ?? 0) || 1;
  const spread = asks.length && bids.length ? asks[0][0] - bids[0][0] : null;
  const mid = asks.length && bids.length ? (asks[0][0] + bids[0][0]) / 2 : mark;
  const row = (l: { p: number; s: number; c: number }, cls: "a" | "b") => (
    <div key={`${cls}${l.p}`} className={`px-bk-r ${cls}`} style={{ ["--w" as string]: `${((l.c / max) * 100).toFixed(1)}%` }}>
      <span>{nf(l.p, d)}</span>
      <span>{tokAmt(l.s, marketKey)}</span>
      <span>{tokAmt(l.c, marketKey)}</span>
    </div>
  );
  return (
    <>
      <div className="px-bk-h">
        <span>Price</span>
        <span>Size ({marketKey})</span>
        <span>Total</span>
      </div>
      <div className="px-bk num">
        <div className="px-bk-side asks">{ar.slice().reverse().map((l) => row(l, "a"))}</div>
        <div className="px-bk-mid">
          <b className={change === null ? "" : upDn(change)}>{price(mark || 0)}</b>
          <span>{spread !== null && mid ? `Spread ${nf(spread, d)} · ${nf((spread / mid) * 100, 3)}%` : book ? "No liquidity" : "Loading…"}</span>
        </div>
        <div className="px-bk-side bids">{br.map((l) => row(l, "b"))}</div>
      </div>
    </>
  );
}

function TradeRows({ marketKey, trades, d }: { marketKey: string; trades: PhoenixTrade[]; d: number }) {
  const tm = (t: number) => {
    const x = new Date(t);
    return [x.getHours(), x.getMinutes(), x.getSeconds()].map((v) => String(v).padStart(2, "0")).join(":");
  };
  return (
    <>
      <div className="px-bk-h">
        <span>Price</span>
        <span>Size ({marketKey})</span>
        <span>Time</span>
      </div>
      <div className="px-tr num">
        {trades.length === 0 && <div className="px-bk-r"><span className="px-mut">Loading…</span></div>}
        {trades.slice(0, 23).map((t) => (
          <div key={t.id} className="px-bk-r">
            <span className={t.buy ? "px-up" : "px-dn"}>{nf(t.price, d)}</span>
            <span>{tokAmt(t.size, marketKey)}</span>
            <span className="px-mut">{tm(t.time)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
