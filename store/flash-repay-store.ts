import { create } from "zustand";

/**
 * Opens the Flash repay modal from any V3 page (Margin, Portfolio, Spot). In-memory only — nothing
 * is persisted. `transfer` = also withdraw the collateral to the wallet after repaying.
 */
export interface FlashRepayState {
  open: boolean;
  transfer: boolean;
  openFlashRepay: (opts?: { transfer?: boolean }) => void;
  close: () => void;
}

export const useFlashRepayStore = create<FlashRepayState>((set) => ({
  open: false,
  transfer: false,
  openFlashRepay: (opts) => set({ open: true, transfer: Boolean(opts?.transfer) }),
  close: () => set({ open: false }),
}));
