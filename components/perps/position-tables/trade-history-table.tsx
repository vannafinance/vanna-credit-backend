"use client";

import type { PerpHistoryRow } from "@/lib/solana/perps-types";
import { explorerUrl } from "@/lib/solana/config";
import { fmtUsd } from "../perps-format";
import { PerpsColumn, PerpsTable } from "./perps-table";

const ACTION_LABEL: Record<PerpHistoryRow["action"], string> = {
  open: "Open / increase",
  close: "Close / reduce",
  cancel: "Cancel order",
  settle: "Settle to margin",
  setup: "Account setup",
};

const time = (unix: number) =>
  unix ? new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

/** The margin's GMTrade actions, decoded from its venue account's transactions (newest first). */
const TradeHistoryTable = ({ rows, loading }: { rows: PerpHistoryRow[]; loading: boolean }) => {
  const columns: PerpsColumn<PerpHistoryRow>[] = [
    { id: "time", header: "Time", render: (r) => time(r.timestamp) },
    { id: "action", header: "Action", render: (r) => <span className="font-semibold">{ACTION_LABEL[r.action]}</span> },
    { id: "market", header: "Market", render: (r) => (r.market ? `${r.market}-PERP` : "—") },
    {
      id: "side",
      header: "Side",
      render: (r) =>
        r.side ? <span className={`font-semibold ${r.side === "long" ? "text-[#24A0A9]" : "text-[#FC5457]"}`}>{r.side === "long" ? "Long" : "Short"}</span> : "—",
    },
    { id: "size", header: "Size", render: (r) => (r.sizeUsd == null ? "—" : `$${fmtUsd(r.sizeUsd)}`) },
    { id: "usdc", header: "USDC", render: (r) => (r.usdc == null ? "—" : `${fmtUsd(r.usdc)} USDC`) },
    {
      id: "tx",
      header: "Tx",
      align: "right",
      render: (r) => (
        <a href={explorerUrl("tx", r.signature)} target="_blank" rel="noopener noreferrer" className="text-[#703AE6] underline">
          {r.signature.slice(0, 8)}…
        </a>
      ),
    },
  ];
  return <PerpsTable columns={columns} data={rows} getRowKey={(r) => `${r.signature}-${r.action}`} emptyText={loading ? "Loading history…" : "No perps activity yet"} />;
};

export default TradeHistoryTable;
