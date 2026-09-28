import createNewStore from "@/zustand/index";
import { TOKEN_SYMBOLS } from "@/lib/solana/tokens";

/** A registry symbol (lib/solana/tokens.ts). */
export type AssetType = string;

// Tracks which lending pool/asset the user has selected, shared across the
// pool list and any deposit/withdraw panels that act on that pool.

/** Slice shape: the selected asset and optional pool metadata for the detail view. */
export interface SelectedPoolState {
  selectedAsset: AssetType;
  selectedPoolData: {
    id: string;
    chain: string;
    title: string;
    tag?: string;
  } | null;
}

const initialState: SelectedPoolState = {
  selectedAsset: TOKEN_SYMBOLS[0],
  selectedPoolData: null,
};

/**
 * Selected-pool store. Defaults to the first registry token; not persisted (transient selection).
 */
export const useSelectedPoolStore = createNewStore(initialState, {
  name: "selected-pool-store",
  devTools: true,
  persist: false,
});

// Helper functions
/**
 * Sets the active asset and its pool metadata. When `poolData` is omitted,
 * synthesizes a default entry from the asset symbol (tagged "Active").
 */
export const setSelectedPool = (
  asset: AssetType,
  poolData?: {
    id: string;
    chain: string;
    title: string;
    tag?: string;
  }
) => {
  useSelectedPoolStore.getState().set({
    selectedAsset: asset,
    selectedPoolData: poolData || {
      id: asset,
      chain: asset,
      title: asset,
      tag: "Active"
    }
  });
};

/** Non-reactive read of the currently selected asset (for use outside React render). */
export const getSelectedAsset = (): AssetType => {
  return useSelectedPoolStore.getState().selectedAsset;
};