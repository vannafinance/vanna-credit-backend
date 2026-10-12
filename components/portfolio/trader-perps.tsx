"use client";

/**
 * Portfolio → Trader → Perps: the margin's Phoenix positions as the oracle values them
 * (`usePerpsView` via `useV3Account`), realized P&L from the margin's own Phoenix funding / settle
 * flows (when the scanned history is complete), and the decoded Phoenix history. Close and "Open
 * terminal" go to the perps terminal. The P&L chart shows the current value only (no on-chain P&L
 * time series).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Info } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { levFmt, price, sUsd, spct, tokFmt, usd } from "@/components/v3/format";
import { usePerpsHistory } from "@/hooks/use-perps";
import { pairSlug } from "@/components/perps/perps-format";
import type { Portfolio } from "./use-portfolio";
import { ChartCard, HistNav, InfoCard, PTable, TT, TxCell, sign, when } from "./pf-ui";
import { VannaLoader } from "@/components/v3/vanna-loader";

const SideTxt = ({ s }: { s: "long" | "short" | null }) =>
  s ? <b className={s === "long" ? "pf-long" : "pf-short"}>{s === "long" ? "Long" : "Short"}</b> : <>N/A</>;
const Mkt = ({ k }: { k: string }) => (
  <span className="pf-mk">
    <Icon sym={k} className="ico pf-i16" />
    <b>{k}-PERP</b>
  </span>
);
const ACTION: Record<string, string> = { open: "Open", close: "Close", deposit: "Deposit", settle: "Settle", cancel: "Cancel", setup: "Setup", nofill: "No fill" };

export function TraderPerps({ p }: { p: Portfolio }) {
  const router = useRouter();
  const [view, setView] = useState<"cur" | "hist">("cur");
  const history = usePerpsHistory(view === "hist");
  const view3 = p.acct.view;
  const list = view3?.positions ?? [];
  const value = view3?.account.venueValueUsd ?? 0;
  const size = list.reduce((t, x) => t + x.sizeUsd, 0);
  const pnl = p.totals.perpsUnrealized;
  const realized = p.totals.perpsRealized;
  const go = (k: string) => router.push(`/trade/perps/${pairSlug(k)}`);

  return (
    <>
      <div className="pf-row2">
        <InfoCard
          title="Perps Info"
          rows={[
            ["Perps Value", usd(value), "", TT.perpsValue],
            ["Open Size", usd(size), "", TT.perpsSize],
            ["Unrealized PnL", sUsd(pnl), sign(pnl), TT.perpsPnl],
            ["Realized PnL", realized === null ? usd(0) : sUsd(realized), realized === null ? "" : sign(realized), TT.perpsReal],
            ["Open Positions", String(list.length)],
          ]}
        />
        <ChartCard
          title="Perps P&L"
          value={sUsd(pnl)}
          sub={list.length ? "Open positions" : "No open positions"}
          series={null}
          empty="P&L over time isn't recorded on-chain; the current figure is above."
        />
      </div>
      <section className="pf-tbl">
        <div className="pf-tbar">
          <HistNav value={view} onChange={setView} />
          <button type="button" className="pf-lnk pf-ven" onClick={() => go(list[0]?.market ?? "SOL")}>
            <Icon sym="PHX" className="ico pf-i16" />
            Open terminal
          </button>
        </div>
        {view === "hist" ? (
          history.rows.length ? (
            <PTable
              heads={["Time", "Action", "Market", "Side", "Amount", "Tx"]}
              right={[5]}
              rows={history.rows.map((x, i) => ({
                key: `${x.signature}-${i}`,
                cells: [
                  when(x.timestamp * 1000),
                  <b key="a">{ACTION[x.action] ?? x.action}</b>,
                  x.market ? (
                    <Mkt k={x.market} />
                  ) : (
                    <span className="pf-ven">
                      <Icon sym="PHX" className="ico pf-i16" />
                      Phoenix
                    </span>
                  ),
                  <SideTxt key="s" s={x.side} />,
                  x.sizeUsd !== null ? usd(x.sizeUsd) : x.usdc !== null ? tokFmt(x.usdc, "USDC") : usd(0),
                  <TxCell key="t" sig={x.signature} plain />,
                ],
              }))}
            />
          ) : (
            <div className="pf-pnone">{history.isLoading ? <VannaLoader size="block" /> : "No perps activity yet"}</div>
          )
        ) : list.length ? (
          <PTable
            heads={[
              "Market",
              "Side",
              "Position size",
              "Entry",
              "Mark",
              "Collateral",
              "Leverage",
              "PnL",
              "Equity",
              <>
                Liq. price
                <Info text={TT.liqPos} />
              </>,
              "Action",
            ]}
            right={[10]}
            rows={list.map((x) => {
              const lp = p.acct.liqPriceOf(x.market, x.side);
              const mv = lp !== null && x.indexPrice > 0 ? (lp / x.indexPrice - 1) * 100 : null;
              return {
                key: `${x.market}-${x.side}`,
                side: x.side,
                cells: [
                  <Mkt key="m" k={x.market} />,
                  <SideTxt key="s" s={x.side} />,
                  <span key="z" className="pf-2l">
                    <span>{tokFmt(x.sizeTokens, x.market)}</span>
                    <span className="pf-sm">{usd(x.sizeUsd)}</span>
                  </span>,
                  `$${price(x.entryPrice)}`,
                  `$${price(x.indexPrice)}`,
                  usd(x.collateralUsdc),
                  levFmt(x.leverage),
                  <span key="p" className="pf-2l">
                    <b className={sign(x.pnlUsd)}>{sUsd(x.pnlUsd)}</b>
                    <span className={`pf-sm ${sign(x.pnlUsd)}`}>{spct(x.pnlPercent, 2)}</span>
                  </span>,
                  usd(x.equityUsd),
                  lp === null ? (
                    "None"
                  ) : (
                    <span key="l" className="pf-2l">
                      <span>${price(lp)}</span>
                      <span className="pf-sm">{mv === null ? "" : spct(mv, 1)}</span>
                    </span>
                  ),
                  <button key="c" type="button" className="pf-close" onClick={() => go(x.market)}>
                    Close
                  </button>,
                ],
              };
            })}
          />
        ) : (
          <div className="pf-pnone">No open positions</div>
        )}
      </section>
    </>
  );
}
