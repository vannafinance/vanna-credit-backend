"use client";

/**
 * Farm data + action hooks: single-asset Kamino Lend vaults farmed from the margin account.
 * Pools: `GET /api/farm/pools` (Kamino's live metrics). Positions: the margin account's Kamino
 * cTokens, read from the same on-chain margin snapshot as the Margin page. Actions: `farmDeposit`
 * / `farmWithdraw` (lib/solana/exec.ts, `margin_execute` through the KaminoLend adapter).
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchFarmPositions, listFarmPools, type FarmPosition } from "@/lib/solana/farm";
import { farmDeposit, farmWithdraw, type FarmDepositRequest, type FarmWithdrawRequest } from "@/lib/solana/exec";
import { describeError } from "@/lib/solana/errors";
import { onTxStatus, showTxError, showTxStep, showTxSuccess } from "@/lib/tx-progress";
import { refreshAfterTx } from "@/lib/after-tx";
import { FARM_POOLS_PLACEHOLDER, type FarmPoolConfig } from "./pools";

export function useFarmPools(): { pools: FarmPoolConfig[]; isLoading: boolean; error: string | null } {
  const query = useQuery({ queryKey: ["farm", "pools"], queryFn: listFarmPools, staleTime: 60_000 });
  return useMemo(
    () => ({
      pools: query.data ?? FARM_POOLS_PLACEHOLDER,
      isLoading: query.isLoading,
      error: query.error ? (query.error as Error).message : null,
    }),
    [query.data, query.isLoading, query.error],
  );
}

/** One pool by URL slug (case-insensitive), or null when unknown. */
export function useFarmPool(id: string | null | undefined): { pool: FarmPoolConfig | null; isLoading: boolean } {
  const { pools, isLoading } = useFarmPools();
  const pool = useMemo(() => (id ? pools.find((p) => p.id === id.toLowerCase()) ?? null : null), [pools, id]);
  return { pool, isLoading };
}

/** The wallet's farm positions (margin-held Kamino cTokens, valued like the health factor does). */
export function useFarmPositions(owner: string | null | undefined): { positions: FarmPosition[]; isLoading: boolean } {
  const query = useQuery({
    queryKey: ["farm", "positions", owner],
    queryFn: () => fetchFarmPositions(owner!),
    enabled: Boolean(owner),
    staleTime: 4_000,
  });
  return { positions: query.data ?? [], isLoading: query.isLoading && Boolean(owner) };
}

function useAfterFarmTx() {
  const qc = useQueryClient();
  // Farm positions and the account snapshot first, history and other views later.
  return () => refreshAfterTx(qc, ["farm", "margin", "earn"]);
}

/** Supply margin-account balance to a Kamino vault (`margin_execute` Kamino deposit). */
export function useFarmDeposit() {
  const after = useAfterFarmTx();
  return useMutation({
    mutationFn: async (req: FarmDepositRequest) => {
      showTxStep(`Farming ${req.symbol} on Kamino`);
      try {
        const result = await farmDeposit(req, { onStatus: onTxStatus });
        showTxSuccess(`Supplied ${req.symbol} to Kamino`);
        void after().catch(() => {});
        return result;
      } catch (error) {
        showTxError(describeError(error, "Farm deposit failed"));
        throw error;
      }
    },
  });
}

/** Redeem Kamino cTokens back into the margin account. */
export function useFarmWithdraw() {
  const after = useAfterFarmTx();
  return useMutation({
    mutationFn: async (req: FarmWithdrawRequest) => {
      showTxStep(`Withdrawing ${req.symbol} from Kamino`);
      try {
        const result = await farmWithdraw(req, { onStatus: onTxStatus });
        showTxSuccess(`Withdrew ≈${Number(result.underlying).toFixed(4)} ${req.symbol} to your margin account`);
        void after().catch(() => {});
        return result;
      } catch (error) {
        showTxError(describeError(error, "Farm withdraw failed"));
        throw error;
      }
    },
  });
}
