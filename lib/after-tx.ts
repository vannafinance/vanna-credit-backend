import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { markFreshReads } from "./fresh-reads";

/** Areas of the app a confirmed transaction can change. Each maps to a top-level query-key prefix. */
export type TxScope = "margin" | "earn" | "farm" | "perps";

/**
 * Read first after a transaction: what the user is looking at. The account snapshot
 * (`hooks/use-account-snapshot.ts` ACCOUNT_SNAPSHOT_KEY) carries collateral, debts, health factor,
 * wallet balances and lender positions; the root MarginAccountHydrator copies it into the stores, so
 * no separate browser re-read of the margin account or wallet is needed.
 */
const ACCOUNT_SNAPSHOT: QueryKey = ["margin", "account-snapshot"];
const CRITICAL: Record<TxScope, readonly QueryKey[]> = {
  margin: [],
  earn: [["earn", "positions"], ["earn", "pools"], ["earn", "pool-details"]],
  farm: [["farm", "positions"], ["farm", "wallet-shares"], ["farm", "live-vaults"]],
  perps: [["perps", "view"]],
};

/**
 * Everything else under the scopes (history scans, other pages' views) refreshes after this delay:
 * it no longer competes with the critical reads, and the RPC has time to index the new transaction
 * so history picks it up on the first try.
 */
export const DEFERRED_REFRESH_MS = 2_000;

const startsWith = (key: QueryKey, prefix: QueryKey) => prefix.every((part, i) => key[i] === part);

/**
 * Refresh after a confirmed transaction: critical reads first (awaited), the rest of the scopes in the
 * background. Refreshes the same queries as invalidating each scope prefix, only in a better order.
 */
export async function refreshAfterTx(qc: QueryClient, scopes: readonly TxScope[]): Promise<void> {
  markFreshReads(); // the next reads skip the server caches: the user must see their own transaction
  const first = [ACCOUNT_SNAPSHOT, ...scopes.flatMap((s) => CRITICAL[s])];
  await Promise.allSettled(first.map((queryKey) => qc.invalidateQueries({ queryKey })));
  setTimeout(() => {
    void qc.invalidateQueries({
      predicate: (q) => scopes.some((s) => q.queryKey[0] === s) && !first.some((p) => startsWith(q.queryKey, p)),
    });
  }, DEFERRED_REFRESH_MS);
}
