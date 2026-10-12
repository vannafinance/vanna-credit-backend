"use client";

/**
 * Delta-neutral (basis) vault page — /farm/basis/:id, laid out exactly like the Kamino and Perena
 * vault pages so every Farm vault feels the same: back link, title + tags, a four-figure stats bar
 * (Vault APY, Funding Now, Open Interest of the Phoenix market, Total Value Locked; net delta lives in
 * the Analytics positions card), All Transactions | Analytics panel, and
 * the Deposit / Withdraw column wired to the real vault flow. The delta-neutral specifics (the
 * design's `dnView`: statistics, yield breakdown, APY vs borrow chart, both legs, risks, share price /
 * funding charts) live under Analytics.
 *
 * Data ({@link useVaultView}, lib/farm/basis-live.ts): fork vault state (GET /api/farm/vaults),
 * recorded share-price history, Phoenix mainnet funding (history + live WebSocket rate) and live open
 * interest / mark (same WebSocket), this wallet's
 * margin-account receipt balance and on-chain vault history. Unknown or not-yet-recorded figures
 * keep an explicit unavailable state.
 */
import "../farm-v3.css";
import { LOW_TVL_USD, apyText, sinceLaunchLabel, vaultApy } from "@/lib/farm/yield";
import { useState } from "react";
import { Icon } from "@/components/v3/icons";
import { nf, spct, usd, usdC } from "@/components/v3/format";
import { explorerUrl } from "@/lib/solana/config";
import { openInterestUsd, useVaultPosition, useVaultView } from "@/lib/farm/basis-live";
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
  const eventEstimate = state?.apy7Source === "deposit-event";
  // Headline APY: realized 7D when it exists, else the Phoenix-funding estimate (labelled). A
  // since-launch return is never annualised: under 7 days of history one rebalance cost on a small
  // NAV reads as a huge APY, so it is shown raw beside the estimate instead.
  const headline = vaultApy(apy7, funding?.stats.avg7, state?.shortUsd, state?.navUsd);
  const apyLabel = apyText(headline.value);
  const fundingApr7 = headline.fundingApr;
  const sinceLaunch = sinceLaunchLabel(state?.returnSinceLaunchPct, state?.sinceLaunchDays);
  const launchDay = state?.launchedAt ? new Date(state.launchedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
  const apyTitle = "Vault APY (7D)";
  const lowTvlTip = headline.lowTvl
    ? ` TVL is under ${usdC(LOW_TVL_USD)}: a single rebalance, Phoenix fee or entry cost moves the share price more than days of funding, so treat any APY here as an estimate.`
    : "";
  const sinceTip = sinceLaunch ? ` ${sinceLaunch}${launchDay ? ` (launched ${launchDay})` : ""}: the real share-price change from 1.00, not annualised.` : "";
  const estTip = `Estimated from what this vault earns: the last 7 days of Phoenix mainnet ${def.asset}-PERP funding (${spct(fundingApr7 ?? 0, 1)} APR) on the share of the vault held short (${nf((view.hedgeShare ?? 0) * 100, 0)}% of NAV). Before Phoenix fees and execution. A few days of share-price history are too short to annualise; it switches to the realized 7-day APY once the vault has 7 days of history.${sinceTip}${lowTvlTip}`;
  // One sub-line under the APY: the real since-launch return (un-annualised) while the headline is the
  // funding estimate. Funding and the low-TVL note are in the tooltip / the Funding stat.
  // No chips under the APY (simple, like the Kamino page); the since-launch return is in the tooltip.
  const apySub: string[] = [];
  const market = view.market;
  const oiUsd = openInterestUsd(market) ?? 0;
  const oiDigits = (market?.markPx ?? 0) > 1e4 ? 3 : 2;
  const oiTip = `Open interest of ${def.asset}-PERP on Phoenix: the total size of open positions, counted on one side (every long has a matching short), live from Phoenix's public feed. In USD at the mark price${market?.markPx ? ` (${usd(market.markPx)})` : ""}. A deeper market absorbs the vault's short and its rebalances more easily. The vault's own net delta is under Analytics → Positions.`;

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
          <Cell key="y" v={apyLabel} />,
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
          <Stat label={apyTitle} value={apyLabel} sub={apySub} cls={(headline.value ?? 0) > 0 ? "pos" : (headline.value ?? 0) < 0 ? "neg" : ""} tip={headline.estimate ? estTip : (eventEstimate ? `Approximate annualised share-price return from a deposit event on ${new Date(state!.apy7BaselineAt!).toLocaleDateString()}. Covers the full interval since that event, at least 7 days; mint rounding may affect the baseline.` : "Annualised share-price return over 7 days. It reads 0.00% until a 7-day price baseline exists, which is not a measured zero return.") + (fundingApr7 !== null ? ` Phoenix's 7-day average funding is ${spct(fundingApr7, 1)} APR, for comparison.` : "") + lowTvlTip} />
          <Stat
            label="Funding Now"
            value={spct(fundingNow, 1)}
            tip={`Phoenix's current hourly funding on ${def.asset}-PERP, annualised (× 24 × 365). When positive, shorts get paid.`}
            cls={fundingNow >= 0 ? "pos" : "neg"}
          />
          <Stat label="Open Interest" value={usd(oiUsd, 0)} sub={[`${nf(market?.openInterest ?? 0, oiDigits)} ${def.asset}`]} tip={oiTip} />
          <Stat label="Total Value Locked" value={usd(tvl)} tip={`Net asset value in the vault now; it accepts up to ${usdC(state?.capUsd ?? 0)} in total.`} />
        </section>
        {/* The APY explanation lives in the stat's tooltip; the page stays as simple as the Kamino vault page. */}
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
            <VaultActionPanel
              id={vid}
              state={state}
              account={account}
              apy7={headline.value}
              apySource={headline.estimate ? "The estimated APY from the last 7 days of Phoenix funding on the vault's short (before fees and execution)" : undefined}
              apyEstimate={headline.estimate || headline.lowTvl}
              apyNote={headline.lowTvl ? `Low TVL (under ${usdC(LOW_TVL_USD)}): one rebalance or entry cost dominates the vault's share price at this size, so this is an estimate.` : undefined}
            />
            <Tiles
              items={[
                ["Total Value Locked", usdC(tvl)],
                [apyTitle, apyLabel],
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
                ["Deposit to the vault", def.id === "basis-sol" ? "From your margin account, in one approval (routed through your wallet; the vbSOL returns to margin)." : "From your margin account, in one approval."],
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
