"use client";

/**
 * Perps terminal (design prototype V3, 1_Latest_UI): market bar + account strip, Phoenix chart and
 * live order book, the order panel, and Positions | History | Account.
 *
 * Data:
 * - on-chain (usePerpsView, the fork): listed markets (leverage cap, trading switch, fee, Vanna's
 *   index), the margin account and its Phoenix positions — what the health factor is computed from;
 * - live Phoenix (usePhoenixLive, mainnet API): mark / oracle price, 24h, volume, open interest,
 *   funding, the order book, trades and candles. Orders fill against this book (the fork re-copies
 *   it right before each order).
 * The account numbers (health factor, leverage, room before liquidation, liquidation prices, the
 * order simulation) come from ./account-model, which mirrors the program's valuation.
 */
import "./perps-terminal.css";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@/hooks/use-wallet";
import { useClosePerp, useOpenPerp, usePerpsHistory, usePerpsView, useWithdrawPerpCollateral } from "@/hooks/use-perps";
import { PERP_MARKETS } from "@/lib/solana/phoenix";
import type { PerpMarketInfo } from "@/lib/solana/perps-types";
import { pairSlug } from "../perps-format";
import type { ModelState } from "./account-model";
import { accountNumbers, liqRoom, positionLiqPrice } from "./account-model";
import { AccountStrip, MarketBar, change24h, type MarketRow } from "./market-bar";
import { OrderBook } from "./order-book";
import { OrderPanel } from "./order-panel";
import { BottomPanel, type PositionRow } from "./bottom-panel";
import { PriceChart, type ChartLine } from "./price-chart";
import { usePhoenixLive, type PhoenixTimeframe } from "./use-phoenix-live";
import { usePopover } from "./ui";

const SYMBOLS = PERP_MARKETS.map((m) => m.key);

/** Static market info until the on-chain market book loads. */
const placeholderMarket = (key: string): PerpMarketInfo => {
  const meta = PERP_MARKETS.find((m) => m.key === key);
  return {
    key,
    name: `${key}-PERP`,
    leg: 0,
    indexPrice: null,
    markPrice: 0,
    priceFresh: false,
    maxLeverage: key === "TSLA" || key === "META" ? 3 : 5,
    tradingEnabled: false,
    takerFee: 0,
    chartSymbol: meta?.chartSymbol ?? "",
    icon: meta?.icon ?? "",
  };
};

