"use client";

/**
 * Farm list rows for the Basis (Delta-Neutral tab) and Perena (Lending/Single Assets tab) vaults, in
 * the same V3 row / sortable-header style as the Kamino rows (./fm-ui.tsx, ./farm-v3.css).
 *
 * Data: fork vault state (`useVaults`, GET /api/farm/vaults), recorded APYs, Phoenix funding now
 * (public WebSocket, falling back to the latest published hourly rate), and the connected wallet's
 * margin-account receipt balance. Unknown figures render as the zero form.
 */
import Link from "next/link";
import { useQueries } from "@tanstack/react-query";
import { fetchWithTimeout } from "@/lib/async";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import { useVaults, useVaultAccount } from "@/lib/farm/use-vaults";
import { fundingNowApr, usePhoenixFundingNow, vaultHref } from "@/lib/farm/basis-live";
import type { FundingResponse } from "@/lib/farm/nav-math";
import { Icon } from "@/components/v3/icons";
import { nf, pct, spct, usd, usdC } from "@/components/v3/format";
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
  kind,
  query = "",
  keepAsset = () => true,
  sort,
  onSort,
}: {
  kind: "basis" | "perena";
  query?: string;
  keepAsset?: (s: string) => boolean;
  sort: SortState;
  onSort: (s: SortState) => void;
}) {
  const live = useVaults();
  const { margin } = useVaultAccount();
  const funding = useFundingNow();
  const basis = kind === "basis";
  const q = query.trim().toLowerCase();
  const items = VAULTS.filter(
    (v) => v.kind === kind && (!q || `${v.name} ${v.asset} ${v.symbol} ${basis ? "basis jupiter phoenix" : "perena"}`.toLowerCase().includes(q)) && keepAsset(v.asset),
  ).map((v) => {
    const s = live.data.find((x) => x.id === v.id);
    const holding = margin?.collateral.find((c) => c.mint === v.mint);
    const tvl = s?.navUsd ?? 0;
    const cap = s?.capUsd ?? 0;
    const f = funding[v.asset] ?? 0;
    const status = s?.error ? "Data unavailable" : !s?.registered ? "Registration pending" : s.stale ? "NAV stale" : basis ? "1x hedge" : "Receipt in margin";
    return {
      v: { asset: v.name, prot: basis ? "Jupiter · Phoenix" : "Perena", tvl, apy: s?.apy7 ?? 0, fund: basis ? f : (s?.sharePriceUsd ?? 0), hold: holding?.usd ?? 0 },
      el: (
        <Link key={v.id} href={vaultHref(v.id)} className="fm-tr fm-row k6" aria-label={`Open ${v.name}`}>
          <Cell
            v={
              <span className="fm-tk">
                <Icon sym={basis ? v.asset : v.symbol} className="fm-ico16" />
                {v.name}
              </span>
            }
            mini={[basis ? "Basis" : "Perena", status]}
          />
          <Cell v={<Venue name={basis ? "Jupiter · Phoenix" : "Perena"} />} />
          {basis ? (
            <Cell v={usdC(tvl)} mini={cap > 0 ? (tvl / cap > 0.9 ? "Almost full" : `${nf((tvl / cap) * 100, 2)}% of ${usdC(cap)}`) : "No cap"} />
          ) : (
            <Cell v={usdC(tvl)} mini={usd(tvl)} />
          )}
          <Cell v={pct(s?.apy7 ?? 0, 2)} mini={`30D ${pct(s?.apy30 ?? 0, 2)}`} />
          {basis ? <Cell v={spct(f, 1)} mini={`${v.asset}-PERP`} cls={f < 0 ? "neg" : ""} /> : <Cell v={usd(s?.sharePriceUsd ?? 0, 6)} mini={`per ${v.symbol}`} />}
          <Cell v={`${nf(holding?.amount ?? 0, 4)} ${v.symbol}`} mini={usd(holding?.usd ?? 0)} />
        </Link>
      ),
    };
  });
  const rows = sortRows(items, sort).map((x) => x.el);
  return (
    <div className="fm-tbl" aria-label={basis ? "Delta-neutral vaults" : "Perena vaults"}>
      <SortHead
        cls="k6"
        sort={sort}
        onSort={onSort}
        cols={[
          ["Vault", "asset"],
          ["Protocol", "prot"],
          [basis ? "TVL / Cap" : "TVL", "tvl", basis ? "Net asset value in the vault now, and the most total exposure it accepts." : "Receipt supply × share price, on chain."],
          ["Vault APY", "apy", "Annualised share-price change over the last 7 days (30 days below). 0.00% until enough share prices are recorded."],
          basis ? ["Funding Now", "fund", "Phoenix's current hourly funding, annualised; when positive, shorts get paid."] : ["Share Price", "fund", "USD per receipt, from Perena's on-chain price account."],
          ["Holding", "hold"],
        ]}
      />
      {rows.length ? rows : <div className="fm-none">No vaults match these filters</div>}
      {live.error && <div className="fm-none">{live.error.message}</div>}
    </div>
  );
}
