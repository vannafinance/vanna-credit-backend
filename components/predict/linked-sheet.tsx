"use client";

/**
 * Linked wallets sheet (design predict.js `sheetMain`), on real data: the connected Solana wallet,
 * the World positions in it, and "Start earning" (deposit legs into Vanna's pool, one approval).
 * Linking more wallets, Polymarket accounts and withdrawing pooled shares back to the wallet are
 * not built yet, so they are shown disabled as "Coming soon" — never with sample positions.
 * Open state is an in-memory store (no persistence) so the list, event page and Portfolio share it.
 */
import { create } from "zustand";
import { Icon, IC } from "@/components/v3/icons";
import { Modal } from "@/components/v3/ui";
import { usd } from "@/components/v3/format";
import { useWallet } from "@/hooks/use-wallet";
import { importOf, rowsOf, useEventMap, usePredictAccount, useStartEarning, PosTable } from "./positions";
import { PIC } from "./ui";
import "./predict-v3.css";

export const useLinkedSheet = create<{ open: boolean }>(() => ({ open: false }));
export const openLinkedSheet = () => useLinkedSheet.setState({ open: true });
const closeLinkedSheet = () => useLinkedSheet.setState({ open: false });

/** "7xKX…9fQ2" */
export const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

function SheetBody() {
  const acct = usePredictAccount();
  const { connectWallet } = useWallet();
  const events = useEventMap();
  const earn = useStartEarning();
  if (!acct.connected)
    return (
      <>
        <h2>Linked wallets</h2>
        <p className="msub">Connect a wallet to see your positions.</p>
        <button type="button" className="btn-p g" style={{ marginTop: 20 }} onClick={() => connectWallet()}>
          Connect wallet
        </button>
      </>
    );
  const rows = rowsOf(acct.data);
  const walletRows = rows.filter((r) => r.kind === "wallet");
  const idle = acct.data?.importable ?? [];
  const idleV = idle.reduce((t, x) => t + x.value, 0);
  const walletV = walletRows.reduce((t, r) => t + r.value, 0);
  return (
    <>
      <h2>Linked wallets</h2>
      <p className="msub">World positions in your wallet count in your Vanna portfolio. Start earning moves them into Vanna&apos;s pool.</p>
      <div className="pd-wl">
        <div className="pd-wr">
          <Icon sym="SOL" className="pd-i30" />
          <span className="pd-wr-n">
            <b>Connected wallet</b>
            <small className="num">
              <span>Solana wallet</span>
              <span className="pd-addr-t">{shortAddr(acct.address!)}</span>
            </small>
          </span>
          <span className="num pd-wr-c">
            <b>
              {walletRows.length} position{walletRows.length === 1 ? "" : "s"}
            </b>
            <small>{usd(walletV)}</small>
          </span>
          <span className="pd-wr-a">
            <span className="mini">Connected</span>
          </span>
        </div>
      </div>
      <button type="button" className="btn-o pd-addw" disabled title="Coming soon">
        {PIC.plus}Add wallet <span className="pd-soon">Coming soon</span>
      </button>
      <div className="pd-oh sub">
        <h2>World positions in your wallet</h2>
        <span className="num">{walletRows.length}</span>
      </div>
      <PosTable
        rows={walletRows}
        events={events}
        busy={earn.busy}
        onOpen={closeLinkedSheet}
        onEarn={(r) => {
          const x = importOf(acct.data, r);
          if (x) earn.start([x]);
        }}
        empty={acct.loading ? "Loading your positions…" : "No World positions in your wallet. Shares you buy on Vanna go straight into the pool."}
      />
      {idle.length > 0 && (
        <div className="pd-ifoot num">
          <span>
            <b>
              {idle.length} World position{idle.length > 1 ? "s" : ""} not earning, {usd(idleV)}
            </b>
            <small>They stay yours. You can sell them from the pool any time.</small>
          </span>
          <button type="button" className="btn-p g" disabled={earn.busy} onClick={() => earn.start(idle)}>
            Start earning on all
          </button>
        </div>
      )}
      <p className="pd-fact">
        {IC.clock}
        <span>Withdrawing pooled shares back to your wallet is coming soon. Selling works now from any market page.</span>
      </p>
      <p className="pd-fact">
        <Icon sym="POLY" className="pd-i16" />
        <span>Linking a Polymarket account is coming soon.</span>
      </p>
    </>
  );
}

/** The sheet itself; mount once per page (Predict list, event page, Portfolio). */
export function LinkedSheet() {
  const open = useLinkedSheet((s) => s.open);
  if (!open) return null;
  return (
    <Modal wide className="pd-sheetm" onClose={closeLinkedSheet}>
      <div className="pd-sheet">
        <SheetBody />
      </div>
    </Modal>
  );
}