export default function PerpsTerminal({ marketKey }: { marketKey: string }) {
  const router = useRouter();
  const { address, connectWallet } = useWallet();
  const { view, error } = usePerpsView();
  const [tf, setTf] = useState<PhoenixTimeframe>("1d");
  const [bookOpen, setBookOpen] = useState(true);
  const [bookTab, setBookTab] = useState<"book" | "trades">("book");
  const [tab, setTab] = useState<"positions" | "history" | "account">("positions");
  const pop = usePopover();
  const live = usePhoenixLive(SYMBOLS, marketKey, tf);
  const history = usePerpsHistory(tab === "history");
  const openPerp = useOpenPerp();
  const closePerp = useClosePerp();
  const withdraw = useWithdrawPerpCollateral();
  const busy = openPerp.isPending || closePerp.isPending || withdraw.isPending;

  const connected = Boolean(address);
  const acct = view?.account;
  const hasMargin = Boolean(acct?.hasMargin);
  const markets = useMemo(() => SYMBOLS.map((k) => view?.markets.find((m) => m.key === k) ?? placeholderMarket(k)), [view?.markets]);
  const rowsForMenu: MarketRow[] = markets.map((info) => ({ info, live: live.stats[info.key] }));
  const focus = rowsForMenu.find((r) => r.info.key === marketKey);
  const market = view?.markets.find((m) => m.key === marketKey);
  const mark = live.stats[marketKey]?.markPx ?? (market?.markPrice || null);

  // The margin account as the program values it (see account-model.ts).
  const state: ModelState | null = useMemo(() => {
    if (!view || !acct?.hasMargin) return null;
    return {
      collateral: acct.collateralRows,
      debts: acct.debtRows,
      phoenixCollateral: acct.idleUsdc,
      perps: view.positions.map((p) => ({
        key: p.market,
        tokens: p.side === "long" ? p.sizeTokens : -p.sizeTokens,
        entry: p.entryPrice,
        index: p.indexPrice,
        fundingUsd: p.fundingUsd,
        takerFee: view.markets.find((m) => m.key === p.market)?.takerFee ?? 0,
      })),
    };
  }, [view, acct]);
  const now = useMemo(() => (state ? accountNumbers(state) : null), [state]);
  const room = useMemo(() => (state ? liqRoom(state) : null), [state]);

  // Positions at the live mark. Phoenix is cross-margined: its USDC backs every position, so each
  // position is shown with a share of it split by entry notional (the shares add up to the total).
  const positions: PositionRow[] = useMemo(() => {
    if (!view || !state) return [];
    const totalEntry = view.positions.reduce((t, p) => t + p.sizeTokens * p.entryPrice, 0);
    return view.positions.map((p) => {
      const m = live.stats[p.market]?.markPx ?? p.indexPrice;
      const sign = p.side === "long" ? 1 : -1;
      const pnl = sign * p.sizeTokens * (m - p.entryPrice);
      const collateral = totalEntry > 0 ? (acct!.idleUsdc * p.sizeTokens * p.entryPrice) / totalEntry : 0;
      return {
        key: p.market,
        side: p.side,
        tokens: p.sizeTokens,
        entry: p.entryPrice,
        mark: m,
        sizeUsd: p.sizeTokens * m,
        liq: positionLiqPrice(state, p.market, p.side),
        pnl,
        collateral,
        leverage: collateral > 0 ? (p.sizeTokens * m) / collateral : 0,
        equity: collateral + pnl + p.fundingUsd,
        fundingUsd: p.fundingUsd,
        takerFee: view.markets.find((x) => x.key === p.market)?.takerFee ?? 0,
      };
    });
  }, [view, state, live.stats, acct]);
  const openPnl = positions.reduce((t, r) => t + r.pnl, 0);
  const existing = positions.find((r) => r.key === marketKey) ?? null;

  const chartLines: ChartLine[] = positions
    .filter((r) => r.key === marketKey)
    .flatMap((r) => [
      { v: r.entry, cls: "ent" as const, t: `${r.side === "long" ? "Long" : "Short"} entry` },
      ...(r.liq ? [{ v: r.liq, cls: "liq" as const, t: "Liq." }] : []),
    ]);

  const onSelect = (key: string) => router.push(`/trade/perps/${pairSlug(key)}`);
  const connect = () => void connectWallet();

  return (
    <div className="px-root px-page">
      <div className={`px-term ${bookOpen ? "" : "nobook"}`}>
        {error && <div className="px-err">Couldn&apos;t load your perps data: {error}</div>}
        {view && view.markets.length === 0 && <div className="px-err">Phoenix markets aren&apos;t listed on this network yet.</div>}
        <div className="px-top">
          <MarketBar focus={focus} rows={rowsForMenu} open={pop.open} toggle={pop.toggle} close={pop.close} onSelect={onSelect} />
          <AccountStrip
            on={connected && hasMargin}
            hf={now?.hf ?? Infinity}
            leverage={now?.leverage ?? 0}
            room={room}
            available={acct?.marginUsdc ?? 0}
            perpsValue={acct?.venueValueUsd ?? 0}
            openPnl={openPnl}
          />
        </div>
        <div className="px-body">
          <div className="px-left">
            <div className="px-mid">
              <PriceChart marketKey={marketKey} tf={tf} onTf={setTf} candles={live.candles} lines={chartLines} bookOpen={bookOpen} onShowBook={() => setBookOpen(true)} />
              {bookOpen && (
                <OrderBook
                  marketKey={marketKey}
                  book={live.book}
                  trades={live.trades}
                  mark={mark}
                  change={change24h(live.stats[marketKey])}
                  tab={bookTab}
                  onTab={setBookTab}
                  onHide={() => setBookOpen(false)}
                  connected={live.connected}
                />
              )}
            </div>
            <BottomPanel
              connected={connected}
              onConnect={connect}
              rows={positions}
              history={history.rows}
              historyLoading={history.isLoading}
              tab={tab}
              onTab={setTab}
              now={now}
              room={room}
              available={acct?.marginUsdc ?? 0}
              phoenixUsdc={acct?.idleUsdc ?? 0}
              withdrawableNow={acct?.withdrawableNowUsdc ?? 0}
              perpsValue={acct?.venueValueUsd ?? 0}
              openPnl={openPnl}
              busy={busy}
              onClose={(row, pct) => closePerp.mutateAsync({ market: row.key, side: row.side, sizeUsd: pct >= 100 ? undefined : (row.sizeUsd * pct) / 100 })}
              onCloseAll={async () => {
                // One reduce-only close per position; the last one also sends the USDC home.
                for (const r of positions) await closePerp.mutateAsync({ market: r.key, side: r.side });
              }}
              onWithdraw={() => withdraw.mutateAsync({})}
            />
          </div>
          <OrderPanel
            key={marketKey}
            marketKey={marketKey}
            market={market}
            mark={mark}
            book={live.book}
            connected={connected}
            hasMargin={hasMargin}
            available={acct?.marginUsdc ?? 0}
            state={state}
            now={now}
            room0={room}
            existing={existing ? { side: existing.side } : null}
            placing={openPerp.isPending}
            onConnect={connect}
            onPlace={(req) => openPerp.mutateAsync({ market: marketKey, ...req })}
            open={pop.open}
            toggle={pop.toggle}
            close={pop.close}
          />
        </div>
      </div>
    </div>
  );
}
