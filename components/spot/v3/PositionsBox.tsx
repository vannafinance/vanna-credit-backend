"use client";

/**
 * Spot's "Positions" card (design spot.js posHistCard): Current Position | Position History.
 * Positions come from `useSpotPositions()` (margin holdings / debts + entry from the on-chain swap
 * history); history is every margin-account swap decoded from the program's `MarginExecuted`
 * events (the former SwapHistory card, with its "Swap via" column).
 */
import { useState } from "react";
import { useSpotPositions, type SpotPosition } from "@/hooks/use-spot-positions";
import { explorerUrl } from "@/lib/solana/config";
import { LIQ_HF } from "@/lib/account-model";
import { Info, Seg } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { hfFmt, nf, price, sUsd, spct, timeFmt, tokFmt, usd } from "@/components/v3/format";
import { CloseModal } from "./CloseModal";

const LIQ_TIP = "The price of this token at which the whole account reaches health factor 1.10, every other price held. None = no move of this price alone liquidates it.";
const ENTRY_TIP = "Weighted-average price from your margin account's on-chain swaps. Tokens that were deposited (not bought here) have no entry price.";

function PositionRow({ p, onClose }: { p: SpotPosition; onClose: () => void }) {
  const pnlCls = p.pnl === null ? "" : p.pnl >= 0 ? "pos" : "neg";
  return (
    <div className="sp-pr num">
      <span className="sp-pa">
        <Icon sym={p.symbol} className="sp-ico s20" />
        <b>{p.symbol}</b>
        <span className={`sp-side ${p.side === "long" ? "l" : "s"}`}>{p.side.toUpperCase()}</span>
      </span>
      <span data-l="Size">
        <span className="sp-c1">{tokFmt(p.qty, p.symbol)}</span>
        <small>
          {usd(p.sizeUsd)}
          {p.side === "short" ? " · borrowed" : ""}
        </small>
      </span>
      <span data-l="Entry · Mark">
        <span className="sp-c1" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {p.entry !== null ? `$${price(p.entry)}` : "—"}
          {p.entry === null && <Info text={p.note} />}
        </span>
        <small>Mark ${price(p.mark)}</small>
      </span>
      <span data-l="P&L">
        <span className={`sp-c1 ${pnlCls}`}>{p.pnl !== null ? sUsd(p.pnl) : "—"}</span>
        <small className={pnlCls}>{p.pnlPct !== null ? spct(p.pnlPct) : p.source === "deposit" ? "deposited" : p.source === "unsold" ? "not sold yet" : "partly bought here"}</small>
      </span>
      <span data-l="Liq. price">
        <span className="sp-c1">{p.liqPrice !== null ? `$${price(p.liqPrice)}` : "None"}</span>
        <small>
          {p.liqDistancePct !== null ? `${spct(p.liqDistancePct, 1)} away` : p.side === "long" ? "no fall liquidates alone" : "no rise liquidates alone"}
        </small>
      </span>
      <span className="sp-pact">
        <button type="button" className="btn-s" onClick={onClose}>
          Close
        </button>
      </span>
    </div>
  );
}

export function PositionsBox() {
  const [tab, setTab] = useState<"current" | "history">("current");
  const [closing, setClosing] = useState<SpotPosition | null>(null);
  const { positions, swaps, loading, historyComplete } = useSpotPositions();
  const cur = tab === "current";
  const n = positions.length;

  return (
    <section className="sp-box" aria-label="Spot positions">
      <div className="sp-bh">
        <span className="sp-bt">
          Positions{n > 0 && <small className="num">{n}</small>}
        </span>
        <span className="sp-bs">
          {cur
            ? `Margin account · cross-margined · liquidatable at ${nf(LIQ_HF, 2)}`
            : `${swaps.length} ${swaps.length === 1 ? "swap" : "swaps"} · via Jupiter / Titan${historyComplete ? "" : " · latest 200 transactions"}`}
        </span>
      </div>
      <Seg
        className="sp-seg"
        value={tab}
        onChange={setTab}
        options={[
          ["current", "Current Position"],
          ["history", "Position History"],
        ]}
      />
      {cur ? (
        n ? (
          <div>
            <div className="sp-ph">
              <span>Asset</span>
              <span>Size</span>
              <span>
                Entry <Info text={ENTRY_TIP} />
              </span>
              <span>P&amp;L</span>
              <span>
                Liq. price <Info text={LIQ_TIP} />
              </span>
              <span />
            </div>
            {positions.map((p) => (
              <PositionRow key={p.id} p={p} onClose={() => setClosing(p)} />
            ))}
          </div>
        ) : (
          <div className="sp-empty">
            {loading ? "Loading positions…" : "No spot positions. Holding a volatile token in the margin account (buy it with USDC above) or owing one opens one."}
          </div>
        )
      ) : swaps.length ? (
        <div>
          <div className="sp-hh">
            <span>Time</span>
            <span>Paid</span>
            <span>Received</span>
            <span>Swap via</span>
            <span>Health after</span>
            <span className="r">Tx</span>
          </div>
          {swaps.map((r) => (
            <div key={r.signature} className="sp-hr num">
              <span className="mut" data-l="Time">
                {timeFmt(Math.floor(r.timestamp / 1000))}
              </span>
              <span className="sp-hc" data-l="Paid">
                <Icon sym={r.symbol} className="sp-ico s20" />
                <span className="sp-neg">−{tokFmt(Number(r.amount), r.symbol, false)}</span> {r.symbol}
              </span>
              <span className="sp-hc" data-l="Received">
                <Icon sym={r.toSymbol ?? ""} className="sp-ico s20" />
                <span className="sp-pos">+{tokFmt(Number(r.toAmount ?? 0), r.toSymbol ?? "", false)}</span> {r.toSymbol}
              </span>
              <span className="sp-hc" data-l="Swap via">
                {r.via ? (
                  <>
                    <Icon sym={r.via} className="sp-ico s16" />
                    {r.via}
                  </>
                ) : (
                  "—"
                )}
              </span>
              <span className="mut" data-l="Health after">
                {r.healthFactor === undefined ? "No debt" : hfFmt(r.healthFactor)}
              </span>
              <span className="r" data-l="Tx">
                <a className="sp-tx" href={explorerUrl("tx", r.signature)} target="_blank" rel="noopener noreferrer">
                  {r.signature.slice(0, 4)}…{r.signature.slice(-4)}
                </a>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="sp-empty">{loading ? "Loading swaps…" : "No swaps yet"}</div>
      )}
      {closing && <CloseModal position={closing} onClose={() => setClosing(null)} />}
    </section>
  );
}
