"use client";

/**
 * Order panel: Long / Short, market order with a slippage dropdown, collateral (USDC from the margin
 * account) with a % slider, position size in tokens or USD, leverage, the Phoenix order preview and
 * "Margin account · after this order".
 *
 * Sizing mirrors lib/solana/perps.ts `openPerp` exactly: the limit price is Phoenix's mark ± slippage
 * and the order is collateral × leverage ÷ limit base units; the estimated entry walks the live
 * Phoenix book for that size.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { PerpMarketInfo, PerpSide } from "@/lib/solana/perps-types";
import { defaultSlippageBps } from "@/lib/solana/perps";
import type { AccountNumbers, LiqRoom, ModelState } from "./account-model";
import { LIQ_HF, SAFE_HF, WARN_HF, accountNumbers, hfPos, hfZone, liqRoom, positionLiqPrice, withOrder } from "./account-model";
import { hfFmt, levFmt, nf, price, roomSub, roomText, roomZone, tokAmt, usd } from "./format";
import type { PhoenixBook } from "./use-phoenix-live";
import { walkBook } from "./use-phoenix-live";
import { Arrow, Chev, Go, Img, Info, MinusIcon, PHOENIX_ICON, PlusIcon, Slider, VANNA_ICON, WarnIcon } from "./ui";

const SLIPS = [0.5, 1, 2];
const sideTxt = (s: PerpSide) => (s === "long" ? "Long" : "Short");
const levTxt = (x: number) => String(+x.toFixed(1));
/** Collateral input: digits and one dot, at most 6 decimals. */
const cleanAmt = (v: string) => {
  const raw = v.replace(/[^0-9.]/g, "");
  const [w, ...rest] = raw.split(".");
  return rest.length ? `${w}.${rest.join("").slice(0, 6)}` : w;
};

export interface OrderPanelProps {
  marketKey: string;
  market: PerpMarketInfo | undefined;
  /** Phoenix mark price (live), USD. */
  mark: number | null;
  book: PhoenixBook | null;
  connected: boolean;
  hasMargin: boolean;
  available: number;
  state: ModelState | null;
  now: AccountNumbers | null;
  room0: LiqRoom | null;
  /** The open position in this market, if any. */
  existing: { side: PerpSide } | null;
  placing: boolean;
  onConnect: () => void;
  onPlace: (req: { side: PerpSide; collateral: number; leverage: number; slippageBps: number }) => Promise<unknown>;
  open: string | null;
  toggle: (id: string) => void;
  close: () => void;
}

