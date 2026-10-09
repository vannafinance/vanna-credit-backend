"use client";

/**
 * Delta-neutral (basis) vault page — /farm/basis/:id, the design's `dnView`, on live data:
 * header, stats strip (Vault APY 7D / 30D, Funding Now, Net Delta, TVL / Cap), Overview | Analytics |
 * All Transactions, and the Deposit / Withdraw column wired to the real vault flow.
 *
 * Data ({@link useVaultView}, lib/farm/basis-live.ts): fork vault state (GET /api/farm/vaults),
 * recorded share-price history, Phoenix mainnet funding (history + live WebSocket rate), this wallet's
 * margin-account receipt balance and on-chain vault history. Unknown or not-yet-recorded figures
 * render as 0, never as a placeholder or sample.
 */
import "../farm-v3.css";
import { useState } from "react";
import { Icon } from "@/components/v3/icons";
import { pct, spct, usd, usdC } from "@/components/v3/format";
import { useVaultPosition, useVaultView } from "@/lib/farm/basis-live";
import { BackLink, HowItWorks, TabsBox, Tiles, VTag, YieldList } from "../fm-ui";
import { Stat, VaultTransactions } from "../vault-parts";
import { VaultActionPanel, useVaultAccountInputs } from "../vault-action-panel";
import { BasisAnalytics, BasisOverview } from "./basis-sections";

const BACK = "/farm?category=delta-neutral";

export function BasisVaultPage({ id }: { id: string }) {
  const vid = `basis-${id}`;
  const view = useVaultView(vid);
  const position = useVaultPosition(view?.def);
  const account = useVaultAccountInputs();
  const [left, setLeft] = useState<"ov" | "an" | "tx">("ov");

  if (!view || view.def.kind !== "basis") {
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
  const { def, state, funding } = view;
  const fundingNow = funding?.now ?? 0;
  const tvl = state?.navUsd ?? 0;
  const cap = state?.capUsd ?? 0;

  return (
    <div className="v3">
      <div className="page">
        <BackLink href={BACK} />
        <div className="fm-vh">
          <Icon sym={def.asset} className="fm-ico28" />
          <h1>{def.name}</h1>
          <span className="fm-tag">Vault</span>
          <VTag name="Jupiter" />
          <VTag name="Phoenix" />
        </div>
        <section className="fm-stats fm-dnp num">
          <Stat label="Vault APY (7D)" value={pct(state?.apy7 ?? 0, 1)} tip="Annualised share-price change over the last 7 days, after Phoenix fees and execution. 0.00% until 7 days of share prices are recorded." />
          <Stat label="Vault APY (30D)" value={pct(state?.apy30 ?? 0, 1)} tip="The same over the last 30 days. 0.00% until 30 days are recorded." />
          <Stat
            label="Funding Now"
            value={spct(fundingNow, 1)}
            tip={`Phoenix's current hourly funding on ${def.asset}-PERP, annualised (× 24 × 365). When positive, shorts get paid.`}
            cls={fundingNow >= 0 ? "pos" : "neg"}
          />
          <Stat label="Net Delta" value={spct(state?.netDeltaPct ?? 0, 2)} tip="Spot leg minus short leg, as a share of the short; near zero means price moves cancel out." />
          <Stat
            label="TVL / Cap"
            value={
              <>
                {usdC(tvl)} <small>/ {usdC(cap)}</small>
              </>
            }
            tip="Net asset value in the vault now, and the most total exposure it accepts."
          />
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
              {left === "an" ? (
                <BasisAnalytics view={view} />
              ) : left === "tx" ? (
                <VaultTransactions def={def} state={state} position={position} />
              ) : (
                <BasisOverview view={view} borrowApy={account.usdcBorrowApy} />
              )}
            </div>
          </div>
          <aside className="fm-aside">
            <VaultActionPanel id={vid} state={state} account={account} />
            <Tiles
              items={[
                ["Total Value Locked", usdC(tvl)],
                ["Vault APY (7D)", pct(state?.apy7 ?? 0, 1)],
              ]}
            />
            <YieldList
              rows={[
                ["Your Position", usd(position.valueUsd)],
                ["Earnings", usd(position.earnedUsd ?? 0), (position.earnedUsd ?? 0) > 0 ? "pos" : (position.earnedUsd ?? 0) < 0 ? "neg" : ""],
                ["Receipt", `${position.shares > 0 ? `${position.shares.toLocaleString("en-US", { maximumFractionDigits: 6 })} ` : ""}${def.symbol}`],
              ]}
            />
            <HowItWorks
              steps={[
                ["Borrow on Margin", "Against any collateral Vanna accepts."],
                ["Deposit USDC", def.id === "basis-sol" ? "From your wallet; a second approval moves the shares to margin." : "From your margin account."],
                ["Vault hedges", def.id === "basis-sol" ? "SOL held at Phoenix, an equal 1x SOL-PERP short." : `Spot ${def.asset} via Jupiter, an equal 1x short on Phoenix.`],
                ["Earn funding", "Shares stay in your margin account and count toward its health factor."],
              ]}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}
