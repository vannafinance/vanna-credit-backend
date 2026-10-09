"use client";
import { useQueries } from "@tanstack/react-query";
import { fetchWithTimeout } from "../async";
import { useUserStore } from "@/store/user";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import type { LiveVault } from "@/lib/solana/vault-state";
export function useVaults(id?: string) {
  const queries = useQueries({
    queries: VAULTS.filter((v) => !id || v.id === id).map((v) => ({
      queryKey: ["farm", "live-vaults", v.id],
      queryFn: async (): Promise<LiveVault[]> => {
        const r = await fetchWithTimeout(`/api/farm/vaults?id=${v.id}`);
        if (!r.ok) throw new Error("Vault data is unavailable");
        return r.json();
      },
      staleTime: 15_000,
      refetchInterval: 30_000,
    })),
  });
  return {
    data: queries.flatMap((q) => q.data ?? []),
    isLoading: queries.some((q) => q.isLoading),
    error: queries.find((q) => q.error)?.error,
  };
}
export function useVaultAccount() {
  const address = useUserStore((s) => s.address) ?? null;
  const account = useAccountSnapshot(address);
  return { address, ...account, margin: account.snapshot?.api.margin };
}
