"use client";

/**
 * Delta-neutral (basis) vault page — /farm/basis/:id, laid out exactly like the Kamino and Perena
 * vault pages so every Farm vault feels the same: back link, title + tags, a four-figure stats bar
 * (Vault APY 7D, Funding Now, Net Delta, Total Value Locked), All Transactions | Analytics panel, and
 * the Deposit / Withdraw column wired to the real vault flow. The delta-neutral specifics (the
 * design's `dnView`: statistics, yield breakdown, APY vs borrow chart, both legs, risks, share price /
 * funding charts) live under Analytics.
 *
 * Data ({@link useVaultView}, lib/farm/basis-live.ts): fork vault state (GET /api/farm/vaults),
 * recorded share-price history, Phoenix mainnet funding (history + live WebSocket rate), this wallet's
 * margin-account receipt balance and on-chain vault history. Unknown or not-yet-recorded figures
 * keep an explicit unavailable state.
 */
import "../farm-v3.css";
import { apyText, grossFundingApr } from "@/lib/farm/yield";
import { useState } from "react";
import { Icon } from "@/components/v3/icons";
import { nf, pct, spct, usd, usdC } from "@/components/v3/format";
import { explorerUrl } from "@/lib/solana/config";
import { useVaultPosition, useVaultView } from "@/lib/farm/basis-live";
import { BackLink, Cell, HowItWorks, TabsBox, Tiles, Venue, VTag, YieldList } from "../fm-ui";
import { Stat } from "../vault-parts";
import { VaultActionPanel, useVaultAccountInputs } from "../vault-action-panel";
import { PositionTxPanel, type TxCols } from "../position-tx";
import { BasisAnalytics, BasisOverview } from "./basis-sections";

const BACK = "/farm?category=delta-neutral";

/** Same columns as the Kamino / Perena pages' tables. */
const COLS: TxCols = {
  current: [
    ["Asset", "1.2fr"],
    ["Protocol", "1fr"],
    ["Value", "1.2fr"],
    ["Receipt balance", "1.2fr"],
    ["APY", ".8fr"],
  ],
  history: [
    ["Date", "1.1fr"],
    ["Type", ".9fr"],
    ["Amount", "1.1fr"],
    ["Status", ".8fr"],
    ["Tx Hash", "1fr"],
  ],
};

