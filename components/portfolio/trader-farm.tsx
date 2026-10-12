"use client";

/**
 * Portfolio → Trader → Farm: every Farm position the margin account holds, like the Farm page's
 * Positions tab. Kamino Lend positions (margin-held cTokens valued like the health factor values
 * them, `useFarmPositions`) with Kamino's supply APY (`useFarmPools`) and earnings from the margin's
 * own farm-deposit / farm-withdraw events; plus Basis and Perena vault shares (`p.vaults`: value at
 * NAV now, earned = value − net USDC put in) with the Farm page's APYs (Basis: realized 7D or the
 * Phoenix-funding estimate; Perena: its published 7D APY). The history lists every deposit and
 * withdrawal, vaults labelled with their name. The Farm Equity card shows the current value only
 * (no on-chain value-over-time series).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { IC, Icon } from "@/components/v3/icons";
import { pct, sUsd, tokFmt, usd } from "@/components/v3/format";
import { useFarmStore } from "@/store/farm-store";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import { perenaProduct, usePerenaMarket, vaultHref } from "@/lib/farm/basis-live";
import { useBasisApys } from "@/components/farm/vault-rows";
import type { Portfolio } from "./use-portfolio";
import { Badge, ChartCard, Ct, Grid, HistNav, InfoCard, Success, TT, Tag, TokCell, TxCell, Venue, when } from "./pf-ui";
import { VannaLoader } from "@/components/v3/vanna-loader";

const HIST_COLS = ".9fr .9fr 1.8fr .7fr 1fr";

export function TraderFarm({ p }: { p: Portfolio }) {
  const router = useRouter();
  const setFarmData = useFarmStore((s) => s.set);
  const [view, setView] = useState<"cur" | "hist">("cur");
  const [q, setQ] = useState("");
  const { farmPositions: list, farmPools: pools, farmBySym, px } = p;
  const basisApys = useBasisApys();
  const perenaMarket = usePerenaMarket();
  // Basis / Perena shares held in the margin account, with the same APY the Farm page shows (%).
  const vaults = p.vaults
    .filter((v) => v.shares > 0)
    .map((v) => ({ ...v, apy: v.def.kind === "basis" ? basisApys[v.def.id]?.value ?? null : perenaProduct(perenaMarket, v.def.id).apy7 ?? null }));
  const kaminoTot = list.reduce((t, f) => t + f.liquidityUsd, 0);
  const tot = kaminoTot + vaults.reduce((t, v) => t + v.valueUsd, 0);
  const apyOf = (id: string) => pools.find((x) => x.id === id)?.supplyApy ?? null;
  const withApy = list.filter((f) => apyOf(f.poolId) !== null);
  const vaultsWithApy = vaults.filter((v) => v.apy !== null);
  const wBase = withApy.reduce((t, f) => t + f.liquidityUsd, 0) + vaultsWithApy.reduce((t, v) => t + v.valueUsd, 0);
  const wSum = withApy.reduce((t, f) => t + f.liquidityUsd * (apyOf(f.poolId) ?? 0) * 100, 0) + vaultsWithApy.reduce((t, v) => t + v.valueUsd * (v.apy ?? 0), 0);
  const wApy = wBase > 0 ? wSum / wBase : null;
  const holdings = p.acct.now?.holdings ?? 0;
  const earned = p.totals.farmEarned === null && p.totals.vaultEarned === null ? null : (p.totals.farmEarned ?? 0) + (p.totals.vaultEarned ?? 0);
  const hist = p.margin.rows.filter((r) => r.type === "farm-deposit" || r.type === "farm-withdraw");
  const open = (id: string) => {
    setFarmData({ tabType: "single" });
    router.push(`/farm/${id}`);
  };
  const match = (text: string) => !q || text.toLowerCase().includes(q.toLowerCase());
  const rows = list.filter((f) => match(`${f.symbol} ${f.receiptSymbol} kamino`));
  const vaultRows = vaults.filter((v) => match(`${v.def.name} ${v.def.symbol} ${v.def.kind === "basis" ? "basis delta-neutral jupiter phoenix" : "perena"}`));

  return (
    <>
      <div className="pf-row2">
        <InfoCard
          title="Farming Info"
          rows={[
            ["Total Farm Value", usd(tot)],
            ["Active Vaults", String(list.length + vaults.length)],
            ["APY before borrow cost", pct(wApy ?? 0), wApy !== null && wApy > 0 ? "pf-up" : "", TT.farmApy],
            ["Share of Margin Account", pct(holdings > 0 ? (tot / holdings) * 100 : 0, 1), "", TT.farmShare],
          ]}
        />
        <ChartCard
          title="Farm Equity"
          value={usd(tot)}
          sub={`${earned === null ? usd(0) : sUsd(earned)} earned`}
          series={null}
          empty="Value over time isn't recorded on-chain; the current figure is above."
        />
      </div>
      <section className="pf-tbl">
        <div className="pf-tbar">
          <HistNav value={view} onChange={setView} />
        </div>
        {view === "cur" && (
          <div className="pf-ftools">
            <label className="search pf-search">
              {IC.search}
              <input placeholder="Pools" aria-label="Search pools" value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <span className="pf-flex" />
            <button type="button" className="pf-lnk" onClick={() => router.push("/farm")}>
              Open Farm
            </button>
          </div>
        )}
        {view === "hist" ? (
          <Grid
            cols={HIST_COLS}
            heads={["Date", "Type", "Amount", "Status", "Tx Hash"]}
            empty={p.margin.isLoading ? <VannaLoader size="block" /> : "No transactions yet"}
            rows={hist.map((x, i) => ({
              key: `${x.signature}-${i}`,
              cells: [
                <Ct key="d">{when(x.timestamp)}</Ct>,
                <Badge key="t" act={x.type === "farm-deposit" ? "Supply" : "Withdraw"} />,
                <Ct key="a" desc={`${VAULTS.find((v) => v.id === x.vaultId)?.name ?? "Kamino"} · ${usd((Number(x.amount) || 0) * (px[x.symbol] ?? 0))}`}>
                  <Icon sym={x.symbol} className="ico pf-i16" />
                  {tokFmt(Number(x.amount) || 0, x.symbol)}
                </Ct>,
                <Success key="s" />,
                <TxCell key="h" sig={x.signature} />,
              ],
            }))}
          />
        ) : (
          <Grid
            cols="1.7fr 1.2fr 1.5fr .7fr .8fr"
            heads={["Asset", "Protocol", "Holdings", "APY", "Earned"]}
            empty={q ? "No pools match" : "No farm positions yet"}
            rows={[...rows.map((f) => {
              const apy = apyOf(f.poolId);
              const e = farmBySym ? farmBySym[f.symbol] ?? null : null;
              return {
                key: f.poolId,
                onClick: () => open(f.poolId),
                cells: [
                  <TokCell
                    key="a"
                    sym={f.symbol}
                    tags={
                      <>
                        <Tag cls="pf-t-ic">
                          <Icon sym="KMNO" className="ico pf-i12" />
                          Kamino
                        </Tag>
                        <Tag>Supply</Tag>
                      </>
                    }
                  />,
                  <Ct key="p">
                    <Venue name="Kamino" />
                  </Ct>,
                  <Ct key="h" desc={`${tokFmt(f.receipts, f.symbol, false)} ${f.receiptSymbol} · ${usd(f.liquidityUsd)}`}>
                    {tokFmt(f.underlying, f.symbol)}
                  </Ct>,
                  <Ct key="y">{pct((apy ?? 0) * 100)}</Ct>,
                  <Ct key="e" desc={e === null ? "" : tokFmt(e, f.symbol)}>
                    {e === null ? usd(0) : <span className={e > 0 ? "pos" : ""}>{sUsd(e * (px[f.symbol] ?? 0))}</span>}
                  </Ct>,
                ],
              };
            }),
            ...vaultRows.map((v) => {
              const basis = v.def.kind === "basis";
              return {
                key: v.def.id,
                onClick: () => router.push(vaultHref(v.def.id)),
                cells: [
                  <TokCell
                    key="a"
                    sym={basis ? v.def.asset : v.def.symbol}
                    label={v.def.name}
                    tags={
                      <>
                        <Tag>{basis ? "Basis" : "Perena"}</Tag>
                        <Tag>{v.def.symbol}</Tag>
                      </>
                    }
                  />,
                  <Ct key="p">{basis ? <Venue name="Phoenix" /> : <Venue name="Perena" />}</Ct>,
                  <Ct key="h" desc={usd(v.valueUsd)}>
                    {`${tokFmt(v.shares, "USDC", false)} ${v.def.symbol}`}
                  </Ct>,
                  <Ct key="y">{pct(v.apy ?? 0)}</Ct>,
                  <Ct key="e">{v.earnedUsd === null ? usd(0) : <span className={v.earnedUsd > 0 ? "pos" : ""}>{sUsd(v.earnedUsd)}</span>}</Ct>,
                ],
              };
            })]}
          />
        )}
      </section>
    </>
  );
}
