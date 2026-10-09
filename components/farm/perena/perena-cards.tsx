"use client";

/**
 * Perena section of the Farm list's Lending/Single Assets tab: one V3 card per integrated Perena
 * product (USD*, USD* Junior — not USD* Protected), styled after app.perena.org/earn: banner, icon,
 * audience line, description, tags, APY / TVL / Holders boxes, the wallet's holding, and Deposit /
 * Withdraw buttons into /farm/perena/{usdstar|junior}?action=….
 *
 * Data: APY and holders from Perena's public API (GET /api/farm/perena); TVL from the fork's
 * on-chain NAV (`useVaults`); the holding from the margin account. Unavailable figures show as 0.
 */
import Link from "next/link";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import { useVaults, useVaultAccount } from "@/lib/farm/use-vaults";
import { perenaProduct, usePerenaMarket, vaultHref } from "@/lib/farm/basis-live";
import { PERENA_INFO } from "@/lib/farm/perena-info";
import { Icon } from "@/components/v3/icons";
import { nf, pct, usd, usdC } from "@/components/v3/format";

export function PerenaCards({ query = "", keepAsset = () => true }: { query?: string; keepAsset?: (s: string) => boolean }) {
  const live = useVaults();
  const market = usePerenaMarket();
  const { margin } = useVaultAccount();
  const q = query.trim().toLowerCase();
  const defs = VAULTS.filter((v) => v.kind === "perena" && (!q || `${v.name} ${v.symbol} perena usdc`.toLowerCase().includes(q)) && keepAsset(v.asset));
  if (!defs.length) return null;
  return (
    <>
      <h2 className="fm-tblh">
        <Icon sym="Perena" className="fm-ico16 fm-inl" />
        Perena vaults
      </h2>
      <div className="fm-pcs-grid">
        {defs.map((v) => {
          const info = PERENA_INFO[v.id];
          const p = perenaProduct(market, v.id);
          const s = live.data.find((x) => x.id === v.id);
          const holding = margin?.collateral.find((c) => c.mint === v.mint);
          const href = vaultHref(v.id);
          return (
            <section key={v.id} className="fm-card fm-pc">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="fm-pc-bn" src={info.banner} alt="" aria-hidden="true" />
              <div className="fm-pc-in">
                <div className="fm-pc-h">
                  <Icon sym={info.icon} className="fm-ico28" />
                  <div>
                    <h3>
                      <Link href={href}>{v.name}</Link>
                    </h3>
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
                  {s?.stale && <span className="mini">NAV stale</span>}
                </div>
                <div className="fm-pc-st num">
                  <div>
                    <span>APY</span>
                    <b className={(p.apy7 ?? 0) > 0 ? "pos" : ""}>{pct(p.apy7 ?? 0, 2)}</b>
                  </div>
                  <div>
                    <span>TVL</span>
                    <b>{usdC(s?.navUsd ?? 0)}</b>
                  </div>
                  <div>
                    <span>Holders</span>
                    <b>{nf(p.holders ?? 0, 0)}</b>
                  </div>
                </div>
                <div className="fm-pc-hold num">
                  <span>Your holding</span>
                  <b>
                    {nf(holding?.amount ?? 0, 4)} {v.symbol} · {usd(holding?.usd ?? 0)}
                  </b>
                </div>
                <div className="fm-pc-act">
                  <Link className="dep" href={`${href}?action=deposit`}>
                    Deposit
                  </Link>
                  <Link className="wd" href={`${href}?action=withdraw`}>
                    Withdraw
                  </Link>
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
