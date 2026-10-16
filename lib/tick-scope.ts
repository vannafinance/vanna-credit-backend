"use client";

import { usePathname } from "next/navigation";

/**
 * Routes whose pages never read the account snapshot, oracle prices or pool states. The shared
 * queries stay mounted (layout providers), but their 8 s slot-tick refresh pauses here: each still
 * loads on first use, refreshes after the user's own transactions and resumes ticking on any other
 * route. Saves ~22 requests/min per tab (~112 fork calls/min with a wallet connected).
 */
const QUIET_ROUTE_PREFIXES = ["/predict", "/analytics"] as const;

export function isQuietRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return QUIET_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** True when the current page needs the live account/price/pool tick. */
export function useLiveTick(): boolean {
  return !isQuietRoute(usePathname());
}
