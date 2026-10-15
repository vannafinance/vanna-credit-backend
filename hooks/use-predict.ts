"use client";

/**
 * React Query hooks for Predict (World.xyz markets on the fork). No browser storage: every figure
 * comes from `/api/predict/*` or the chain, and React Query's in-memory cache is the only cache.
 *
 * Query keys all start with "predict" so one invalidation refreshes the page after a trade.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getActiveSigner } from "@/lib/solana/wallet-bridge";
import { onTxStatus, showTxError, showTxStep, showTxSuccess } from "@/lib/tx-progress";
import { useUserStore } from "@/store/user";
import { usePoolData } from "@/hooks/use-earn";
import { markFreshReads } from "@/lib/fresh-reads";
import {
  executePredictTrade,
  fetchPredictActivity,
  fetchPredictEvent,
  fetchPredictEvents,
  fetchPredictPositions,
  requestPredictFaucet,
  type TradeResult,
} from "@/lib/predict/client";
import type { TradeLegRequest, TradeRequest } from "@/lib/predict/types";

export const PREDICT_KEY = ["predict"] as const;

/** Every listed event (World Groups / families grouped, live prices and pool balances). */
export function usePredictEvents(params: { cat?: string; q?: string } = {}) {
  return useQuery({
    queryKey: [...PREDICT_KEY, "events", params.cat ?? "", params.q ?? ""],
    queryFn: () => fetchPredictEvents(params).then((r) => r.events),
    refetchInterval: 20_000,
    staleTime: 10_000,
  });
}

/** One event by event id or any of its market ids. */
export function usePredictEvent(id: string | undefined) {
  return useQuery({
    queryKey: [...PREDICT_KEY, "event", id],
    queryFn: () => fetchPredictEvent(id!),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });
}

/**
 * What paired shares earn: the supply APY (%) of Vanna's USDC pool, live from GET /api/pools.
 * 0 until the pool state has loaded.
 */
export function usePredictRate(): number {
  const { pools } = usePoolData();
  return (pools.USDC?.supplyApr ?? 0) * 100;
}

/** The connected (or given) wallet's positions, summary, vault figures and importable tokens. */
export function usePredictPositions(owner?: string | null) {
  const connected = useUserStore((s) => s.address);
  const address = owner ?? connected;
  return useQuery({
    queryKey: [...PREDICT_KEY, "positions", address],
    queryFn: () => fetchPredictPositions(address!),
    enabled: Boolean(address),
    refetchInterval: 20_000,
  });
}

/** The wallet's reconstructed trade history (optionally one market). */
export function usePredictActivity(marketId?: string, owner?: string | null) {
  const connected = useUserStore((s) => s.address);
  const address = owner ?? connected;
  return useQuery({
    queryKey: [...PREDICT_KEY, "activity", address, marketId ?? ""],
    queryFn: () => fetchPredictActivity(address!, marketId),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  });
}

export interface PredictTradeInput {
  legs: TradeLegRequest[];
  pay?: TradeRequest["pay"];
  noPool?: boolean;
  /** Toast text on success (default: a summary of the legs). */
  successMessage?: string;
}

const describe = (legs: TradeLegRequest[]) =>
  legs.length === 1 ? `${legs[0].side === "buy" ? "Bought" : legs[0].side === "sell" ? "Sold" : "Supplied"} ${legs[0].outcome.toUpperCase()}` : `${legs.length} trades confirmed`;

/**
 * Single or multi-leg trade: one wallet approval (`signAllTransactions`) for the whole batch,
 * progress in the shared TransactionProgressModal, then a keeper merge of the touched pools.
 */
export function usePredictTrade() {
  const qc = useQueryClient();
  return useMutation<TradeResult, Error, PredictTradeInput>({
    mutationFn: async (input) => {
      const signer = getActiveSigner();
      showTxStep("Preparing your trade…");
      return executePredictTrade({ owner: signer.publicKey.toBase58(), legs: input.legs, pay: input.pay, noPool: input.noPool }, signer, (p) => {
        if (p.step === "building") showTxStep("Quoting and building transactions…");
        else if (p.step === "signing") showTxStep(p.total && p.total > 1 ? `Approve ${p.total} transactions in your wallet` : "Approve the transaction in your wallet");
        else if (p.step.startsWith("sending")) {
          showTxStep(`Step ${p.index! + 1}/${p.total}: ${p.step.replace(/^sending \d+\/\d+: /, "")}`);
          onTxStatus("sending");
        } else if (p.step === "merging") onTxStatus("Matching YES/NO pairs into the USDC Earn pool…");
      });
    },
    onSuccess: (result, input) => {
      const pooled = result.built.quotes.reduce((t, q) => t + q.pooled, 0);
      showTxSuccess(input.successMessage ?? `${describe(input.legs)}${pooled > 0 ? " · earning in the Vanna pool" : ""}`);
    },
    onError: (error) => showTxError(error.message),
    onSettled: () => {
      markFreshReads();
      return qc.invalidateQueries({ queryKey: PREDICT_KEY });
    },
  });
}

/** Fork-only test faucet: CASH (and optionally USDC) plus SOL for fees. */
export function usePredictFaucet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { address: string; amount?: number; usdc?: boolean }) => requestPredictFaucet(input.address, input.amount, input.usdc),
    onSettled: () => {
      markFreshReads();
      return qc.invalidateQueries({ queryKey: PREDICT_KEY });
    },
  });
}
