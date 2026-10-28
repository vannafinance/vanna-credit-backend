"use client";

import { useEffect } from "react";
import { ensureFreshPrices } from "@/lib/solana/price-refresh";

/** Just under the refresher's one-minute window, so a click right after a re-warm never waits. */
const REWARM_MS = 55_000;

/**
 * Starts the fork price refresh while a form holds an amount (`active`), instead of on the submit
 * click, and keeps it warm every ~minute after that. Same once-a-minute rule and shared in-flight
 * request as the transaction's own `ensureFreshPrices()` call, so the click usually finds it done.
 */
export function usePrewarmPrices(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const warm = () => {
      if (document.visibilityState === "visible") void ensureFreshPrices().catch(() => undefined);
    };
    warm();
    const id = setInterval(warm, REWARM_MS);
    return () => clearInterval(id);
  }, [active]);
}
