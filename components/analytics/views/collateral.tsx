"use client";

/** Collateral: the assets the protocol accepts, how each is configured on-chain, and what accounts actually hold. */
import { useAnalyticsProtocol, useAnalyticsSummary } from "@/hooks/use-analytics";
import { num, pct, priceSourceLabel, usd, usdC } from "@/lib/analytics/format";
import { AssetCell, Badge, Empty, InfoTip, Kpi } from "../ui";
import { ViewHead } from "../shell";

/** "Max per account" is stored as a u64; the all-ones value (or 0) means no limit is set. */
const UNLIMITED = 2n ** 63n;
const capLabel = (raw: string, decimals: number, symbol: string) => {
  const v = BigInt(raw);
  return v === 0n || v >= UNLIMITED ? "No limit" : `${num(Number(v) / 10 ** decimals)} ${symbol}`;
};

export function CollateralView() {
  const { data: protocol } = useAnalyticsProtocol();
  const { data: sum } = useAnalyticsSummary();
  const assets = protocol?.assets ?? [];
  const held = new Map((sum?.summary?.collateralBy ?? []).map((c) => [c.symbol, c]));
  return (
    <>
      <ViewHead title="Collateral" blurb="The assets accounts can post, how each is set up on-chain, and what accounts actually hold." />
      <div className="an-kpi-grid an-cols-3">
        <Kpi label="Registered assets" value={protocol ? String(assets.length) : "—"} na={!protocol} sub="Configured on-chain" />
        <Kpi label="Allowed as collateral" value={protocol ? String(assets.filter((a) => a.allowedAsCollateral).length) : "—"} na={!protocol} sub="Accepted by the protocol" />
        <Kpi label="Can be borrowed" value={protocol ? String(assets.filter((a) => a.borrowEnabled).length) : "—"} na={!protocol} sub="Borrowing switched on" />
      </div>
      <section className="an-panel an-flush">
        <div className="an-panel-head"><div><h2 className="an-panel-title">Asset settings</h2><p className="an-panel-sub">Read from each asset&apos;s on-chain configuration</p></div></div>
        {assets.length ? (
          <div className="an-table-wrap"><table className="an-t an-compact">
            <thead><tr><th>Asset</th><th>Allowed as collateral <InfoTip k="allowedCollateral" /></th><th>Borrowing</th><th className="an-r">Max per account <InfoTip k="maxCollateral" /></th><th className="an-r">Liquidator bonus <InfoTip k="liqBonus" /></th><th>Price source</th><th className="an-r">Price valid for</th><th className="an-r">Held in accounts <InfoTip k="countedCollateral" /></th></tr></thead>
            <tbody>{assets.map((a) => {
              const h = held.get(a.symbol);
              return (
                <tr key={a.assetIndex}>
                  <td className="an-nowrap" title={a.name}><AssetCell symbol={a.symbol} sub="" size="sm" /></td>
                  <td><Badge tone={a.allowedAsCollateral ? "ok" : "warn"}>{a.allowedAsCollateral ? "Yes" : "No"}</Badge></td>
                  <td><Badge tone={a.borrowEnabled ? "ok" : "neutral"}>{a.borrowEnabled ? "On" : "Off"}</Badge></td>
                  <td className="an-r an-nowrap">{capLabel(a.maxCollateralPerMargin, a.decimals, a.symbol)}</td>
                  <td className="an-r">{pct(a.liquidationBonusBps / 10000, 1)}</td>
                  <td className="an-nowrap" title={a.feed}>{priceSourceLabel(a.feed)}</td>
                  <td className="an-r an-nowrap">{a.maxAgeSecs}s</td>
                  <td className="an-r">{h ? <><b>{h.usd > 0 ? usd(h.usd) : `${num(h.amountAll, 2)} ${a.symbol}`}</b><small>{h.accountsAll} account{h.accountsAll === 1 ? "" : "s"}{h.usd > 0 ? "" : " · no fresh price"}</small></> : <span className="an-muted">None</span>}</td>
                </tr>
              );
            })}</tbody></table></div>
        ) : <Empty title={protocol ? "No assets registered" : "Loading…"} text={protocol ? "No asset configuration was found on-chain." : undefined} />}
      </section>
      <p className="an-muted" style={{ fontSize: 12.5 }}>Token units held in margin-account vaults. Dollar values appear only when the asset has a fresh price ({usdC(sum?.summary?.collateralUsd ?? null)} valued in total).</p>
    </>
  );
}
