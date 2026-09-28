"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";

type LedgerCtx = {
  /** Increments (throttled) whenever the fork produces new slots. */
  tick: number;
  /** Latest observed slot. */
  latestLedger: number;
};

const LedgerContext = createContext<LedgerCtx>({ tick: 0, latestLedger: 0 });

/** Name kept from the Stellar app ("ledger" tick) so every consumer's invalidation pattern is unchanged. */
export const useLedgerTick = () => useContext(LedgerContext);

/** Minimum time between ticks — a slot is ~400ms, far too often to refetch on. */
const TICK_INTERVAL_MS = 8_000;
/** HTTP fallback poll when the WebSocket slot subscription is silent. */
const POLL_INTERVAL_MS = 10_000;

/**
 * Slot subscription replacing Stellar's ledger subscriber. Subscribes to `slotChange` over the
 * fork's WebSocket and emits a throttled `tick` consumers use to invalidate React Query caches:
 *
 *   useEffect(() => { qc.invalidateQueries({ queryKey: [...] }) }, [tick])
 *
 * Do NOT put `tick` in a queryKey (fresh cache slot per tick → loading flicker). If no slot
 * notification arrives (WS unreachable) it falls back to HTTP `getSlot` polling, so a missing
 * WebSocket never stalls the UI.
 */
export function LedgerSubscriberProvider({ children }: { children: React.ReactNode }) {
  const [tick, setTick] = useState(0);
  const [latestLedger, setLatestLedger] = useState(0);
  const { connection } = useConnection();

  useEffect(() => {
    let cancelled = false;
    let lastTickAt = 0;
    let lastNotificationAt = 0;
    let lastSlot = 0;

    const observe = (slot: number) => {
      if (cancelled || slot <= lastSlot) return;
      const first = lastSlot === 0;
      lastSlot = slot;
      setLatestLedger(slot);
      const now = Date.now();
      // The first observation is the baseline; later ones tick at most every TICK_INTERVAL_MS.
      if (!first && now - lastTickAt >= TICK_INTERVAL_MS && document.visibilityState !== "hidden") {
        lastTickAt = now;
        setTick((t) => t + 1);
      }
      if (first) lastTickAt = now;
    };

    let subscriptionId: number | null = null;
    try {
      subscriptionId = connection.onSlotChange((info) => {
        lastNotificationAt = Date.now();
        observe(info.slot);
      });
    } catch {
      subscriptionId = null;
    }

    const poll = async () => {
      if (cancelled || document.visibilityState === "hidden") return;
      if (Date.now() - lastNotificationAt < POLL_INTERVAL_MS) return; // WS is healthy
      try {
        observe(await connection.getSlot("confirmed"));
      } catch {
        // transient RPC failure — keep the last good state
      }
    };
    void poll();
    const interval = window.setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (subscriptionId !== null) void connection.removeSlotChangeListener(subscriptionId).catch(() => {});
    };
  }, [connection]);

  return <LedgerContext.Provider value={{ tick, latestLedger }}>{children}</LedgerContext.Provider>;
}
