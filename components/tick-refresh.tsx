"use client";

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useLedgerTick } from "@/contexts/ledger-subscriber";
import { useLiveTick } from "@/lib/tick-scope";
import { ACCOUNT_SNAPSHOT_KEY } from "@/hooks/use-account-snapshot";
import { PRICES_QUERY_KEY } from "@/hooks/use-token-prices";
import { EARN_POOLS_KEY } from "@/hooks/use-earn";

/**
 * Live reads refreshed on every slot tick (~8 s, paused while the tab is hidden). Only queries a page
 * has mounted refetch; the rest are just marked stale. History, pool details and other slow data are
 * left out: they refresh after the user's own transactions (lib/after-tx.ts) and on their own timers.
 */
export const TICK_KEYS: readonly QueryKey[] = [ACCOUNT_SNAPSHOT_KEY, PRICES_QUERY_KEY, EARN_POOLS_KEY];

/**
 * The one place that turns slot ticks into refreshes (replaces one effect per hook instance).
 * Skipped on quiet routes (lib/tick-scope.ts).
 */
export function TickRefresh() {
  const qc = useQueryClient();
  const { tick } = useLedgerTick();
  const live = useLiveTick();
  const last = useRef(tick);

  useEffect(() => {
    if (tick === last.current) return;
    last.current = tick;
    if (!live) return;
    for (const queryKey of TICK_KEYS) void qc.invalidateQueries({ queryKey }, { cancelRefetch: false });
  }, [tick, qc, live]);

  return null;
}
