"use client";

/**
 * Predict account data + the positions table (design predict.js `posRows` / `posTable`): one table
 * for every source. A position's shares in Vanna's pool (source Vanna, "Earning x%" or "Joining the
 * pool" while the keeper pairs them) and its World shares still in the wallet (source World, "Not
 * earning", with Start earning when the market's pool is open) are separate rows.
 * All figures come from GET /api/predict/positions/:owner.
 */
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { IC } from "@/components/v3/icons";
import { sUsd, usd } from "@/components/v3/format";
import { useUserStore } from "@/store/user";
import { usePredictEvents, usePredictPositions, usePredictRate, usePredictTrade } from "@/hooks/use-predict";
import { MAX_TRADE_LEGS, positionRows, predictHref, type PosRow } from "@/lib/predict/view";
import type { PositionsResponse, PredictEvent, PredictImportable } from "@/lib/predict/types";
import { EvLogo, SideTag, SrcBadge, cpair, shf } from "./ui";

/** The connected wallet's Predict account: positions, summary, wallet balances, pool rate. */
export function usePredictAccount() {
  const address = useUserStore((s) => s.address);
  const q = usePredictPositions(address);
  const rate = usePredictRate();
  const data: PositionsResponse | undefined = address ? q.data : undefined;
  return { address, connected: Boolean(address), data, loading: Boolean(address) && q.isLoading, error: q.error as Error | null, rate };
}

/** Rows for the table from a positions response (pool part and wallet part of each position). */
export function rowsOf(data: PositionsResponse | undefined): PosRow[] {
  if (!data) return [];
  const can = new Set(data.importable.map((x) => x.marketId));
  return positionRows(data.positions, (id) => can.has(id));
}

/** Start earning: move World shares from the wallet into Vanna's pool (`deposit` legs, one approval). */
export function useStartEarning() {
  const trade = usePredictTrade();
  const start = (items: PredictImportable[]) => {
    const legs = items
      .filter((x) => x.marketId && x.shares > 0)
      .slice(0, MAX_TRADE_LEGS)
      .map((x) => ({ marketId: x.marketId!, outcome: x.side, side: "deposit" as const, amount: Math.floor(x.shares * 1e6) / 1e6 }));
    if (!legs.length) return;
    const n = legs.length;
    trade.mutate({ legs, successMessage: `${n} World position${n > 1 ? "s" : ""} now in Vanna's pool` });
  };
  return { start, busy: trade.isPending };
}

/** Event lookup for logos (the list query is shared and cached). */
export function useEventMap() {
  const { data } = usePredictEvents();
  return useMemo(() => new Map((data ?? []).map((e) => [e.id, e])), [data]);
}

const HEADS = ["Market", "Outcome", "Shares", "Avg / now", "Value", "Source", "Status", "Action"];

/** The positions table. `onEarn` handles a wallet row's Start earning; rows open their market. */
export function PosTable({
  rows,
  events,
  empty,
  onEarn,
  busy,
  onOpen,
}: {
  rows: PosRow[];
  events: Map<string, PredictEvent>;
  empty?: string;
  onEarn?: (r: PosRow) => void;
  busy?: boolean;
  onOpen?: () => void;
}) {
  const router = useRouter();
  if (!rows.length) return <div className="pd-empty sm">{empty ?? "No positions yet."}</div>;
  const open = (r: PosRow) => {
    onOpen?.();
    router.push(predictHref(r.eventId, r.marketId, r.side));
  };
  return (
    <div className="pd-tbl">
      <div className="pd-th">
        {HEADS.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
      {rows.map((r) => {
        const e = events.get(r.eventId);
        const [pa, pn] = cpair(r.avg, r.now);
        const multi = e ? e.outs.length > 1 : r.market !== r.event;
        return (
          <div key={r.key} className="pd-tr go" onClick={() => open(r)}>
            <span className="pd-tm" data-l="Market">
              {e ? <EvLogo e={e} cls="sm" /> : <span className="pd-ic sm">{r.event.slice(0, 3).toUpperCase()}</span>}
              <b>{e?.title ?? r.event}</b>
            </span>
            <span className="pd-to" data-l="Outcome">
              {multi && <i>{r.market}</i>}
              <SideTag s={r.side} L={r.label} />
            </span>
            <span className="num" data-l="Shares">
              <b>{shf(r.shares)}</b>
            </span>
            <span className="num" data-l="Avg / now">
              <b className="pd-ba">
                {pa}
                {IC.arrow}
                {pn}
              </b>
            </span>
            <span className="num" data-l="Value">
              <b>{usd(r.value)}</b>
              <small className={r.pnl >= 0 ? "pos" : "neg"}>{sUsd(r.pnl)}</small>
            </span>
            <span data-l="Source">
              <SrcBadge src={r.src} />
              <small>{r.kind === "pool" ? "In Vanna's pool" : "Your wallet"}</small>
            </span>
            <span data-l="Status">
              <span className={`pd-stat ${r.status.cls}`}>{r.status.txt}</span>
            </span>
            <span className="pd-ta">
              {r.kind === "wallet" && r.canEarn && onEarn ? (
                <button
                  type="button"
                  className="btn-v"
                  disabled={busy}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onEarn(r);
                  }}
                >
                  Start earning
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-s"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    open(r);
                  }}
                >
                  Trade
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** The importable item behind a wallet row (for Start earning). */
export const importOf = (data: PositionsResponse | undefined, r: PosRow) => data?.importable.find((x) => x.marketId === r.marketId && x.side === r.side) ?? null;
