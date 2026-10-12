"use client";

/**
 * Perena vault page — /farm/perena/:id (usdstar, junior), laid out exactly like the Kamino vault
 * page (../kamino-vault.tsx): back link, title + tags, a four-figure stats bar, All Transactions |
 * Analytics panel, and the Deposit / Withdraw column wired to the real Perena flow
 * (../vault-action-panel.tsx), with Perena's product details on top of it.
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
import { explorerUrl } from "@/lib/solana/config";
import { perenaProduct, usePerenaMarket, useVaultPosition, useVaultView, type VaultView } from "@/lib/farm/basis-live";
import type { PerenaProduct } from "@/lib/farm/nav-math";
import { PERENA_INFO, PERENA_TRANSPARENCY_URL } from "@/lib/farm/perena-info";
import { BackLink, Cell, HowItWorks, TabsBox, Tiles, Venue, VTag, YieldList } from "../fm-ui";
import { SharePriceCard } from "../vault-parts";
import { VaultActionPanel, useVaultAccountInputs } from "../vault-action-panel";
import { PositionTxPanel, type TxCols } from "../position-tx";

const z = (v: number | null | undefined) => (v !== null && v !== undefined && Number.isFinite(v) ? v : 0);

/** Same columns as the Kamino page's tables. */
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

export function PerenaVaultPage({ id, initial }: { id: string; initial?: "deposit" | "withdraw" }) {
  const vid = `perena-${id}`;
  const view = useVaultView(vid);
  const market = usePerenaMarket();
  const product = perenaProduct(market, vid);
  const position = useVaultPosition(view?.def);
  const account = useVaultAccountInputs();
  const [left, setLeft] = useState<"tx" | "an">("tx");

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
  const stat = (l: string, v: string, cls = "") => (
    <article>
      <div className="lbl">{l}</div>
      <div className={`fm-sv ${cls}`}>{v}</div>
    </article>
  );

  const current = position.shares > 0
    ? [
        [
          <Cell
            key="a"
            v={
              <span className="fm-tk">
                <Icon sym={def.symbol} className="fm-ico16" />
                {def.symbol}
              </span>
            }
            mini="Vault"
          />,
          <Cell key="p" v={<Venue name="Perena" />} />,
          <Cell key="s" v={usd(position.valueUsd)} mini="USDC value" />,
          <Cell key="r" v={`${nf(position.shares, 6)} ${def.symbol}`} />,
          <Cell key="y" v={pct(z(product.apy7), 2)} />,
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
        <BackLink />
        <div className="fm-vh">
          <Icon sym={def.symbol} className="fm-ico28" />
          <h1>{def.name}</h1>
          <span className="fm-tag">Vault</span>
          <VTag name="Perena" />
        </div>
        <section className="fm-stats num">
          {stat("APY (7D)", pct(z(product.apy7), 2))}
          {stat("Share Price", usd(z(state?.sharePriceUsd), 6))}
          {stat("Holders", nf(z(product.holders), 0))}
          {stat("Total Value Locked", usd(z(state?.navUsd)))}
        </section>
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
                <PerenaAnalytics view={view} product={product} />
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
                ["Receipt", def.symbol],
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

/** Kamino-style Statistics grid with Perena's product details, then the recorded share price. */
function PerenaAnalytics({ view, product }: { view: VaultView; product: PerenaProduct }) {
  const { def, state, stats } = view;
  const info = PERENA_INFO[def.id];
  const junior = def.id === "perena-junior";
  const fork = z(state?.sharePriceUsd);
  const main = z(product.price);
  const sc = (h: string, value: string, sub: string, tip: string) => (
    <div className="fm-sc">
      <div className="lbl">
        {h} <Info text={tip} />
      </div>
      <b>{value}</b>
      <span>{sub}</span>
    </div>
  );
  return (
    <>
      <h2 className="fm-h21">Statistics</h2>
      <div className="fm-scg num">
        {sc("APY (7D)", pct(z(product.apy7), 2), "Published by Perena", "Perena's 7-day APY from its public API (mainnet), as on app.perena.org/earn.")}
        {sc("Holders", nf(z(product.holders), 0), `Wallets holding ${def.symbol}`, "From Perena's public API.")}
        {sc("Total Value Locked", usd(z(state?.navUsd)), `${def.symbol} supply × share price`, "Read on chain by Vanna.")}
        {sc("Share price (Perena)", usd(main, 6), `USD per ${def.symbol}, mainnet`, "Perena's live mainnet share price.")}
        {sc("Share price (Vanna)", usd(fork, 6), "What your receipt is valued at", "The on-chain NAV Vanna's oracle reads on its fork; it can lag Perena's mainnet price.")}
        {sc("Exit fee", pct((state?.exitFeeBps ?? 0) / 100, 2), junior ? "Instant withdrawals" : "No exit fee", junior ? "Vanna uses Perena's instant withdrawal path, which charges 1%." : "USD* has no lockup and no exit fee.")}
        {sc("Recorded APY 30D", pct(z(state?.apy30), 2), "From recorded share prices", "0.00% until 30 days of share prices are recorded.")}
        {sc("ROI", spct(z(stats.roi), 3), "Since recording began", "Share-price change since Vanna started recording it.")}
        {sc("Max drawdown", pct(z(stats.maxDrawdown), 3), "Since recording began", "Largest fall in share price from a previous high.")}
      </div>
      <h2 className="fm-h21">About {def.name}</h2>
      <p className="fm-sub">{info.audience}</p>
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
      <p className="fm-note">{info.vannaNote}</p>
      <SharePriceCard days={view.sharePriceDays} receipt={def.symbol} />
    </>
  );
}
