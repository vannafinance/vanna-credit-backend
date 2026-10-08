"use client";

/**
 * One Earn pool (V3 design `#earn-<SYM>`): Back to pools, the pool's stats strip, Positions |
 * Details | Activity | Collateral and Limits | Analytics, and the Supply / Withdraw form (inline at
 * ≥ 1280 px; below that a fixed bottom bar that opens the same form in a modal).
 */
import "./earn-v3.css";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/v3/icons";
import { findToken, LENDING_SYMBOLS } from "@/lib/solana/tokens";
import { EarnForm, EarnFormModal, type EarnMode } from "./earn-form";
import { TabActivity, TabAnalytics, TabCollateral, TabDetails, TabPositions } from "./earn-pool-tabs";
import { NoData, SV } from "./earn-ui";
import { fP, fQ } from "./earn-format";
import { useEarnV3 } from "./use-earn-v3";

type DTab = "positions" | "details" | "activity" | "collateral" | "analytics";
const DTABS: [DTab, string, string?][] = [
  ["positions", "Positions", "Your Positions"],
  ["details", "Details"],
  ["activity", "Activity"],
  ["collateral", "Collateral", "Collateral and Limits"],
  ["analytics", "Analytics"],
];

/** Pool screen for registry symbol `id` (case-insensitive). */
export function EarnPool({ id, initialTab = "details", initialMode = "supply" }: { id: string; initialTab?: DTab; initialMode?: EarnMode }) {
  const router = useRouter();
  const d = useEarnV3();
  const token = findToken(decodeURIComponent(id));
  const [tab, setTab] = useState<DTab>(initialTab);
  const [sheet, setSheet] = useState<EarnMode | null>(null);
  const back = (
    <nav aria-label="Breadcrumb">
      <button type="button" className="earn-back" onClick={() => router.push("/earn")}>
        {SV.chevL}Back to pools
      </button>
    </nav>
  );

  if (!token) {
    return (
      <div className="earn earn-pg">
        <header className="earn-ph">{back}</header>
        <NoData text={`There is no Vanna lending pool for "${decodeURIComponent(id)}". Supported pools: ${LENDING_SYMBOLS.join(", ")}.`} />
      </div>
    );
  }
  const sym = token.symbol;
  const p = d.pools[sym];
  const px = d.prices[sym] ?? 0;
  const status = p ? (p.initialised ? p.status : "Not initialised") : "…";
  const ok = Boolean(p?.initialised);
  const u = (n: number) => (px > 0 ? `$${fQ(n * px, 2)}` : "—");
  const strip: [string, string, string?][] = [
    ["Total Supply", ok ? u(p.totalSupplied) : "—", ok ? `${fQ(p.totalSupplied)} ${sym}` : undefined],
    ["Available Liquidity", ok ? u(p.availableLiquidity) : "—", ok ? `${fQ(p.availableLiquidity)} ${sym}` : undefined],
    ["Utilization Rate", ok ? fP(p.utilization * 100) : "—"],
    ["Supply APY", ok ? fP(p.supplyApr * 100) : "—"],
  ];
  const withdrawOnly = !token.lendable;
  const steps: [string, string][] = [
    ["Supply assets", `Deposit ${sym} into the vault to provide liquidity`],
    ["Receive vault shares", `Get v${sym} share tokens representing your share of the pool`],
    ["Earn yield", "Borrowers pay interest which accrues to your position automatically"],
    ["Withdraw anytime", "Redeem your vault shares for the underlying asset plus earned yield, up to the pool's available liquidity"],
  ];

  return (
    <div className="earn earn-pg" data-pool={sym}>
      <header className="earn-ph">
        {back}
        <div className="earn-pt">
          <Icon sym={sym} className="earn-i34" />
          <div className="earn-ptn">
            <h1>{sym}</h1>
            <span className="earn-act-tag">{status}</span>
          </div>
        </div>
      </header>
      <section className="earn-gs" aria-label="Statistics Overview">
        {strip.map(([k, v, s]) => (
          <article key={k}>
            <h3>{k}</h3>
            <div>
              <p className="num">{v}</p>
              {s && <p className="s num">{s}</p>}
            </div>
          </article>
        ))}
      </section>
      <section className="earn-pbody" aria-label="Vault Details and Actions">
        <article className="earn-pmain">
          <nav className="earn-btabs" aria-label="Vault Information Tabs">
            {DTABS.map(([k, s, l]) => (
              <button key={k} type="button" className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {l ? (
                  <>
                    <span className="earn-short">{s}</span>
                    <span className="earn-long">{l}</span>
                  </>
                ) : (
                  s
                )}
              </button>
            ))}
          </nav>
          {tab === "positions" && <TabPositions sym={sym} d={d} />}
          {tab === "details" && <TabDetails sym={sym} d={d} />}
          {tab === "activity" && <TabActivity sym={sym} d={d} />}
          {tab === "collateral" && <TabCollateral />}
          {tab === "analytics" && <TabAnalytics sym={sym} d={d} />}
        </article>
        <aside className="earn-paside" aria-label="Transaction Form">
          {withdrawOnly && (
            <div className="earn-hfc" role="status">
              <span className="s">{sym} no longer has an Earn pool — it&apos;s collateral-only on the Margin page. You can still withdraw an existing position here.</span>
            </div>
          )}
          <EarnForm key={sym} symbol={sym} withdrawOnly={withdrawOnly} initialMode={initialMode} />
          <div className="earn-how">
            <p className="t">How it works</p>
            {steps.map(([t, s], i) => (
              <div key={t} className="earn-hs">
                <span className="n">{i + 1}</span>
                <div>
                  <span className="a">{t}</span>
                  <span className="b">{s}</span>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </section>
      <div className="earn-sheet" role="region" aria-label="Liquidity Actions">
        <span className="earn-handle" aria-hidden="true" />
        <nav className="earn-btabs fm">
          {!withdrawOnly && (
            <button type="button" className="on" onClick={() => setSheet("supply")}>
              Supply Liquidity
            </button>
          )}
          <button type="button" className={withdrawOnly ? "on" : ""} onClick={() => setSheet("withdraw")}>
            Withdraw Liquidity
          </button>
        </nav>
      </div>
      {sheet && <EarnFormModal symbol={sym} mode={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
