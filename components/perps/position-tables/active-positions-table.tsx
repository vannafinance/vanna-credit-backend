"use client";

import { useTheme } from "@/contexts/theme-context";
import type { PerpPosition } from "@/lib/solana/perps-types";
import { fmtPrice, fmtSigned, fmtTokenSize, fmtUsd } from "../perps-format";
import { PerpsColumn, PerpsTable, TableActionButton } from "./perps-table";

interface ActivePositionsTableProps {
  positions: PerpPosition[];
  onClose: (position: PerpPosition) => void;
  closeDisabled: boolean;
}

const sideLabel = (side: PerpPosition["side"]) => (
  <span className={`font-semibold ${side === "long" ? "text-[#24A0A9]" : "text-[#FC5457]"}`}>
    {side === "long" ? "Long" : "Short"}
  </span>
);

const ActivePositionsTable = ({ positions, onClose, closeDisabled }: ActivePositionsTableProps) => {
  const { isDark } = useTheme();

  const columns: PerpsColumn<PerpPosition>[] = [
    { id: "market", header: "Market", render: (r) => <span className="font-semibold">{r.marketName}</span>, hideOnMobile: true },
    { id: "side", header: "Side", render: (r) => sideLabel(r.side), hideOnMobile: true },
    {
      id: "size",
      header: "Position size",
      render: (r) => (
        <div className="flex flex-col gap-0.5">
          <span>{fmtTokenSize(r.sizeTokens)} {r.market}</span>
          <span className="text-[11px] opacity-70">${fmtUsd(r.sizeUsd)}</span>
        </div>
      ),
    },
    { id: "entry", header: "Entry", render: (r) => fmtPrice(r.entryPrice) },
    { id: "mark", header: "Mark", render: (r) => fmtPrice(r.markPrice) },
    { id: "collateral", header: "Collateral", render: (r) => `${fmtUsd(r.collateralUsdc)} USDC` },
    { id: "leverage", header: "Leverage", render: (r) => `${r.leverage.toFixed(2)}x` },
    {
      id: "pnl",
      header: "PnL",
      render: (r) => {
        const color = r.pnlUsd > 0 ? "text-[#24A0A9]" : r.pnlUsd < 0 ? "text-[#FC5457]" : "";
        return (
          <span className={`font-semibold ${color}`}>
            {fmtSigned(r.pnlUsd)} <span className="opacity-80 text-[11px]">({fmtSigned(r.pnlPercent)}%)</span>
          </span>
        );
      },
    },
    { id: "equity", header: "Equity", render: (r) => `$${fmtUsd(r.equityUsd)}` },
    {
      id: "liq",
      header: "Liq. price",
      // With debt: the index price at which the whole margin reaches HF 1.10 (Vanna liquidates).
      // Without debt Vanna never liquidates; the risk is the position's own equity reaching zero.
      render: (r) =>
        r.liquidationPrice != null ? (
          fmtPrice(r.liquidationPrice)
        ) : (
          <span title="No debt on the margin account, so Vanna can't liquidate it. This is the price at which this position's equity reaches zero.">
            {fmtPrice(r.zeroEquityPrice)} <span className="text-[10px] opacity-70">(equity 0)</span>
          </span>
        ),
    },
    {
      id: "action",
      header: "Action",
      align: "right",
      hideOnMobile: true,
      render: (r) => <TableActionButton label="Close" onClick={() => onClose(r)} disabled={closeDisabled} />,
    },
  ];

  return (
    <PerpsTable
      columns={columns}
      data={positions}
      getRowKey={(r) => `${r.market}-${r.side}`}
      getSide={(r) => r.side}
      emptyText="No open positions"
      mobileHeader={(r) => (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>{r.marketName}</span>
            <span className="text-[12px]">{sideLabel(r.side)}</span>
          </div>
          <TableActionButton label="Close" onClick={() => onClose(r)} disabled={closeDisabled} />
        </div>
      )}
    />
  );
};

export default ActivePositionsTable;
