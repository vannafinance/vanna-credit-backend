"use client";

/**
 * Portfolio → Trader → Spot: the margin account's spot positions (`useSpotPositions`: volatile
 * tokens held = long, volatile tokens owed = short; entry prices only where the margin's own swap
 * history proves them) and its swap history (Jupiter / Titan `margin_execute` events).
 * The P&L chart shows the current value only: the chain keeps no P&L time series.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Info } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { price, sUsd, spct, tokFmt, usd } from "@/components/v3/format";
import type { Portfolio } from "./use-portfolio";
import { ChartCard, Ct, Grid, HistNav, InfoCard, LsTag, Success, TT, TokCell, TxCell, Venue, sign, when } from "./pf-ui";

export function TraderSpot({ p }: { p: Portfolio }) {
  const router = useRouter();
  const [view, setView] = useState<"cur" | "hist">("cur");
  const list = p.spot.positions;
  const size = list.reduce((t, x) => t + x.sizeUsd, 0);
  const lng = list.filter((x) => x.side === "long").reduce((t, x) => t + x.sizeUsd, 0);
  const pnl = p.totals.spotPnl;
  const unknown = list.filter((x) => x.pnl === null).length;

  return (
    <>
      <div className="pf-row2">
        <InfoCard
          title="Spot Info"
          rows={[
            ["Open Size", usd(size), "", TT.spotSize],
            ["Long · Short", `${usd(lng)} · ${usd(size - lng)}`, "", TT.spotLS],
            ["Unrealized PnL", sUsd(pnl), sign(pnl), TT.spotPnl],
            ["Open Positions", String(list.length)],
          ]}
        />
        <ChartCard
          title="Spot P&L"
          value={sUsd(pnl)}
          sub={list.length ? (unknown ? `${unknown} without entry price` : "Open positions") : "No open positions"}
          series={null}
          empty="P&L over time isn't recorded on-chain; the current figure is above."
        />
      </div>
      <section className="pf-tbl">
        <div className="pf-tbar">
          <HistNav value={view} onChange={setView} />
          <button type="button" className="pf-lnk" onClick={() => router.push("/trade/spot")}>
            Open Spot
          </button>
        </div>
        {view === "hist" ? (
          <Grid
            cols=".9fr .8fr 1.7fr .8fr .7fr 1fr"
            heads={["Date", "Type", "Amount", "Swap via", "Status", "Tx Hash"]}
            empty={p.margin.isLoading ? "Loading history…" : "No transactions yet"}
            rows={p.spot.swaps.map((x, i) => ({
              key: `${x.signature}-${i}`,
              cells: [
                <Ct key="d">{when(x.timestamp)}</Ct>,
                <span key="t" className="pf-badge pf-ok">
                  Swap
                </span>,
                <Ct key="a" desc={`→ ${tokFmt(Number(x.toAmount) || 0, x.toSymbol ?? "")}`}>
                  <Icon sym={x.symbol} className="ico pf-i16" />
                  {tokFmt(Number(x.amount) || 0, x.symbol)}
                </Ct>,
                <Ct key="v">{x.via ? <Venue name={x.via} /> : "—"}</Ct>,
                <Success key="s" />,
                <TxCell key="h" sig={x.signature} />,
              ],
            }))}
          />
        ) : (
          <Grid
            cols="1.1fr .9fr 1.1fr 1fr 1fr 1fr 1fr"
            heads={[
              "Asset",
              "Venue",
              "Balance",
              "Size (USD)",
              "Entry / Mark",
              "PnL",
              <>
                Liq. price
                <Info text={TT.liqPos} />
              </>,
            ]}
            empty={p.spot.loading ? "Loading spot positions…" : "No spot positions"}
            rows={list.map((x) => ({
              key: x.id,
              onClick: () => router.push("/trade/spot"),
              cells: [
                <TokCell key="a" sym={x.symbol} tags={<LsTag side={x.side} />} />,
                <Ct key="v" desc="Margin account">
                  {x.via ? <Venue name={x.via} /> : "—"}
                </Ct>,
                <Ct key="b" desc={x.side === "short" ? "borrowed" : x.source === "deposit" ? "deposited" : "held"}>
                  {x.side === "short" ? "−" : ""}
                  {tokFmt(x.qty, x.symbol)}
                </Ct>,
                <Ct key="s">{usd(x.sizeUsd)}</Ct>,
                <Ct key="e" desc={`$${price(x.mark)}`}>
                  {x.entry === null ? (
                    <>
                      —<Info text={x.note} />
                    </>
                  ) : (
                    `$${price(x.entry)}`
                  )}
                </Ct>,
                x.pnl === null ? (
                  <Ct key="p">—</Ct>
                ) : (
                  <Ct key="p" desc={<span className={sign(x.pnl)}>{spct(x.pnlPct ?? 0, 2)}</span>}>
                    <span className={sign(x.pnl)}>{sUsd(x.pnl)}</span>
                  </Ct>
                ),
                x.liqPrice === null ? (
                  <Ct key="l">None</Ct>
                ) : (
                  <Ct key="l" desc={x.liqDistancePct === null ? "" : `${spct(x.liqDistancePct, 1)} away`}>
                    ${price(x.liqPrice)}
                  </Ct>
                ),
              ],
            }))}
          />
        )}
      </section>
    </>
  );
}
