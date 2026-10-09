"use client";
import "./live-vault.css";
import Link from "next/link";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import { useVaults, useVaultAccount } from "@/lib/farm/use-vaults";
import { usd, nf } from "@/components/v3/format";
import { Icon } from "@/components/v3/icons";
import { Cell, Venue } from "./fm-ui";
export const vaultHref = (id: string) =>
  id.startsWith("basis-")
    ? `/farm/basis/${id.slice(6)}`
    : `/farm/perena/${id.slice(7)}`;
export function LiveVaultTable({
  kind,
  positions = false,
  query = "",
  keepAsset = () => true,
}: {
  kind?: "basis" | "perena";
  positions?: boolean;
  query?: string;
  keepAsset?: (s: string) => boolean;
}) {
  const live = useVaults(),
    { margin } = useVaultAccount();
  const defs = VAULTS.filter(
    (v) =>
      (!kind || v.kind === kind) &&
      (!query || v.name.toLowerCase().includes(query.toLowerCase())) &&
      keepAsset(v.asset),
  );
  const rows = defs.filter(
    (v) =>
      !positions ||
      (margin?.collateral.some((c) => c.mint === v.mint && c.amount > 0) ??
        false),
  );
  if (positions && !rows.length) return null;
  return (
    <section
      className="fm-tbl"
      aria-label={
        positions
          ? "Vault positions"
          : kind === "perena"
            ? "Perena vaults"
            : "Basis vaults"
      }
    >
      {kind === "perena" && <h2 className="lv-heading">Perena vaults</h2>}
      <div className="fm-tr fm-th k5">
        <span>Vault</span>
        <span>Protocol</span>
        <span>{positions ? "Position value" : "Total value locked"}</span>
        <span>{positions ? "Receipt balance" : "Share price"}</span>
        <span>{positions ? "" : "Your holding"}</span>
      </div>
      {rows.map((v) => {
        const state = live.data?.find((x) => x.id === v.id),
          holding = margin?.collateral.find((c) => c.mint === v.mint);
        return (
          <Link key={v.id} href={vaultHref(v.id)} className="fm-tr fm-row k5">
            <Cell
              v={
                <span className="fm-tk">
                  <Icon sym={v.asset} className="fm-ico16" />
                  {v.name}
                </span>
              }
              mini={
                state?.registered
                  ? state.stale
                    ? "NAV stale"
                    : "Registered on Vanna"
                  : "Registration pending"
              }
            />
            <Cell
              v={
                <Venue
                  name={v.kind === "basis" ? "Jupiter · Phoenix" : "Perena"}
                />
              }
            />
            <Cell
              v={
                positions
                  ? usd(holding?.usd ?? 0)
                  : usd(state?.navUsd ?? 0)
              }
              mini={state?.error ? "Data unavailable" : undefined}
            />
            <Cell
              v={
                positions
                  ? `${nf(holding?.amount ?? 0, 6)} ${v.symbol}`
                  : usd(state?.sharePriceUsd ?? 0, 6)
              }
            />
            <Cell
              v={
                positions
                  ? "Manage"
                  : `${nf(holding?.amount ?? 0, 6)} ${v.symbol}`
              }
              mini={!positions && holding ? usd(holding.usd) : undefined}
            />
          </Link>
        );
      })}
      {!rows.length && (
        <div className="fm-none">No vaults match these filters</div>
      )}
      {live.isLoading && (
        <p className="lv-note" role="status">
          Loading live vault state…
        </p>
      )}
      {live.error && (
        <p className="lv-error" role="alert">
          {live.error.message}
        </p>
      )}
    </section>
  );
}
