"use client";

import { useState } from "react";
import { useTheme } from "@/contexts/theme-context";
import { useCancelPerpOrder, useClosePerp, usePerpsHistory } from "@/hooks/use-perps";
import type { PerpPosition, PerpsView } from "@/lib/solana/perps-types";
import { AnimatedTabs } from "../ui/animated-tabs";
import { Button } from "../ui/button";
import { Modal } from "../ui/modal";
import ActivePositionsTable from "./position-tables/active-positions-table";
import OpenOrdersTable from "./position-tables/open-orders-table";
import TradeHistoryTable from "./position-tables/trade-history-table";
import { ClosePositionModal } from "./modals/close-position-modal";
import { CloseAllPositionsModal } from "./modals/close-all-positions-modal";

type PerpsTab = "position" | "openOrders" | "history";

interface PositionTablesProps {
  view: PerpsView | undefined;
  address: string | null;
  connectWallet: () => void;
}

const PositionTables = ({ view, address, connectWallet }: PositionTablesProps) => {
  const { isDark } = useTheme();
  const [activeTab, setActiveTab] = useState<PerpsTab>("position");
  const history = usePerpsHistory(activeTab === "history");
  const [closing, setClosing] = useState<PerpPosition | null>(null);
  const [isCloseAllOpen, setIsCloseAllOpen] = useState(false);
  const [isClosingAll, setIsClosingAll] = useState(false);

  const closePerp = useClosePerp();
  const cancelOrder = useCancelPerpOrder();

  const positions = address ? (view?.positions ?? []) : [];
  const orders = address ? (view?.orders ?? []) : [];
  const busy = closePerp.isPending || cancelOrder.isPending || isClosingAll;

  const tabs = [
    { id: "position", label: `Positions (${positions.length})` },
    { id: "openOrders", label: `Open orders (${orders.length})` },
    { id: "history", label: "History" },
  ];

  /** Close every position one after another; stops at the first failure (already toasted). */
  const closeAll = async () => {
    setIsCloseAllOpen(false);
    setIsClosingAll(true);
    try {
      for (const p of positions) {
        await closePerp.mutateAsync({ market: p.market, side: p.side });
      }
    } catch {
      // the mutation hook shows the error toast
    } finally {
      setIsClosingAll(false);
    }
  };

  return (
    <div className={`w-full rounded-lg ${isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"} flex flex-col gap-1 p-2`}>
      {/* Tabs */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="overflow-x-auto no-scrollbar">
          <AnimatedTabs
            type="underline"
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tabId) => setActiveTab(tabId as PerpsTab)}
            containerClassName="!bg-transparent"
            tabClassName="text-[12px]"
          />
        </div>
        {activeTab === "position" && address && positions.length > 0 && (
          <div className="flex items-center justify-end gap-1 shrink-0 pb-1">
            <Button
              text={isClosingAll ? "Closing…" : "Close All"}
              size="small"
              type="ghost"
              disabled={busy}
              onClick={() => setIsCloseAllOpen(true)}
            />
          </div>
        )}
      </div>

      {!address ? (
        <div
          className={`w-full min-h-[240px] flex items-center justify-center rounded-lg border ${isDark ? "bg-[#222222] border-[#333333]" : "bg-gray-50 border-[#E2E2E2]"}`}
        >
          <button
            type="button"
            onClick={connectWallet}
            className={`cursor-pointer px-6 py-3 font-semibold rounded-lg transition-all hover:opacity-80 ${isDark ? "bg-[#3D2A6E] text-[#B99BFF]" : "bg-[#F1EBFD] text-[#703AE6]"}`}
          >
            Connect a wallet
          </button>
        </div>
      ) : (
        <>
          {activeTab === "position" && (
            <ActivePositionsTable positions={positions} onClose={setClosing} closeDisabled={busy} />
          )}
          {activeTab === "openOrders" && (
            <OpenOrdersTable
              orders={orders}
              cancelDisabled={busy}
              onCancel={(o) => cancelOrder.mutate({ market: o.market, side: o.side })}
            />
          )}
          {activeTab === "history" && <TradeHistoryTable rows={history.rows} loading={history.isLoading} />}
        </>
      )}

      <Modal open={closing !== null} onClose={() => setClosing(null)}>
        {closing && (
          <ClosePositionModal
            position={closing}
            onClose={() => setClosing(null)}
            onConfirm={(sizeUsd) => {
              closePerp.mutate({ market: closing.market, side: closing.side, sizeUsd });
              setClosing(null);
            }}
          />
        )}
      </Modal>

      <Modal open={isCloseAllOpen} onClose={() => setIsCloseAllOpen(false)}>
        <CloseAllPositionsModal
          count={positions.length}
          onClose={() => setIsCloseAllOpen(false)}
          onConfirm={() => void closeAll()}
        />
      </Modal>
    </div>
  );
};

export default PositionTables;
