"use client";

/**
 * Header of the Perps terminal: the market bar (venue data from Phoenix's live feed) and the account
 * strip (the Vanna margin account | Perps on Phoenix).
 */
import { useEffect, useState } from "react";
import type { PerpMarketInfo } from "@/lib/solana/perps-types";
import type { PhoenixMarketStats } from "./use-phoenix-live";
import type { LiqRoom } from "./account-model";
import { hfZone } from "./account-model";
import { hfFmt, levFmt, nf, price, roomSub, roomText, roomZone, sUsd, spct, upDn, usd, usdC } from "./format";
import { Chev, ClockIcon, Img, Info, PHOENIX_ICON, VANNA_ICON, marketIcon } from "./ui";

const pairName = (k: string) => `${k}USDC`;

/** mm:ss to the next hourly funding payment. */
function useFundingCountdown(): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const d = new Date(now);
  const s = 3599 - (d.getUTCMinutes() * 60 + d.getUTCSeconds());
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const Stat = ({ k, tip, children }: { k: string; tip?: string; children: React.ReactNode }) => (
  <div className="px-st">
    <span className="px-st-k">
      {k}
      {tip && <Info text={tip} placement="bottom" />}
    </span>
    <span className="px-st-v">{children}</span>
  </div>
);

export interface MarketRow {
  info: PerpMarketInfo;
  live: PhoenixMarketStats | undefined;
}

export const change24h = (live: PhoenixMarketStats | undefined) =>
  live && live.prevDayPx > 0 ? ((live.markPx - live.prevDayPx) / live.prevDayPx) * 100 : null;

