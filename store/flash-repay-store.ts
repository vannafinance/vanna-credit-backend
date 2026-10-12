import { create } from "zustand";

/**
 * Opens the Flash repay modal from any V3 page (Margin, Portfolio, Spot). In-memory only — nothing
 * is persisted. `transfer` = also withdraw the collateral to the wallet after repaying.
 * `minimized`: a running Flash repay was put away; it keeps running and shows as a small progress
 * card at the bottom right until it is opened again (`restore`) or, once finished, closed.
 */
export interface FlashRepayState {
  open: boolean;
  transfer: boolean;
  minimized: boolean;
  openFlashRepay: (opts?: { transfer?: boolean }) => void;
  close: () => void;
  minimize: () => void;
  restore: () => void;
}

export const useFlashRepayStore = create<FlashRepayState>((set) => ({
  open: false,
  transfer: false,
  minimized: false,
  // Opening while a minimized run is still mounted just brings that run back.
  openFlashRepay: (opts) => set((s) => (s.open ? { minimized: false } : { open: true, minimized: false, transfer: Boolean(opts?.transfer) })),
  close: () => set({ open: false, minimized: false }),
  minimize: () => set({ minimized: true }),
  restore: () => set({ minimized: false }),
}));
