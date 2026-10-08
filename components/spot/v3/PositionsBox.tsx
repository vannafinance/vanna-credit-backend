"use client";

import { useMarginHistory } from "@/hooks/use-margin";
import { explorerUrl } from "@/lib/solana/config";
import { Icon } from "@/components/v3/icons";
import { hfFmt, timeFmt, tokFmt } from "@/components/v3/format";

/** Spot shows swap history only; account holdings stay on the Margin page. */
export function PositionsBox() {
  const { rows, history, isLoading: loading, error } = useMarginHistory();
  const swaps = rows.filter((row) => row.type === "swap");
  return (
    <section className="sp-box" aria-label="Spot position history">
      <div className="sp-bh">
        <span className="sp-bt">Position History{swaps.length > 0 && <small className="num">{swaps.length}</small>}</span>
        <span className="sp-bs">
          {swaps.length} {swaps.length === 1 ? "swap" : "swaps"} · via Jupiter / Titan{history && !history.complete ? " · partial history" : ""}
        </span>
      </div>
      {swaps.length ? (
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
        <div className="sp-empty">{loading ? "Loading swaps…" : error ? "Unable to load position history. Please try again." : "No swaps yet"}</div>
      )}
    </section>
  );
}
