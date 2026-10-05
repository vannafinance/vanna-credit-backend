"use client";

import { useTheme } from "@/contexts/theme-context";
import type { PerpOrder } from "@/lib/solana/perps-types";
import { fmtUsd } from "../perps-format";
import { PerpsColumn, PerpsTable, TableActionButton } from "./perps-table";

interface OpenOrdersTableProps {
  orders: PerpOrder[];
  onCancel: (order: PerpOrder) => void;
  cancelDisabled: boolean;
}

const sideLabel = (side: PerpOrder["side"]) => (
  <span className={`font-semibold ${side === "long" ? "text-[#24A0A9]" : "text-[#FC5457]"}`}>
    {side === "long" ? "Long" : "Short"}
  </span>
);

/** Pending GMTrade market orders (awaiting keeper execution). */
const OpenOrdersTable = ({ orders, onCancel, cancelDisabled }: OpenOrdersTableProps) => {
  const { isDark } = useTheme();

  const columns: PerpsColumn<PerpOrder>[] = [
    { id: "market", header: "Market", render: (r) => <span className="font-semibold">{r.marketName}</span>, hideOnMobile: true },
    { id: "side", header: "Side", render: (r) => sideLabel(r.side), hideOnMobile: true },
    { id: "type", header: "Type", render: (r) => (r.kind === "open" ? "Open" : "Close") },
    { id: "size", header: "Size", render: (r) => `$${fmtUsd(r.sizeUsd)}` },
    { id: "collateral", header: "Collateral", render: (r) => `${fmtUsd(r.collateralUsdc)} USDC` },
    { id: "escrowed", header: "Escrowed", render: (r) => `${fmtUsd(r.escrowedUsdc)} USDC` },
    {
      id: "action",
      header: "Action",
      align: "right",
      hideOnMobile: true,
      render: (r) => <TableActionButton label="Cancel" onClick={() => onCancel(r)} disabled={cancelDisabled} />,
    },
  ];

  return (
    <PerpsTable
      columns={columns}
      data={orders}
      getRowKey={(r) => `${r.market}-${r.side}-${r.kind}`}
      getSide={(r) => r.side}
      emptyText="No open orders"
      mobileHeader={(r) => (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>{r.marketName}</span>
            <span className="text-[12px]">{sideLabel(r.side)}</span>
          </div>
          <TableActionButton label="Cancel" onClick={() => onCancel(r)} disabled={cancelDisabled} />
        </div>
      )}
    />
  );
};

export default OpenOrdersTable;
