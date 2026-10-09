"use client";

/**
 * Farm list rows for the Basis vaults (Delta-Neutral tab), in the same eight-column V3 row /
 * sortable-header layout as the Kamino rows (./fm-ui.tsx, ./farm-v3.css) so both tabs feel the same.
 * Perena vaults are rows of the Kamino table itself (./farm-list.tsx).
 *
 * Data: fork vault state (`useVaults`, GET /api/farm/vaults), recorded APYs, Phoenix funding now
 * (public WebSocket, falling back to the latest published hourly rate), and the connected wallet's
 * margin-account receipt balance. Unknown APYs stay unavailable rather than becoming zero.
 */
import Link from "next/link";
import { apyText } from "@/lib/farm/yield";
import { useQueries } from "@tanstack/react-query";
import { fetchWithTimeout } from "@/lib/async";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import { useVaults, useVaultAccount } from "@/lib/farm/use-vaults";
import { fundingNowApr, usePhoenixFundingNow, vaultHref } from "@/lib/farm/basis-live";
import type { FundingResponse } from "@/lib/farm/nav-math";
import { Icon } from "@/components/v3/icons";
import { cmp, nf, spct, usd, usdC } from "@/components/v3/format";
import { Cell, SortHead, Venue, sortRows, type SortState } from "./fm-ui";

const BASIS_SYMBOLS = VAULTS.filter((v) => v.kind === "basis").map((v) => v.asset);

/** Funding now (annualised %) per basis market. */
function useFundingNow(): Record<string, number> {
  const live = usePhoenixFundingNow(BASIS_SYMBOLS);
  const history = useQueries({
    queries: BASIS_SYMBOLS.map((symbol) => ({
      queryKey: ["farm", "funding", symbol],
      staleTime: 5 * 60_000,
      queryFn: async (): Promise<FundingResponse> => {
        const r = await fetchWithTimeout(`/api/farm/funding?symbol=${symbol}`);
        if (!r.ok) throw new Error("Phoenix funding is unavailable");
        return r.json();
      },
    })),
  });
  const out: Record<string, number> = {};
  BASIS_SYMBOLS.forEach((s, i) => {
    out[s] = fundingNowApr(s, live, history[i].data ?? null) ?? 0;
  });
  return out;
}

export function VaultTable({
  query = "",
  keepAsset = () => true,
  keepApy = () => true,
  sort,
  onSort,
}: {
  query?: string;
  keepAsset?: (s: string) => boolean;
  /** The list's threshold filter (Vault APY, %). */
  keepApy?: (apy: number | null) => boolean;
  sort: SortState;
  onSort: (s: SortState) => void;
}) {
  const live = useVaults();
  const { margin } = useVaultAccount();
  const funding = useFundingNow();
  const q = query.trim().toLowerCase();
  const items = VAULTS.filter(
    (v) => v.kind === "basis" && (!q || `${v.name} ${v.asset} ${v.symbol} basis jupiter phoenix`.toLowerCase().includes(q)) && keepAsset(v.asset),
  )
    .map((v) => ({ v, s: live.data.find((x) => x.id === v.id) }))
    .filter(({ s }) => keepApy(s?.apy7 ?? null))
    .map(({ v, s }) => {
      const holding = margin?.collateral.find((c) => c.mint === v.mint);
      const tvl = s?.navUsd ?? 0;
      const cap = s?.capUsd ?? 0;
      const px = s?.sharePriceUsd ?? 0;
      const shares = px > 0 ? tvl / px : 0;
      const f = funding[v.asset] ?? 0;
      const delta = s?.netDeltaPct ?? 0;
      const status = s?.error ? "Data unavailable" : !s?.registered ? "Registration pending" : s.stale ? "NAV stale" : "1x hedge";
      return {
        v: { asset: v.name, prot: "Jupiter · Phoenix", dep: tvl, cap, apy: s?.apy7 ?? Number.NEGATIVE_INFINITY, fund: f, delta: Math.abs(delta), hold: holding?.usd ?? 0 },
        el: (
          <Link key={v.id} href={vaultHref(v.id)} className="fm-tr fm-row k8" aria-label={`Open ${v.name}`}>
            <Cell
              v={
                <span className="fm-tk">
                  <Icon sym="SOL" className="fm-chn" />
                  <Icon sym={v.asset} className="fm-ico16" />
                  {v.name}
                </span>
              }
              mini={["Basis", status]}
            />
            <Cell v={<Venue name="Jupiter · Phoenix" />} />
            <Cell v={`${cmp(shares)} ${v.symbol}`} mini={usd(tvl)} />
            <Cell v={usdC(cap)} mini={cap > 0 ? (tvl / cap > 0.9 ? "Almost full" : `${nf((tvl / cap) * 100, 2)}% used`) : "No cap"} />
            <Cell v={apyText(s?.apy7)} mini={s?.apy7Source === "deposit-event" ? "Deposit-event estimate" : undefined} />
            <Cell v={spct(f, 1)} cls={f < 0 ? "neg" : ""} />
            <Cell v={spct(delta, 2)} />
            <Cell v={`${nf(holding?.amount ?? 0, 4)} ${v.symbol}`} mini={usd(holding?.usd ?? 0)} />
          </Link>
        ),
      };
    });
  const rows = sortRows(items, sort).map((x) => x.el);
  return (
    <div className="fm-tbl" aria-label="Delta-neutral vaults">
      <SortHead
        cls="k8"
        sort={sort}
        onSort={onSort}
        cols={[
          ["Asset", "asset"],
          ["Protocol", "prot"],
          ["Total Deposits", "dep", "Vault shares outstanding, and their value (the vault's net asset value) on chain."],
          ["Capacity", "cap", "The most total exposure the vault accepts, and how much of it is used."],
          ["Vault APY", "apy", "Annualised share-price return. A deposit-event fallback is labelled as an estimate; missing history is never a zero return."],
          ["Funding Now", "fund", "Phoenix's current hourly funding, annualised; when positive, shorts get paid."],
          ["Net Delta", "delta", "Spot leg minus short leg, as a share of the short; near zero means price moves cancel out."],
          ["Holding", "hold"],
        ]}
      />
      {rows.length ? rows : <div className="fm-none">No vaults match these filters</div>}
      {live.error && <div className="fm-none">{live.error.message}</div>}
    </div>
  );
}
