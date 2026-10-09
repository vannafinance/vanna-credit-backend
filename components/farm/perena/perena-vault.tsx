"use client";

/**
 * Perena vault page — /farm/perena/:id (usdstar, junior), in the V3 vault-page family (the Kamino
 * and basis pages): header, stats strip, Overview | Analytics | All Transactions, and the
 * Deposit / Withdraw column wired to the real Perena flow (../vault-action-panel.tsx).
 *
 * Data: Perena's own published product figures (GET /api/farm/perena: 7-day APY, holders, mainnet
 * share price — the same source as app.perena.org/earn) and product copy (lib/farm/perena-info.ts);
 * Perena's on-chain share price and supply on the fork (GET /api/farm/vaults) for TVL and the NAV
 * Vanna values the receipt at; the server's recorded hourly share prices (chart, statistics); this
 * wallet's margin-account receipt balance and on-chain vault history. Unavailable or
 * not-yet-recorded figures render as 0.
 */
import "../farm-v3.css";
import { useState } from "react";
import { Icon } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { nf, pct, spct, usd, usdC } from "@/components/v3/format";
import { perenaProduct, usePerenaMarket, useVaultPosition, useVaultView, type VaultView } from "@/lib/farm/basis-live";
import type { PerenaProduct } from "@/lib/farm/nav-math";
import { PERENA_INFO, PERENA_TRANSPARENCY_URL } from "@/lib/farm/perena-info";
import { BackLink, Chips, HowItWorks, TabsBox, Tiles, VTag, YieldList } from "../fm-ui";
import { Card, SharePriceCard, Stat, VaultTransactions, inRange, RANGES } from "../vault-parts";
import { VaultActionPanel, useVaultAccountInputs } from "../vault-action-panel";
import { BasisChart, dayLabel } from "../basis/basis-chart";

const z = (v: number | null | undefined) => (v !== null && v !== undefined && Number.isFinite(v) ? v : 0);
const pctAxis = (t: number, step: number) => pct(t, step < 1 ? 1 : 0);