export function BasisVaultPage({ id }: { id: string }) {
  const vid = `basis-${id}`;
  const view = useVaultView(vid);
  const position = useVaultPosition(view?.def);
  const account = useVaultAccountInputs();
  const [left, setLeft] = useState<"tx" | "an">("tx");

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
  const apy7 = state?.apy7 ?? null;
  const apyLabel = apyText(apy7);
  const eventEstimate = state?.apy7Source === "deposit-event";
  const fundingEstimate = grossFundingApr(funding?.stats.avg7, state?.shortUsd, state?.navUsd);

  const current = position.shares > 0
    ? [
        [
          <Cell
            key="a"
            v={
              <span className="fm-tk">
                <Icon sym={def.asset} className="fm-ico16" />
                {def.symbol}
              </span>
            }
            mini="Vault"
          />,
          <Cell key="p" v={<Venue name="Jupiter · Phoenix" />} />,
          <Cell key="s" v={usd(position.valueUsd)} mini="USDC value" />,
          <Cell key="r" v={`${nf(position.shares, 6)} ${def.symbol}`} />,
          <Cell key="y" v={apyLabel} mini={eventEstimate ? "Deposit-event estimate" : undefined} />,
        ],
      ]
    : [];
  const history = position.rows.map((r) => {
    const label = r.type === "farm-deposit" ? "Deposit" : "Withdraw";
    return {
      label,
      cells: [
        <Cell key="d" v={new Date(r.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} mini={new Date(r.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })} />,
        <Cell key="t" v={label} />,
        <Cell key="m" v={`${nf(Number(r.amount), 2)} USDC`} mini={`${nf(Number(r.receiptAmount ?? 0), 6)} ${def.symbol}`} />,
        <Cell key="s" v={<span className="fm-ok">Success</span>} />,
        <Cell
          key="h"
          v={
            <a className="fm-link" href={explorerUrl("tx", r.signature)} target="_blank" rel="noreferrer">
              {r.signature.slice(0, 8)}…{r.signature.slice(-4)}
            </a>
          }
        />,
      ],
    };
  });

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
        <section className="fm-stats num">
          <Stat label={eventEstimate ? "Vault APY (event estimate)" : "Vault APY (7D)"} value={apyLabel} tip={eventEstimate ? `Approximate annualised share-price return from a deposit event on ${new Date(state!.apy7BaselineAt!).toLocaleDateString()}. Covers the full interval since that event, at least 7 days; mint rounding may affect the baseline.` : "Annualised share-price return over 7 days. It reads 0.00% until a 7-day price baseline exists, which is not a measured zero return."} />
          <Stat
            label="Funding Now"
            value={spct(fundingNow, 1)}
            tip={`Phoenix's current hourly funding on ${def.asset}-PERP, annualised (× 24 × 365). When positive, shorts get paid.`}
            cls={fundingNow >= 0 ? "pos" : "neg"}
          />
          <Stat label="Net Delta" value={spct(state?.netDeltaPct ?? 0, 2)} tip="Spot leg minus short leg, as a share of the short; near zero means price moves cancel out." />
          <Stat label="Total Value Locked" value={usd(tvl)} tip={`Net asset value in the vault now; it accepts up to ${usdC(state?.capUsd ?? 0)} in total.`} />
        </section>
        {apy7 === null && (
          <p className="fm-sub" style={{ marginBlock: 12 }}>
            Vault APY shows 0.00% until the vault has 7 days of share-price history; it then updates day by day.
            {fundingEstimate !== null && ` Estimated gross funding APR: ${pct(fundingEstimate, 2)}. Based on available Phoenix mainnet funding observations and current short exposure; before fees, execution and borrowing costs. This is not realized vault APY.`}
          </p>
        )}
        <div className="fm-cols">
          <div className="fm-main">
            <TabsBox
              items={[
                ["tx", "All Transactions"],
                ["an", "Analytics"],
              ]}
              value={left}
              onChange={setLeft}
            />
            <div className="fm-panel kp">
              {left === "an" ? (
                <>
                  <BasisAnalytics view={view} />
                  <BasisOverview view={view} borrowApy={account.usdcBorrowApy} />
                </>
              ) : (
                <PositionTxPanel
                  summary={[
                    ["Position value", usd(position.valueUsd)],
                    ["Receipt balance", `${nf(position.shares, 6)} ${def.symbol}`],
                    ["Earned yield", usd(position.earnedUsd ?? 0), position.since ? `Since ${new Date(position.since).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : undefined],
                  ]}
                  cols={COLS}
                  current={current}
                  history={history}
                  typeOptions={["Deposit", "Withdraw"]}
                  emptyCurrent={position.connected ? "No position in this vault yet" : "Connect your wallet to see your position"}
                />
              )}
            </div>
          </div>
          <aside className="fm-aside">
            <VaultActionPanel id={vid} state={state} account={account} />
            <Tiles
              items={[
                ["Total Value Locked", usdC(tvl)],
                [eventEstimate ? "APY · event estimate" : "Vault APY (7D)", apyLabel],
              ]}
            />
            <YieldList
              rows={[
                ["Your Position", usd(position.valueUsd)],
                ["Receipt", def.symbol],
              ]}
            />
            <HowItWorks
              steps={[
                ["Hold USDC in Margin", def.id === "basis-sol" ? "Or in your wallet: SOL Basis deposits start from your wallet." : "Deposit or borrow USDC on the Margin page."],
                ["Deposit to the vault", def.id === "basis-sol" ? "From your wallet; a second approval moves the shares to margin." : "From your margin account, in one approval."],
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