export function MarketBar({
  focus,
  rows,
  open,
  toggle,
  onSelect,
  close,
}: {
  focus: MarketRow | undefined;
  rows: MarketRow[];
  open: string | null;
  toggle: (id: string) => void;
  onSelect: (key: string) => void;
  close: () => void;
}) {
  const countdown = useFundingCountdown();
  const k = focus?.info.key ?? "";
  const live = focus?.live;
  const ch = change24h(live);
  const status = !focus
    ? null
    : !focus.info.tradingEnabled
      ? { ok: false, text: "Closed for new positions" }
      : !focus.info.priceFresh
        ? { ok: false, text: "Open · Feed stale" }
        : { ok: true, text: "Open · Feed fresh" };

  return (
    <div className="px-pnl px-mkt">
      <div className="px-pair-w px-rel" data-pop="px-pair">
        <button type="button" className="px-pair" onClick={() => toggle("px-pair")} aria-haspopup="listbox" aria-expanded={open === "px-pair"}>
          <Img src={marketIcon(k)} className="px-pair-ic" />
          <span className="px-pair-t">
            <b>{pairName(k)}</b>
            <small>Perps · Max {focus?.info.maxLeverage ?? 0}x</small>
          </span>
          <Chev up={open === "px-pair"} />
        </button>
        {open === "px-pair" && (
          <div className="px-pop px-pmenu num" role="listbox" aria-label="Markets">
            <div className="px-pm-h">
              <span>Market</span>
              <span>Mark price</span>
              <span>24h</span>
              <span>Max lev.</span>
            </div>
            {rows.map((r) => {
              const c = change24h(r.live);
              return (
                <button
                  key={r.info.key}
                  type="button"
                  className={`px-pm ${r.info.key === k ? "on" : ""}`}
                  role="option"
                  aria-selected={r.info.key === k}
                  onClick={() => {
                    close();
                    onSelect(r.info.key);
                  }}
                >
                  <span className="px-pm-n">
                    <Img src={marketIcon(r.info.key)} className="px-pm-ic" />
                    {pairName(r.info.key)}
                  </span>
                  <span>{price(r.live?.markPx ?? 0)}</span>
                  <span className={c === null ? "" : upDn(c)}>{spct(c ?? 0)}</span>
                  <span>{r.info.maxLeverage}x</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-mark num" title="Phoenix mark price">
        <b>{price(live?.markPx ?? 0)}</b>
        <small>
          {ch === null ? spct(0) : <span className={upDn(ch)}>{spct(ch)}</span>} 24h
        </small>
      </div>

      <div className="px-stats num">
        <Stat k="Index price" tip={`Phoenix's oracle price of ${k}; funding pulls the mark price toward it. Vanna values your position at its own on-chain index.`}>
          {`$${price(live?.oraclePx ?? 0)}`}
        </Stat>
        <Stat k="24h volume">{usdC(live?.dayNtlVlm ?? 0)}</Stat>
        <Stat k="Open interest" tip="The total size of all open longs and shorts on this Phoenix market.">
          {usdC(live ? live.openInterest * live.markPx : 0)}
        </Stat>
        <Stat k="Funding / 1h" tip="The hourly payment between longs and shorts (longs pay when positive); the timer counts down to the next one.">
          {live ? <span className={upDn(live.funding)}>{spct(live.funding, 4)}</span> : spct(0, 4)}
          <span className="px-cd">
            <ClockIcon />
            <span>{countdown}</span>
          </span>
        </Stat>
        <Stat k="Market status" tip="Whether the market accepts new positions and Vanna's price feed for it is up to date.">
          {status ? (
            <span className={status.ok ? "px-ok" : "px-dn"}>
              {status.ok && <i className="px-dot" />}
              {status.text}
            </span>
          ) : (
            "N/A"
          )}
        </Stat>
      </div>

      <div className="px-ven px-rel" data-pop="px-venue">
        <span className="px-ven-k">Venue</span>
        <button type="button" className="px-ven-b" onClick={() => toggle("px-venue")} aria-haspopup="listbox" aria-expanded={open === "px-venue"}>
          <Img src={PHOENIX_ICON} className="px-ven-ic" />
          Phoenix
          <Chev up={open === "px-venue"} />
        </button>
        {open === "px-venue" && (
          <div className="px-pop r px-vmenu" role="listbox" aria-label="Venue">
            <button type="button" className="px-vrow on" role="option" aria-selected="true" onClick={close}>
              <Img src={PHOENIX_ICON} className="px-vr-ic" />
              <span className="px-vr-t">
                <b>Phoenix</b>
                <small>{rows.length} markets · order book</small>
              </span>
              <span className="px-mini ok">Live</span>
            </button>
            <div className="px-vrow off" aria-disabled="true">
              <span className="px-vr-ph">
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="3 3" />
                  <path d="M12 8v8M8 12h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </span>
              <span className="px-vr-t">
                <b>More venues</b>
                <small>Same account, same health factor</small>
              </span>
              <span className="px-mini">Soon</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StripItem({ on, k, tip, cls, children }: { on: boolean; k: string; tip: string; cls?: string; children: React.ReactNode }) {
  return (
    <div className="px-ai">
      <span className="px-ai-k">
        {k}
        <Info text={tip} placement="bottom" />
      </span>
      <b className={`px-ai-v num ${on ? cls ?? "" : "px-mut"}`}>{children}</b>
    </div>
  );
}

/** Which numbers belong to whom: the whole Vanna margin account vs Perps on Phoenix. */
export function AccountStrip({
  on,
  hf,
  leverage,
  room,
  available,
  perpsValue,
  openPnl,
}: {
  on: boolean;
  hf: number;
  leverage: number;
  room: LiqRoom | null;
  available: number;
  perpsValue: number;
  openPnl: number;
}) {
  return (
    <div className="px-pnl px-acs" aria-label="Account summary">
      <div className="px-ag">
        <span className="px-ag-t">
          <Img src={VANNA_ICON} className="px-ag-ic" />
          Margin account
        </span>
        <StripItem on={on} k="Health factor" tip="How safe the whole margin account is: holdings ÷ debt. It can be liquidated at 1.10 or below." cls={hfZone(hf)}>
          {hfFmt(hf)}
        </StripItem>
        <StripItem on={on} k="Account leverage" tip="Your market exposure (volatile collateral plus perp size) divided by your own money (equity).">
          {levFmt(leverage)}
        </StripItem>
        <StripItem
          on={on}
          k="Room before liquidation"
          tip={room ? `The smallest single price move that liquidates the account; ${roomSub(room)}.` : "The smallest single price move that liquidates the account."}
          cls={room ? roomZone(room) : ""}
        >
          {room ? roomText(room) : "None"}
        </StripItem>
        <StripItem on={on} k="Available" tip="Idle USDC in your margin account that an order can use as collateral.">
          {nf(available, 2)} USDC
        </StripItem>
      </div>
      <div className="px-ag">
        <span className="px-ag-t">
          <Img src={PHOENIX_ICON} className="px-ag-ic" />
          Perps · Phoenix
        </span>
        <StripItem on={on} k="Perps value" tip="What your Phoenix account counts for in the health factor: its USDC plus every position's equity at the index price.">
          {usd(perpsValue)}
        </StripItem>
        <StripItem on={on} k="Open P&L" tip="Unrealized profit or loss of your open Phoenix positions at the mark price." cls={upDn(openPnl)}>
          {sUsd(openPnl)}
        </StripItem>
      </div>
    </div>
  );
}
