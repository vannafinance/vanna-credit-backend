"use client";

/**
 * Perena vault page — /farm/perena/:id (usdstar, junior), in the V3 vault-page family (the Kamino
 * and basis pages): header, stats strip, Overview | Analytics | All Transactions, and the
 * Deposit / Withdraw column wired to the real Perena flow (../vault-action-panel.tsx).
 *
 * Data: Perena's on-chain share price and supply on the fork (GET /api/farm/vaults), the server's
 * recorded hourly share prices (APYs, chart, statistics), this wallet's margin-account receipt
 * balance and on-chain vault history. Not-yet-recorded figures render as 0.
 */
import "../farm-v3.css";
import { useState } from "react";
import { Icon } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { nf, pct, spct, usd, usdC } from "@/components/v3/format";
import { useVaultPosition, useVaultView, type VaultView } from "@/lib/farm/basis-live";
import { BackLink, Chips, HowItWorks, TabsBox, Tiles, VTag, YieldList } from "../fm-ui";
import { Card, SharePriceCard, Stat, VaultTransactions, inRange, RANGES } from "../vault-parts";
import { VaultActionPanel, useVaultAccountInputs } from "../vault-action-panel";
import { BasisChart, dayLabel } from "../basis/basis-chart";

const z = (v: number | null | undefined) => (v !== null && v !== undefined && Number.isFinite(v) ? v : 0);
const pctAxis = (t: number, step: number) => pct(t, step < 1 ? 1 : 0);

