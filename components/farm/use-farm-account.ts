"use client";

/**
 * The connected wallet's Farm numbers for the V3 Farm screen — every figure from chain data the app
 * already reads, nothing estimated:
 *
 * - positions: the margin account's Kamino cTokens (`useFarmPositions`), valued exactly like the
 *   program values them for the health factor;
 * - earnings: underlying redeemable now − underlying put in (Σ farm-deposit − Σ farm-withdraw from the
 *   margin account's decoded on-chain history), at today's price. Only shown when that history is
 *   complete and has no liquidation (otherwise the cost basis is unknown → null, rendered "—");
 * - Net Farm APY: value-weighted Kamino supply APY minus the borrow cost of the Vanna debt funding
 *   it. The borrowed part of a position is the smaller of its value and the margin account's debt in
 *   the same token (the design's rule: borrow cost applies only to the part that came from a loan in
 *   that token), charged at that Vanna pool's current borrow rate;
 * - health factor: `useV3Account()` (program-exact, same number as Margin).
 *
 * The maths lives in {@link computeFarmAccount} (pure) so scripts can check it against the chain.
 */
import { useMemo } from "react";
import { useUserStore } from "@/store/user";
import { useFarmPools, useFarmPositions } from "@/lib/farm/use-farm";
import { useMarginHistory } from "@/hooks/use-margin";
import { usePoolData } from "@/hooks/use-earn";
import { useV3Account } from "@/hooks/use-v3-account";
import { priceKey } from "@/lib/account-model";
import type { FarmPool, FarmPosition } from "@/lib/solana/farm";
import type { MarginHistoryRow } from "@/lib/solana/history";

export interface FarmPositionRow extends FarmPosition {
  pool: FarmPool | null;
  /** Kamino supply APY (fraction), null when Kamino's API didn't answer. */
  apy: number | null;
  /** Underlying earned since the first deposit; null when the cost basis isn't known. */
  earnedUnits: number | null;
  earnedUsd: number | null;
  /** ms timestamp of the first farm-deposit into this vault, when in history. */
  since: number | null;
  /** USD of this position funded by Vanna debt in the same token, and that pool's borrow rate. */
  borrowedUsd: number;
  borrowApr: number | null;
}

export interface FarmTotals {
  /** Σ position value, USD. */
  tvl: number;
  /** Σ earnings, USD; null when any position's cost basis is unknown. */
  earned: number | null;
  /** Value-weighted supply APY (fraction); null with no positions or a missing APY. */
  grossApy: number | null;
  /** grossApy − Σ(borrowed USD × borrow rate) / tvl (fraction). */
  netApy: number | null;
  /** Σ borrowed USD across positions (for the tooltip). */
  borrowedUsd: number;
}

export interface FarmAccountInputs {
  positions: FarmPosition[];
  pools: FarmPool[];
  history: MarginHistoryRow[];
  /** True when the history scan reached the wallet's oldest signature. */
  historyComplete: boolean;
  /** Margin-account debt per symbol, USD. */
  debts: { symbol: string; usd: number }[];
  /** Vanna pool borrow rate per symbol (fraction). */
  borrowApr: Record<string, number | undefined>;
}

/** Pure Farm maths (see the module comment). */
export function computeFarmAccount(i: FarmAccountInputs): { rows: FarmPositionRow[]; totals: FarmTotals } {
  const liquidated = i.history.some((r) => r.type === "liquidation");
  // Debt per price key, consumed as positions claim it (one claim per token).
  const debtLeft = new Map<string, number>();
  for (const d of i.debts) debtLeft.set(priceKey(d.symbol), (debtLeft.get(priceKey(d.symbol)) ?? 0) + d.usd);

  const rows: FarmPositionRow[] = i.positions.map((p) => {
    const pool = i.pools.find((x) => x.id === p.poolId) ?? null;
    const farmRows = i.history.filter((r) => (r.type === "farm-deposit" || r.type === "farm-withdraw") && r.symbol === p.symbol && !r.vaultId);
    const deposited = farmRows.filter((r) => r.type === "farm-deposit").reduce((s, r) => s + Number(r.amount), 0);
    const withdrawn = farmRows.filter((r) => r.type === "farm-withdraw").reduce((s, r) => s + Number(r.amount), 0);
    const basis = deposited - withdrawn;
    const known = i.historyComplete && !liquidated && deposited > 0 && basis > 0;
    const earnedUnits = known ? p.underlying - basis : null;
    const unitPrice = p.underlying > 0 ? p.liquidityUsd / p.underlying : 0;
    const firstDeposit = farmRows.filter((r) => r.type === "farm-deposit").map((r) => r.timestamp).filter((t) => t > 0);

    const key = priceKey(p.symbol);
    const left = debtLeft.get(key) ?? 0;
    const borrowedUsd = Math.min(p.liquidityUsd, left);
    debtLeft.set(key, left - borrowedUsd);

    return {
      ...p,
      pool,
      apy: pool?.supplyApy ?? null,
      earnedUnits,
      // Sub-cent results are Kamino exchange-rate rounding, not earnings; show them as $0.00, not −$0.00.
      earnedUsd: earnedUnits === null ? null : Math.abs(earnedUnits * unitPrice) < 0.005 ? 0 : earnedUnits * unitPrice,
      since: firstDeposit.length ? Math.min(...firstDeposit) : null,
      borrowedUsd,
      borrowApr: i.borrowApr[p.symbol] ?? i.borrowApr[key] ?? null,
    };
  });

  const tvl = rows.reduce((s, r) => s + r.liquidityUsd, 0);
  const earned = rows.length && rows.every((r) => r.earnedUsd !== null) ? rows.reduce((s, r) => s + (r.earnedUsd ?? 0), 0) : rows.length ? null : 0;
  const apyKnown = rows.length > 0 && tvl > 0 && rows.every((r) => r.apy !== null);
  const grossApy = apyKnown ? rows.reduce((s, r) => s + r.liquidityUsd * (r.apy ?? 0), 0) / tvl : null;
  const costKnown = rows.every((r) => r.borrowedUsd === 0 || r.borrowApr !== null);
  const cost = rows.reduce((s, r) => s + r.borrowedUsd * (r.borrowApr ?? 0), 0);
  const netApy = grossApy !== null && costKnown ? grossApy - cost / tvl : null;
  return { rows, totals: { tvl, earned, grossApy, netApy, borrowedUsd: rows.reduce((s, r) => s + r.borrowedUsd, 0) } };
}

/** Farm positions + totals for the connected wallet (see {@link computeFarmAccount}). */
export function useFarmAccount() {
  const address = useUserStore((s) => s.address);
  const { pools, isLoading: poolsLoading } = useFarmPools();
  const { positions, isLoading: positionsLoading } = useFarmPositions(address);
  const { rows: history, history: page } = useMarginHistory();
  const { pools: vannaPools } = usePoolData();
  const account = useV3Account();

  const result = useMemo(() => {
    const borrowApr: Record<string, number | undefined> = {};
    for (const [sym, p] of Object.entries(vannaPools)) borrowApr[sym] = p.borrowApr;
    return computeFarmAccount({
      positions,
      pools,
      history,
      historyComplete: Boolean(page?.complete),
      debts: account.state?.debts ?? [],
      borrowApr,
    });
  }, [positions, pools, history, page?.complete, account.state, vannaPools]);

  return {
    connected: Boolean(address),
    pools,
    poolsLoading,
    positionsLoading,
    history,
    ...result,
    hf: account.now?.hf ?? null,
    hasMargin: account.hasMargin,
    account,
  };
}