export function OrderPanel(p: OrderPanelProps) {
  const router = useRouter();
  const [side, setSide] = useState<PerpSide>("long");
  const [coll, setColl] = useState<string>("");
  const [lev, setLev] = useState(3);
  const [unit, setUnit] = useState<"tok" | "usd">("tok");
  /** What the user is typing in the size box (kept as typed while it has focus). */
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const [slipFor, setSlipFor] = useState(p.marketKey);
  const [slip, setSlip] = useState(() => defaultSlippageBps(p.marketKey) / 100);
  if (slipFor !== p.marketKey) {
    setSlipFor(p.marketKey);
    setSlip(defaultSlippageBps(p.marketKey) / 100);
  }
  const K = p.marketKey;
  const maxLev = p.market?.maxLeverage ?? 1;
  const clampLev = (v: number) => Math.min(maxLev, Math.max(1, Math.round(v * 2) / 2));
  const L = clampLev(lev);
  const live = p.connected && p.hasMargin;
  const takerFee = p.market?.takerFee ?? 0;

  const o = useMemo(() => {
    const mark = p.mark ?? p.market?.markPrice ?? 0;
    const index = p.market?.indexPrice ?? mark;
    const c = Number(coll) || 0;
    const limit = mark * (1 + ((side === "long" ? 1 : -1) * slip) / 100);
    const qty = limit > 0 ? (c * L) / limit : 0;
    const f = walkBook(p.book, side === "long", qty, limit);
    const entry = f.avgPrice ?? mark;
    const notional = qty * entry;
    const fee = notional * takerFee;
    const ok = live && c > 0 && c <= p.available + 1e-9 && p.state !== null;
    const sim = ok ? withOrder(p.state!, { key: K, side, qty, entry, index, collateral: c, takerFee }) : null;
    const after = sim ? accountNumbers(sim) : null;
    return {
      mark,
      c,
      limit,
      qty,
      notional,
      fee,
      entry,
      fills: f.fills,
      ok,
      after,
      room1: sim ? liqRoom(sim) : null,
      liq: sim ? positionLiqPrice(sim, K, side) : null,
      // The live page's zero-equity price: where this order's own collateral is used up (fees aside).
      ze: c > 0 && mark > 0 ? (side === "long" ? mark * (1 - 1 / L) : mark * (1 + 1 / L)) : null,
    };
  }, [p.mark, p.market, p.book, p.available, p.state, coll, side, slip, L, live, K, takerFee]);

  const collPct = live && p.available > 0 ? Math.min(100, Math.round((o.c / p.available) * 100)) : 0;
  const setFromPct = (pct: number) => {
    if (!live) return;
    const v = Math.floor(p.available * pct) / 100;
    setColl(v > 0 ? String(v) : "");
  };
  const setFromSize = (raw: string) => {
    const n = Number(cleanAmt(raw)) || 0;
    // Tokens: collateral = qty × limit ÷ leverage, so the order is exactly that many tokens.
    const notional = unit === "usd" ? n : n * o.limit;
    setColl(n > 0 ? String(Math.round((notional / L) * 100) / 100) : "");
  };

  const cta = (() => {
    if (!p.connected) return { label: "Connect wallet", cls: "grad", act: p.onConnect };
    if (!p.hasMargin) return { label: "Create a margin account first", dis: true, link: true };
    if (!p.market?.tradingEnabled) return { label: `${K}-PERP is closed for new positions`, dis: true };
    if (!(o.c > 0)) return { label: "Enter collateral", dis: true };
    if (o.c > p.available + 1e-9) return { label: "Insufficient margin USDC", dis: true, borrow: true };
    if (!o.fills) return { label: `No fill within ${slip}% — reduce size`, dis: true };
    if (o.after && o.after.hf < SAFE_HF) return { label: `Health factor would fall below ${nf(SAFE_HF, 2)}`, dis: true };
    return { label: `${sideTxt(side)} ${K} ${levTxt(L)}x`, cls: side, act: () => void place(), warn: Boolean(o.after && o.after.hf < WARN_HF) };
  })();

  async function place() {
    try {
      await p.onPlace({ side, collateral: o.c, leverage: L, slippageBps: Math.round(slip * 100) });
      setColl("");
    } catch {
      // the tx toast already shows the error
    }
  }

  const sizeVal = o.c > 0 ? (unit === "usd" ? nf(o.notional, 2) : tokAmt(o.qty, K)) : "";
  const sizeSub = o.c > 0 ? (unit === "usd" ? `~${tokAmt(o.qty, K)} ${K}` : `~${usd(o.notional)}`) : "Enter collateral";
  const limLabel = side === "long" ? "Max. entry price" : "Min. entry price";
  const now = p.now;
  const a1 = o.after;
  const hz = (h: number) => hfZone(h);

  return (
    <form className="px-pnl px-op" onSubmit={(e) => e.preventDefault()} aria-label="Place a perp order">
      <div className="px-ls" role="tablist" aria-label="Side">
        {(["long", "short"] as const).map((s) => (
          <button key={s} type="button" className={`${s} ${side === s ? "on" : ""}`} role="tab" aria-selected={side === s} onClick={() => setSide(s)}>
            {sideTxt(s)}
          </button>
        ))}
      </div>

      <div className="px-ot">
        <span className="px-ot-on">Market</span>
        <span className="px-ot-off">
          Limit<span className="px-soon">Soon</span>
          <Info text="Limit orders are coming; today Vanna places market orders on Phoenix." />
        </span>
        <span className="px-slip-w px-rel" data-pop="px-slip">
          <button type="button" className="px-slip" onClick={() => p.toggle("px-slip")} aria-haspopup="listbox" aria-expanded={p.open === "px-slip"}>
            Slippage <b>{slip}%</b>
            <Chev small up={p.open === "px-slip"} />
          </button>
          {p.open === "px-slip" && (
            <div className="px-pop r px-slipm" role="listbox" aria-label="Max slippage">
              <p>Max price move before the order is canceled</p>
              {SLIPS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`px-sm ${slip === s ? "on" : ""}`}
                  role="option"
                  aria-selected={slip === s}
                  onClick={() => {
                    setSlip(s);
                    p.close();
                  }}
                >
                  <span>{s}%</span>
                  <span className="px-mut">
                    {side === "long" ? "Max" : "Min"} ${price(o.mark * (1 + ((side === "long" ? 1 : -1) * s) / 100))}
                  </span>
                </button>
              ))}
            </div>
          )}
        </span>
      </div>

      <div className="px-grp">
        <div className="px-lr">
          <label htmlFor="px-coll">
            Collateral <Info text={`The USDC this order takes from your margin account; ${K} is what you trade, not what you post.`} />
          </label>
          <span className="px-avl">
            <span className="px-mut">
              Available <b className="num">{nf(live ? p.available : 0, 2)} USDC</b>
            </span>
            {live && (
              <button type="button" className="px-borrow" aria-label="Borrow more USDC" onClick={() => router.push("/margin")}>
                <PlusIcon />
                Borrow
              </button>
            )}
          </span>
        </div>
        <div className="px-in">
          <input id="px-coll" inputMode="decimal" autoComplete="off" placeholder="Enter amount" value={coll} onChange={(e) => setColl(cleanAmt(e.target.value))} aria-label="Collateral in USDC" />
          <button type="button" className="px-max" disabled={!(live && p.available > 0)} onClick={() => setColl(String(Math.floor(p.available * 100) / 100))}>
            MAX
          </button>
          <span className="px-tok">
            <Img src="/coins/usdc.svg" className="px-tok-ic" />
            USDC
          </span>
        </div>
        <Slider id="pct" value={collPct} min={0} max={100} step={1} marks={[0, 25, 50, 75, 100]} label={(v) => `${v}%`} aria="Collateral, % of available" onChange={setFromPct} disabled={!live} />
      </div>

      <div className="px-size">
        <div className="px-size-l">
          <label htmlFor="px-size">
            Position size <Info text={`Collateral × leverage, in ${K} or USD; typing a size sets the collateral for you.`} />
          </label>
          <small className="num">{sizeSub}</small>
        </div>
        <div className="px-size-r">
          <input
            id="px-size"
            className="num"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={sizeDraft ?? sizeVal}
            onFocus={() => setSizeDraft(sizeVal.replace(/,/g, ""))}
            onBlur={() => setSizeDraft(null)}
            onChange={(e) => {
              const v = cleanAmt(e.target.value);
              setSizeDraft(v);
              setFromSize(v);
            }} aria-label={`Position size in ${unit === "usd" ? "USD" : K}`} />
          <span className="px-unit" role="group" aria-label="Size unit">
            {(
              [
                ["tok", K],
                ["usd", "USD"],
              ] as const
            ).map(([v, l]) => (
              <button key={v} type="button" className={unit === v ? "on" : ""} aria-pressed={unit === v} onClick={() => setUnit(v)}>
                {l}
              </button>
            ))}
          </span>
        </div>
      </div>

      <div className="px-grp">
        <div className="px-lr">
          <label>
            Order leverage <Info text={`Position size divided by the collateral of this order (up to ${maxLev}x on ${K}-PERP).`} />
          </label>
          <span className="px-step">
            <button type="button" aria-label="Lower leverage" disabled={L <= 1} onClick={() => setLev(clampLev(L - 0.5))}>
              <MinusIcon />
            </button>
            <b className="num">{levTxt(L)}x</b>
            <button type="button" aria-label="Raise leverage" disabled={L >= maxLev} onClick={() => setLev(clampLev(L + 0.5))}>
              <PlusIcon />
            </button>
          </span>
        </div>
        <Slider
          id="lev"
          value={L}
          min={1}
          max={Math.max(2, maxLev)}
          step={0.5}
          marks={Array.from({ length: Math.max(2, maxLev) }, (_, i) => i + 1)}
          label={(v) => `${v}x`}
          aria="Leverage"
          onChange={(v) => setLev(clampLev(v))}
        />
      </div>

      <div className="px-od num">
        <div className="px-od-t">
          <Img src={PHOENIX_ICON} className="px-od-ic" />
          Order on Phoenix
        </div>
        <Row k="Est. entry price" tip="The average price this size fills at on the live Phoenix order book." v={o.mark ? `~$${price(o.c > 0 ? o.entry : o.mark)}` : "—"} />
        <Row k={limLabel} tip={`The worst price the order accepts with ${slip}% slippage; beyond it nothing fills.`} v={o.mark ? `$${price(o.limit)}` : "—"} />
        <Row
          k="Liq. price (est.)"
          tip={`The ${K} index price, moving against this ${side}, at which the whole margin account would be liquidated (None: the rest of the account covers it).`}
          v={
            !o.after ? (
              "—"
            ) : o.liq ? (
              <>
                ${price(o.liq)}
                <small className={`px-dist ${Math.abs((o.liq / o.mark - 1) * 100) < 10 ? "near" : ""}`}>
                  {(o.liq / o.mark - 1) * 100 >= 0 ? "+" : "−"}
                  {nf(Math.abs((o.liq / o.mark - 1) * 100), 1)}%
                </small>
              </>
            ) : (
              <span className="px-mut">None</span>
            )
          }
        />
        <Row k="Zero-equity price" tip="The price at which this order's own collateral would be used up; it is not a liquidation price." v={o.ze ? `$${price(o.ze)}` : "—"} />
        <Row k={`Fee (${nf(takerFee * 100, 3)}%)`} tip="Phoenix's taker fee for opening this size, taken from the collateral." v={o.c > 0 ? usd(o.fee) : "—"} />
        {p.existing && live && (
          <p className="px-od-n">{p.existing.side === side ? `Adds to your ${K} ${side}.` : `Reduces your ${K} ${p.existing.side} first.`}</p>
        )}
      </div>

      <div className="px-va">
        <div className="px-va-h">
          <span className="px-va-t">
            <Img src={VANNA_ICON} className="px-od-ic" />
            Margin account · after this order
          </span>
        </div>
        <SimRow on={live} k="Health factor" tip="How safe the whole margin account is: it can be liquidated at 1.10 or below." v0={now ? hfFmt(now.hf) : "—"} z0={now ? hz(now.hf) : ""} v1={a1 ? hfFmt(a1.hf) : null} z1={a1 ? hz(a1.hf) : ""} />
        {live && now && (
          <div className="px-hfm" aria-hidden="true">
            <i className="px-hfm-liq" style={{ left: `${hfPos(LIQ_HF)}%` }} />
            <i className={`px-hfm-now ${a1 ? "ghost" : ""}`} style={{ left: `${hfPos(now.hf)}%` }} />
            {a1 && <i className="px-hfm-aft" style={{ left: `${hfPos(a1.hf)}%` }} />}
          </div>
        )}
        <SimRow on={live} k="Account leverage" tip="Your market exposure (volatile collateral plus perp size) divided by your own money (equity)." v0={now ? levFmt(now.leverage) : "—"} v1={a1 ? levFmt(a1.leverage) : null} />
        <SimRow on={live} k="Available USDC" tip="Idle USDC in your margin account; this order takes its collateral from here." v0={nf(p.available, 2)} v1={a1 ? nf(p.available - o.c, 2) : null} />
        <SimRow
          on={live}
          k="Room before liquidation"
          tip="The smallest single price move that liquidates the account, every other price unchanged."
          v0={p.room0 ? roomText(p.room0) : "—"}
          z0={p.room0 ? roomZone(p.room0) : ""}
          v1={o.room1 ? roomText(o.room1) : null}
          z1={o.room1 ? roomZone(o.room1) : ""}
          sub={live && p.room0 ? roomSub(p.room0) : ""}
        />
        {!live && <p className="px-va-s">{p.connected ? "Create a margin account to trade perps." : "Connect a wallet to see your margin account."}</p>}
      </div>

      <div id="px-cta">
        {cta.warn && o.after && (
          <p className="px-warn" role="status">
            <WarnIcon />
            <span>
              Health factor would be {hfFmt(o.after.hf)}, close to liquidation at {nf(LIQ_HF, 2)}.
            </span>
          </p>
        )}
        <button type="button" className={`px-cta ${cta.cls ?? ""}`} disabled={Boolean(cta.dis) || p.placing} onClick={cta.act}>
          {p.placing ? "Placing order…" : cta.label}
        </button>
        {cta.link && (
          <button type="button" className="px-lnk ctr" onClick={() => router.push("/margin")}>
            Create a margin account on the Margin page
            <Go />
          </button>
        )}
        {cta.borrow && (
          <button type="button" className="px-lnk ctr" onClick={() => router.push("/margin")}>
            Borrow more USDC
            <Go />
          </button>
        )}
        <p className="px-fine">
          Market order on Phoenix. Fills within {slip}% of the mark price or not at all; if nothing fills, your USDC stays in Phoenix. Your first trade also creates your Phoenix account (one extra wallet approval).
        </p>
      </div>
    </form>
  );
}

function Row({ k, tip, v }: { k: string; tip: string; v: React.ReactNode }) {
  return (
    <div className="px-od-r">
      <span>
        {k}
        <Info text={tip} />
      </span>
      <span>{v}</span>
    </div>
  );
}

function SimRow({ on, k, tip, v0, z0, v1, z1, sub }: { on: boolean; k: string; tip: string; v0: string; z0?: string; v1: string | null; z1?: string; sub?: string }) {
  return (
    <div className="px-sr">
      <span className="px-sr-k">
        <span className="lab">
          {k}
          <Info text={tip} />
        </span>
        {sub ? <small>{sub}</small> : null}
      </span>
      <span className="px-sr-v num">
        {on ? (
          <>
            <span className={`o ${z0 ?? ""}`}>{v0}</span>
            <Arrow />
            {v1 !== null ? <b className={z1 ?? ""}>{v1}</b> : <span className="px-mut">—</span>}
          </>
        ) : (
          <span className="px-mut">—</span>
        )}
      </span>
    </div>
  );
}