export function PerenaVaultPage({ id }: { id: string }) {
  const vid = `perena-${id}`;
  const view = useVaultView(vid);
  const position = useVaultPosition(view?.def);
  const account = useVaultAccountInputs();
  const [left, setLeft] = useState<"ov" | "an" | "tx">("ov");

  if (!view || view.def.kind !== "perena") {
    return (
      <div className="v3">
        <div className="page">
          <BackLink />
          <section className="fm-nf">
            <h1>Vault not found</h1>
            <p>&ldquo;{id}&rdquo; isn&apos;t a Perena vault.</p>
          </section>
        </div>
      </div>
    );
  }
  const { def, state } = view;
  const junior = def.id === "perena-junior";

  return (
    <div className="v3">
      <div className="page">
        <BackLink />
        <div className="fm-vh">
          <Icon sym={def.asset} className="fm-ico28" />
          <h1>{def.name}</h1>
          <span className="fm-tag">Vault</span>
          <VTag name="Perena" />
          {junior && <span className="fm-tag">Junior tranche</span>}
        </div>
        <section className="fm-stats fm-dnp num">
          <Stat label="Vault APY (7D)" value={pct(z(state?.apy7), 2)} tip="Annualised share-price change over the last 7 days. 0.00% until 7 days of share prices are recorded." />
          <Stat label="Vault APY (30D)" value={pct(z(state?.apy30), 2)} tip="The same over the last 30 days. 0.00% until 30 days are recorded." />
          <Stat label="Share Price" value={usd(z(state?.sharePriceUsd), 6)} tip={`USD per ${def.symbol}, read from Perena's on-chain price account.`} />
          <Stat label="Total Value Locked" value={usdC(z(state?.navUsd))} tip={`${def.symbol} supply × share price.`} />
          <Stat label="Your Position" value={usd(position.valueUsd)} />
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
                <PerenaAnalytics view={view} />
              ) : left === "tx" ? (
                <VaultTransactions def={def} state={state} position={position} />
              ) : (
                <>
                  <Card title={junior ? "About USD* Junior" : "About USD*"} sub={<p className="fm-sub">Perena · stablecoin yield</p>}>
                    <p className="fm-about">
                      {junior
                        ? "USD* Junior is the first-loss tranche of Perena's USD* portfolio: it absorbs losses first and receives extra weight in the yield allocation (dynamic, not a fixed multiple). Instant withdrawals currently include a 1% exit fee."
                        : "Deposit USDC into Perena and receive USD* shares; their price moves with the returns of Perena's managed yield portfolio. Your receipt stays in your Vanna margin account and counts toward its health factor."}
                    </p>
                    <dl className="fm-dl num">
                      <div>
                        <dt>Deposit asset</dt>
                        <dd>USDC</dd>
                      </div>
                      <div>
                        <dt>Receipt</dt>
                        <dd>{def.symbol}</dd>
                      </div>
                      <div>
                        <dt>Exit fee</dt>
                        <dd>{pct((state?.exitFeeBps ?? 0) / 100, 2)}{junior ? " instant" : ""}</dd>
                      </div>
                      <div>
                        <dt>Fees</dt>
                        <dd>Reflected in the transaction preview</dd>
                      </div>
                      <div>
                        <dt>NAV updated</dt>
                        <dd>{state?.updatedAt ? new Date(state.updatedAt * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "Not yet read"}</dd>
                      </div>
                      <div>
                        <dt>NAV status</dt>
                        <dd className={state?.stale ? "neg" : "pos"}>{state?.stale ? "Stale on the fork" : "Fresh"}</dd>
                      </div>
                    </dl>
                  </Card>
                  <SharePriceCard days={view.sharePriceDays} receipt={def.symbol} />
                </>
              )}
            </div>
          </div>
          <aside className="fm-aside">
            <VaultActionPanel id={vid} state={state} account={account} />
            <Tiles
              items={[
                ["Total Value Locked", usdC(z(state?.navUsd))],
                ["Vault APY (7D)", pct(z(state?.apy7), 2)],
              ]}
            />
            <YieldList
              rows={[
                ["Your Position", usd(position.valueUsd)],
                ["Earnings", usd(position.earnedUsd ?? 0), (position.earnedUsd ?? 0) > 0 ? "pos" : (position.earnedUsd ?? 0) < 0 ? "neg" : ""],
                ["Receipt", `${position.shares > 0 ? `${nf(position.shares, 6)} ` : ""}${def.symbol}`],
              ]}
            />
            <HowItWorks
              steps={[
                ["Hold USDC in Margin", "Deposit or borrow USDC on the Margin page."],
                ["Deposit to Perena", `Perena issues ${def.symbol} for your USDC at its on-chain share price.`],
                ["Earn the share price", `${def.symbol} stays in your margin account and counts toward its health factor.`],
                ["Withdraw anytime", junior ? "Back to USDC in margin; instant exits pay a 1% fee." : "Back to USDC in your margin account."],
              ]}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function PerenaAnalytics({ view }: { view: VaultView }) {
  const [range, setRange] = useState(30);
  const [hover, setHover] = useState<number | null>(null);
  const { state, stats, def } = view;
  const s = inRange(view.apyDays, range);
  const since = stats.firstAt ? `Annualised, from ${dayLabel(stats.firstAt)}` : "Annualised, since recording began";
  const sg = (k: string, value: string, d: string, tip?: string) => (
    <div key={k}>
      <div className="lbl">
        {k}
        {tip && <Info text={tip} />}
      </div>
      <b>{value}</b>
      <span>{d}</span>
    </div>
  );
  return (
    <>
      <Card title="Statistics" sub={<p className="fm-sub">From recorded hourly share prices</p>}>
        <div className="fm-sg num">
          {sg("Net APY 7D", pct(z(state?.apy7), 2), "Share-price change", "0.00% until 7 days of share prices are recorded.")}
          {sg("Net APY 30D", pct(z(state?.apy30), 2), "Share-price change", "0.00% until 30 days are recorded.")}
          {sg("Net APY 90D", pct(z(stats.apy90), 2), "Share-price change", "0.00% until 90 days are recorded.")}
          {sg("Since launch", pct(z(stats.sinceLaunch), 2), since)}
          {sg("ROI", spct(z(stats.roi), 3), "Share price since recording began")}
          {sg("Sharpe ratio", nf(z(stats.sharpe), 2), "Daily returns, annualised", "Mean daily return divided by its standard deviation, times the square root of 365. Needs 3 daily returns.")}
          {sg("Max drawdown", pct(z(stats.maxDrawdown), 3), "Since recording began", "Largest fall in share price from a previous high.")}
          {sg("Share price", usd(z(state?.sharePriceUsd), 6), `USD per ${def.symbol}`)}
          {sg("Exit fee", pct((state?.exitFeeBps ?? 0) / 100, 2), def.id === "perena-junior" ? "Instant withdrawals" : "No exit fee")}
        </div>
      </Card>
      <Card
        title="Daily vault APY"
        sub={
          <p className="fm-ro num">
            {hover !== null && s[hover] ? (
              <>
                {dayLabel(s[hover].at)} · <b>{pct(s[hover].value, 2)}</b>
              </>
            ) : (
              "Day-over-day share-price change, annualised"
            )}
          </p>
        }
        right={<Chips value={range} options={RANGES} onChange={setRange} />}
      >
        <BasisChart
          data={s.map((p) => p.value)}
          dates={s.map((p) => p.at)}
          includeZero
          formatAxis={pctAxis}
          onHover={setHover}
          empty="Daily vault APY appears once the share price has been recorded on three different days"
          ariaLabel="Daily vault APY line chart"
        />
      </Card>
    </>
  );
}
