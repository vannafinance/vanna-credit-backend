"use client";

/**
 * Portfolio → Trader → Spot: every token balance the margin account holds (the same account
 * snapshot the Margin page reads: deposits, swapped tokens, Kamino receipts and Basis / Perena
 * vault receipts; the Phoenix venue line is not a token and stays on the Perps tab), plus its swap
 * history (Jupiter / Titan `margin_execute` events). The Long · Short split and unrealized P&L
 * still come from the margin's spot positions (`useSpotPositions`: volatile tokens held = long,
 * volatile tokens owed = short; entry prices only where the margin's own swap history proves them).
 * The P&L chart shows the current value only: the chain keeps no P&L time series.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/v3/icons";
import { sUsd, tokFmt, usd } from "@/components/v3/format";
import type { Portfolio } from "./use-portfolio";
import { ChartCard, Ct, Grid, HistNav, InfoCard, Success, TT, TokCell, TxCell, Venue, sign, when } from "./pf-ui";
import { VannaLoader } from "@/components/v3/vanna-loader";

/** Balances worth less than this (USD) are dust and not listed; unpriced balances are kept. */
const DUST_USD = 0.005;

/** One token the margin account holds, from the account snapshot. */
interface Holding {
  sym: string;
  amt: number;
  usd: number;
}

export function TraderSpot({ p }: { p: Portfolio }) {
  const router = useRouter();
  const [view, setView] = useState<"cur" | "hist">("cur");
  const list = p.spot.positions;
  // Every token balance in the margin account (amount > 0, above dust), largest first. A receipt
  // whose rate is unknown is valued at 0 USD by the snapshot, so it is kept on its amount alone.
  const held = useMemo<Holding[]>(
    () =>
      Object.entries(p.snapshot?.collateralBalances ?? {})
        .map(([sym, b]) => ({ sym, amt: parseFloat(b.amount) || 0, usd: parseFloat(b.usdValue) || 0 }))
        .filter((h) => h.amt > 0 && (h.usd > DUST_USD || h.usd === 0))
        .sort((a, b) => b.usd - a.usd),
    [p.snapshot],
  );
  const size = held.reduce((t, x) => t + x.usd, 0);
  const longUsd = list.filter((x) => x.side === "long").reduce((t, x) => t + x.sizeUsd, 0);
  const shortUsd = list.filter((x) => x.side === "short").reduce((t, x) => t + x.sizeUsd, 0);
  const loadingHeld = p.spot.loading || (p.connected && !p.snapshot);
  const pnl = p.totals.spotPnl;
  const unknown = list.filter((x) => x.pnl === null).length;

  return (
    <>
      <div className="pf-row2">
        <InfoCard
          title="Spot Info"
          rows={[
            ["Open Size", usd(size), "", TT.spotSize],
            ["Long · Short", `${usd(longUsd)} · ${usd(shortUsd)}`, "", TT.spotLS],
            ["Unrealized PnL", sUsd(pnl), sign(pnl), TT.spotPnl],
            ["Assets Held", String(held.length)],
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
            empty={p.margin.isLoading ? <VannaLoader size="block" /> : "No transactions yet"}
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
                <Ct key="v">{x.via ? <Venue name={x.via} /> : "N/A"}</Ct>,
                <Success key="s" />,
                <TxCell key="h" sig={x.signature} />,
              ],
            }))}
          />
        ) : (
          <Grid
            cols="1.2fr 1fr 1fr"
            heads={["Asset", "Balance", "Size (USD)"]}
            empty={loadingHeld ? <VannaLoader size="block" /> : "No tokens in your margin account"}
            rows={held.map((x) => ({
              key: x.sym,
              onClick: () => router.push("/trade/spot"),
              cells: [
                <TokCell key="a" sym={x.sym} />,
                <Ct key="b">{tokFmt(x.amt, x.sym)}</Ct>,
                <Ct key="s">{usd(x.usd)}</Ct>,
              ],
            }))}
          />
        )}
      </section>
    </>
  );
}
