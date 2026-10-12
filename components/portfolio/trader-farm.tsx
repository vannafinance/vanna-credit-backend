"use client";

/**
 * Portfolio → Trader → Farm: the margin account's Kamino Lend positions (margin-held cTokens valued
 * like the health factor values them, `useFarmPositions`), Kamino's supply APY (`useFarmPools`),
 * earnings from the margin's own farm-deposit / farm-withdraw events, and that history. The
 * history also lists Basis / Perena vault deposits and withdrawals (labelled with the vault's name);
 * their earnings count in the header's Trading figure, not in the Kamino "earned" here. The Farm
 * Equity card shows the current value only (no on-chain value-over-time series).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { IC, Icon } from "@/components/v3/icons";
import { pct, sUsd, tokFmt, usd } from "@/components/v3/format";
import { useFarmStore } from "@/store/farm-store";
import { VAULTS } from "@/lib/solana/vault-catalogue";
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
  const tot = list.reduce((t, f) => t + f.liquidityUsd, 0);
  const apyOf = (id: string) => pools.find((x) => x.id === id)?.supplyApy ?? null;
  const withApy = list.filter((f) => apyOf(f.poolId) !== null);
  const wBase = withApy.reduce((t, f) => t + f.liquidityUsd, 0);
  const wApy = wBase > 0 ? (withApy.reduce((t, f) => t + f.liquidityUsd * (apyOf(f.poolId) ?? 0), 0) / wBase) * 100 : null;
  const holdings = p.acct.now?.holdings ?? 0;
  const earned = p.totals.farmEarned;
  const hist = p.margin.rows.filter((r) => r.type === "farm-deposit" || r.type === "farm-withdraw");
  const open = (id: string) => {
    setFarmData({ tabType: "single" });
    router.push(`/farm/${id}`);
  };
  const rows = list.filter((f) => !q || `${f.symbol} ${f.receiptSymbol} kamino`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="pf-row2">
        <InfoCard
          title="Farming Info"
          rows={[
            ["Total Farm Value", usd(tot)],
            ["Active Vaults", String(list.length)],
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
            rows={rows.map((f) => {
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
            })}
          />
        )}
      </section>
    </>
  );
}
