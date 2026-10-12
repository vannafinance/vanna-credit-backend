import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import { DEFERRED_REFRESH_MS, refreshAfterTx } from "./after-tx";

afterEach(() => { vi.useRealTimers(); });

/** A client with active observers on the given keys; returns the order queries were fetched in. */
function setup(keys: QueryKey[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const fetched: string[] = [];
  for (const queryKey of keys) {
    qc.setQueryData(queryKey, 0);
    new QueryObserver(qc, { queryKey, queryFn: async () => { fetched.push(JSON.stringify(queryKey)); return 1; } }).subscribe(() => {});
  }
  return { qc, fetched };
}

const KEYS: QueryKey[] = [
  ["margin", "account-snapshot", "wallet"],
  ["margin", "history", "wallet"],
  ["earn", "positions", "wallet"],
  ["earn", "pools"],
  ["earn", "history", "wallet"],
  ["perps", "view", "wallet"],
  ["oracle", "prices"],
];

describe("refreshAfterTx", () => {
  it("refreshes the account snapshot and the scope's critical reads before anything else", async () => {
    vi.useFakeTimers();
    const { qc, fetched } = setup(KEYS);
    await refreshAfterTx(qc, ["earn", "margin"]);
    expect(fetched.sort()).toEqual([
      '["earn","pools"]',
      '["earn","positions","wallet"]',
      '["margin","account-snapshot","wallet"]',
    ]);
  });

  it("refreshes the rest of the scopes after the delay, without re-reading the critical ones", async () => {
    vi.useFakeTimers();
    const { qc, fetched } = setup(KEYS);
    await refreshAfterTx(qc, ["earn", "margin"]);
    fetched.length = 0;
    await vi.advanceTimersByTimeAsync(DEFERRED_REFRESH_MS);
    expect(fetched.sort()).toEqual(['["earn","history","wallet"]', '["margin","history","wallet"]']);
  });

  it("never touches queries outside the transaction's scopes", async () => {
    vi.useFakeTimers();
    const { qc, fetched } = setup(KEYS);
    await refreshAfterTx(qc, ["margin"]);
    await vi.advanceTimersByTimeAsync(DEFERRED_REFRESH_MS);
    expect(fetched).not.toContain('["oracle","prices"]');
    expect(fetched).not.toContain('["perps","view","wallet"]');
    expect(fetched).not.toContain('["earn","pools"]');
  });
});
