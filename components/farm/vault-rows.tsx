"use client";

/**
 * Farm list rows for the Basis vaults (Delta-Neutral tab), in the same eight-column V3 row /
 * sortable-header layout as the Kamino rows (./fm-ui.tsx, ./farm-v3.css) so both tabs feel the same.
 * Perena vaults are rows of the Kamino table itself (./farm-list.tsx).
 *
 * Data: fork vault state (`useVaults`, GET /api/farm/vaults), recorded APYs, Phoenix funding now and
 * open interest (public WebSocket `market` channel; funding falls back to the latest published hourly
 * rate), and the connected wallet's margin-account receipt balance. Unknown APYs stay unavailable
 * rather than becoming zero.
 */
import Link from "next/link";
import { apyText, vaultApy, type VaultApy } from "@/lib/farm/yield";
import { useQueries } from "@tanstack/react-query";
import { fetchWithTimeout } from "@/lib/async";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import { useVaults, useVaultAccount } from "@/lib/farm/use-vaults";
import { fundingNowApr, fundingOf, openInterestUsd, usePhoenixMarketNow, vaultHref, type PhoenixMarketNow } from "@/lib/farm/basis-live";
import { fundingStats, type FundingResponse } from "@/lib/farm/nav-math";
import { Icon } from "@/components/v3/icons";
import { cmp, nf, spct, usd, usdC } from "@/components/v3/format";
import { Cell, SortHead, Venue, sortRows, type SortState } from "./fm-ui";

const BASIS_SYMBOLS = VAULTS.filter((v) => v.kind === "basis").map((v) => v.asset);

/** Phoenix funding history per basis market (shared React Query cache with the vault pages). */
function useFundingHistory() {
  return useQueries({
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
}

/**
 * Headline APY per Basis vault id ({@link vaultApy}): the realized 7-day APY, or until a vault has
 * 7 days of share prices, the estimate from its last 7 days of Phoenix funding on the short share
 * (a few days of share-price history are never annualised).
 */
export function useBasisApys(): Record<string, VaultApy> {
  const live = useVaults();
  const history = useFundingHistory();
  const out: Record<string, VaultApy> = {};
  VAULTS.filter((v) => v.kind === "basis").forEach((v) => {
    const s = live.data.find((x) => x.id === v.id);
    const days = history[BASIS_SYMBOLS.indexOf(v.asset)]?.data?.days ?? [];
    out[v.id] = vaultApy(s?.apy7, fundingStats(days).avg7, s?.shortUsd, s?.navUsd);
  });
  return out;
}

/**
 * Funding now (annualised %) and the live market (open interest, mark) per basis market, from one
 * Phoenix WebSocket.
 */
function useMarketsNow(): { funding: Record<string, number>; markets: Record<string, PhoenixMarketNow> } {
  const markets = usePhoenixMarketNow(BASIS_SYMBOLS);
  const history = useFundingHistory();
  const live = fundingOf(markets);
  const funding: Record<string, number> = {};
  BASIS_SYMBOLS.forEach((s, i) => {
    funding[s] = fundingNowApr(s, live, history[i].data ?? null) ?? 0;
  });
  return { funding, markets };
}

/**
 * The Vault APY cell's single sub-label: whether the figure is an estimate (Phoenix funding, until a
 * vault has 7 days of history) or realized. Funding has its own column and the since-launch return /
 * low-TVL note live in the column tooltip and on the vault page, so the row stays one label.
 */
export function basisApyMinis(apy: VaultApy | undefined, apy7Source: string | null | undefined, returnSinceLaunchPct?: number | null, sinceLaunchDays?: number | null): string[] {
  void returnSinceLaunchPct;
  void sinceLaunchDays;
  // No sub-label under the APY (product request: keep the cell to the number only).
  void apy;
  void apy7Source;
  return [];
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
  const { funding, markets } = useMarketsNow();
  const apys = useBasisApys();
  const q = query.trim().toLowerCase();
  const items = VAULTS.filter(
    (v) => v.kind === "basis" && (!q || `${v.name} ${v.asset} ${v.symbol} basis jupiter phoenix`.toLowerCase().includes(q)) && keepAsset(v.asset),
  )
    .map((v) => ({ v, s: live.data.find((x) => x.id === v.id) }))
    .filter(({ v }) => keepApy(apys[v.id]?.value ?? null))
    .map(({ v, s }) => {
      const holding = margin?.collateral.find((c) => c.mint === v.mint);
      const tvl = s?.navUsd ?? 0;
      const cap = s?.capUsd ?? 0;
      const px = s?.sharePriceUsd ?? 0;
      const shares = px > 0 ? tvl / px : 0;
      const f = funding[v.asset] ?? 0;
      const market = markets[v.asset];
      const oiUsd = openInterestUsd(market) ?? 0;
      const oiUnits = market?.openInterest ?? 0;
      const status = s?.error ? "Data unavailable" : !s?.registered ? "Registration pending" : s.stale ? "NAV stale" : "1x hedge";
      return {
        v: { asset: v.name, prot: "Jupiter · Phoenix", dep: tvl, cap, apy: apys[v.id]?.value ?? Number.NEGATIVE_INFINITY, fund: f, oi: oiUsd, hold: holding?.usd ?? 0 },
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
            <Cell
              v={apyText(apys[v.id]?.value)}
              cls={(apys[v.id]?.value ?? 0) < 0 ? "neg" : ""}
              mini={basisApyMinis(apys[v.id], s?.apy7Source, s?.returnSinceLaunchPct, s?.sinceLaunchDays)}
            />
            <Cell v={spct(f, 1)} cls={f < 0 ? "neg" : ""} />
            <Cell v={usdC(oiUsd)} mini={`${cmp(oiUnits)} ${v.asset}`} />
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
          ["Vault APY", "apy", "Realized 7-day share-price APY once a vault has 7 days of history. Until then \"7D funding\": the last 7 days of Phoenix funding on the vault's short share, before fees (a few days of share price are too short to annualise; the real since-launch return is on the vault page). While TVL is small, one rebalance or entry cost can move the share price more than days of funding."],
          ["Funding Now", "fund", "Phoenix's current hourly funding, annualised; when positive, shorts get paid."],
          ["Open Interest", "oi", "Open interest of the vault's Phoenix perp market: the total size of open positions, counted on one side (every long has a matching short), live from Phoenix. Shown in USD at the mark price, with the size in the base asset below. A larger market absorbs the vault's short more easily."],
          ["Holding", "hold"],
        ]}
      />
      {rows.length ? rows : <div className="fm-none">No vaults match these filters</div>}
      {live.error && <div className="fm-none">{live.error.message}</div>}
    </div>
  );
}
