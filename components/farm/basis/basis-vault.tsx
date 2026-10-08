"use client";

/**
 * Delta-neutral (basis) vault page — /farm/basis/:id, the design's `dnView`. UI PREVIEW ONLY: the
 * vault figures are sample data from lib/farm/basis-vaults.ts (labelled "Preview · sample data")
 * and no transaction is ever sent. The margin balances, debts, borrow APYs and health factor the
 * deposit panel works from are read live (account snapshot + Vanna pools + useV3Account).
 */
import "../farm-v3.css";
import { useMemo, useState } from "react";
import { Icon } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { pct, spct, usdC } from "@/components/v3/format";
import { useUserStore } from "@/store/user";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { usePoolData } from "@/hooks/use-earn";
import { useV3Account } from "@/hooks/use-v3-account";
import { BASIS_DEPOSIT_TOKENS, findBasisVault } from "@/lib/farm/basis-vaults";
import { BackLink, PreviewBadge, TabsBox, VTag } from "../fm-ui";
import { BasisActionPanel, type BasisAccountInputs } from "./basis-action-panel";
import { BasisAnalytics, BasisOverview, BasisTransactions } from "./basis-sections";

const BACK = "/farm?category=delta-neutral";

export function BasisVaultPage({ id }: { id: string }) {
  const vault = findBasisVault(id);
  const [left, setLeft] = useState<"ov" | "an" | "tx">("ov");
  const [token, setToken] = useState<string>("USDC");

  const userAddress = useUserStore((s) => s.address);
  const { snapshot } = useAccountSnapshot(userAddress);
  const { pools } = usePoolData();
  const v3 = useV3Account();

  const account = useMemo<BasisAccountInputs>(() => {
    const margin = snapshot?.api?.margin;
    const balances: Record<string, number> = {};
    const debts: Record<string, number> = {};
    const prices: Record<string, number | null> = {};
    const borrowApy: Record<string, number | null> = {};
    for (const t of BASIS_DEPOSIT_TOKENS) {
      balances[t] = margin?.collateral.filter((c) => c.symbol === t).reduce((s, c) => s + c.amount, 0) ?? 0;
      debts[t] = margin?.debts.filter((d) => d.symbol === t).reduce((s, d) => s + d.debt, 0) ?? 0;
      prices[t] = margin?.prices?.[t]?.usd ?? null;
      const pool = pools[t];
      borrowApy[t] = pool ? pool.borrowApr * 100 : null;
    }
    return { connected: Boolean(userAddress), hasMargin: Boolean(margin?.exists), balances, debts, prices, borrowApy, hf: v3.now?.hf ?? null };
  }, [snapshot, pools, userAddress, v3.now]);

  if (!vault) {
    return (
      <div className="v3">
        <div className="page">
          <BackLink href={BACK} />
          <section className="fm-nf">
            <h1>Vault not found</h1>
            <p>&ldquo;{id}&rdquo; isn&apos;t a delta-neutral vault.</p>
          </section>
        </div>
      </div>
    );
  }
  const v = vault;
  const st = (l: string, val: React.ReactNode, tip?: string, cls = "") => (
    <article>
      <div className="lbl">
        {l}
        {tip && <Info text={tip} />}
      </div>
      <div className={`fm-sv ${cls}`}>{val}</div>
    </article>
  );

  return (
    <div className="v3">
      <div className="page">
        <BackLink href={BACK} />
        <div className="fm-vh">
          <Icon sym={v.asset} className="fm-ico28" />
          <h1>{v.name}</h1>
          <span className="fm-tag">Vault</span>
          <VTag name="Jupiter" />
          <VTag name="Phoenix" />
          <PreviewBadge />
        </div>
        <section className="fm-stats fm-dnp num">
          {st("Vault APY (7D)", pct(v.apy7, 1), "Average yearly yield over the last 7 days, after perp fees, execution and the vault fee (sample data).")}
          {st("Vault APY (30D)", pct(v.apy30, 1), "The same yield averaged over the last 30 days (sample data).")}
          {st("Funding Now", spct(v.fundingNow, 1), "Annualised funding rate on Phoenix right now; when positive, shorts get paid (sample data).", v.fundingNow >= 0 ? "pos" : "neg")}
          {st("Net Delta", spct(v.delta, 2), "Spot leg minus short leg as a share of the vault; near zero means price moves cancel out.")}
          {st(
            "TVL / Cap",
            <>
              {usdC(v.tvl)} <small>/ {usdC(v.cap)}</small>
            </>,
            "Money in the vault now, and the most it accepts (sample data).",
          )}
        </section>
        <div className="fm-cols fm-dnp">
          <div className="fm-main">
            <TabsBox
              items={[
                ["ov", "Overview"],
                ["an", "Analytics"],
                ["tx", "All Transactions"],
              ]}
              value={left}
              onChange={setLeft}
            />
            <div className="fm-panel dp">
              {left === "an" ? <BasisAnalytics vault={v} /> : left === "tx" ? <BasisTransactions vault={v} /> : <BasisOverview vault={v} token={token} borrowApy={account.borrowApy[token]} />}
            </div>
          </div>
          <aside className="fm-aside">
            <BasisActionPanel vault={v} token={token} onToken={setToken} account={account} />
          </aside>
        </div>
      </div>
    </div>
  );
}