export function PerenaVaultPage({ id, initial }: { id: string; initial?: "deposit" | "withdraw" }) {
  const vid = `perena-${id}`;
  const view = useVaultView(vid);
  const market = usePerenaMarket();
  const product = perenaProduct(market, vid);
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
          <Icon sym={def.symbol} className="fm-ico28" />
          <h1>{def.name}</h1>
          <span className="fm-tag">Vault</span>
          <VTag name="Perena" />
          {junior && <span className="fm-tag">Junior tranche</span>}
        </div>
        <section className="fm-stats fm-dnp num">
          <Stat label="APY (7D)" value={pct(z(product.apy7), 2)} tip="Perena's published 7-day APY (api.perena.org, mainnet), as on app.perena.org/earn." cls={z(product.apy7) > 0 ? "pos" : ""} />
          <Stat label="TVL" value={usdC(z(state?.navUsd))} tip={`${def.symbol} supply × share price, read on chain by Vanna.`} />
          <Stat label="Holders" value={nf(z(product.holders), 0)} tip="Wallets holding the receipt, from Perena's public API." />
          <Stat label="Share Price" value={usd(z(state?.sharePriceUsd), 6)} tip={`USD per ${def.symbol} on Vanna's fork: the price your margin account is valued at.`} />
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
                <PerenaAnalytics view={view} product={product} />
              ) : left === "tx" ? (
                <VaultTransactions def={def} state={state} position={position} />
              ) : (
                <>
                  <PerenaProductCard view={view} product={product} />
                  <SharePriceCard days={view.sharePriceDays} receipt={def.symbol} />
                </>
              )}
            </div>
          </div>
          <aside className="fm-aside">
            <VaultActionPanel
              id={vid}
              state={state}
              account={account}
              apy7={product.apy7}
              apySource="Perena's published 7-day APY (0.00% when Perena's API is unavailable)"
              initial={initial}
            />
            <Tiles
              items={[
                ["Total Value Locked", usdC(z(state?.navUsd))],
                ["APY (7D)", pct(z(product.apy7), 2)],
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
                ["Withdraw anytime", junior ? "Back to USDC in margin through Perena's instant path (1% fee)." : "No lockup: back to USDC in your margin account."],
              ]}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function PerenaAnalytics({ view, product }: { view: VaultView; product: PerenaProduct }) {
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
      <Card title="Statistics" sub={<p className="fm-sub">Perena&apos;s published figures, and share prices Vanna has recorded on its fork</p>}>
        <div className="fm-sg num">
          {sg("Perena APY 7D", pct(z(product.apy7), 2), "Published by Perena, mainnet")}
          {sg("Holders", nf(z(product.holders), 0), "Published by Perena")}
          {sg("Mainnet share price", usd(z(product.price), 6), `USD per ${def.symbol}, Perena`)}
          {sg("Recorded APY 7D", pct(z(state?.apy7), 2), "Fork share-price change", "0.00% until 7 days of share prices are recorded.")}
          {sg("Recorded APY 30D", pct(z(state?.apy30), 2), "Fork share-price change", "0.00% until 30 days are recorded.")}
          {sg("Recorded APY 90D", pct(z(stats.apy90), 2), "Fork share-price change", "0.00% until 90 days are recorded.")}
          {sg("Since launch", pct(z(stats.sinceLaunch), 2), since)}
          {sg("ROI", spct(z(stats.roi), 3), "Share price since recording began")}
          {sg("Sharpe ratio", nf(z(stats.sharpe), 2), "Daily returns, annualised", "Mean daily return divided by its standard deviation, times the square root of 365. Needs 3 daily returns.")}
          {sg("Max drawdown", pct(z(stats.maxDrawdown), 3), "Since recording began", "Largest fall in share price from a previous high.")}
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

/** Perena's product card (as on app.perena.org/earn) plus the receipt / fee / NAV details. */
function PerenaProductCard({ view, product }: { view: VaultView; product: PerenaProduct }) {
  const { def, state } = view;
  const info = PERENA_INFO[def.id];
  const junior = def.id === "perena-junior";
  const fork = z(state?.sharePriceUsd);
  const main = z(product.price);
  const differs = fork > 0 && main > 0 && Math.abs(fork - main) / main > 0.0005;
  return (
    <section className="fm-card fm-pc">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="fm-pc-bn" src={info.banner} alt="" aria-hidden="true" />
      <div className="fm-pc-in">
        <div className="fm-pc-h">
          <Icon sym={info.icon} className="fm-ico28" />
          <div>
            <h3>{def.name}</h3>
            <p className="fm-sub">{info.audience}</p>
          </div>
        </div>
        <p className="fm-about">{info.description}</p>
        <div className="fm-pc-tags">
          {info.tags.map((t) => (
            <span key={t} className="mini">
              {t}
            </span>
          ))}
          <a className="fm-link fm-pc-tr" href={PERENA_TRANSPARENCY_URL} target="_blank" rel="noreferrer">
            Transparency Dashboard ↗
          </a>
        </div>
        <div className="fm-pc-st num">
          <div>
            <span>APY</span>
            <b className={z(product.apy7) > 0 ? "pos" : ""}>{pct(z(product.apy7), 2)}</b>
          </div>
          <div>
            <span>TVL</span>
            <b>{usdC(z(state?.navUsd))}</b>
          </div>
          <div>
            <span>Holders</span>
            <b>{nf(z(product.holders), 0)}</b>
          </div>
        </div>
        <p className="fm-note">{info.vannaNote}</p>
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
            <dt>Exit fee on Vanna</dt>
            <dd>
              {pct((state?.exitFeeBps ?? 0) / 100, 2)}
              {junior ? " instant" : ""}
            </dd>
          </div>
          <div>
            <dt>Share price, Perena mainnet</dt>
            <dd>{usd(main, 6)}</dd>
          </div>
          <div>
            <dt>Share price, Vanna fork NAV</dt>
            <dd className={differs ? "warn" : ""}>{usd(fork, 6)}</dd>
          </div>
          <div>
            <dt>Fork NAV</dt>
            <dd className={state?.stale ? "neg" : "pos"}>
              {state?.stale ? "Stale" : "Fresh"}
              {state?.updatedAt
                ? ` · ${new Date(state.updatedAt * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}`
                : ""}
            </dd>
          </div>
        </dl>
        {differs && <p className="fm-sub">The fork&apos;s on-chain NAV can lag Perena&apos;s live mainnet price; Vanna values your receipt at the fork NAV.</p>}
      </div>
    </section>
  );
}
