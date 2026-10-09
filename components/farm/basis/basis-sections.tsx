"use client";

/**
 * Left-column tabs of a basis-vault page: Overview (yield breakdown, APY vs USDC borrow APY, both
 * legs, risks) and Analytics (statistics, share price / funding). All Transactions lives in
 * ../vault-parts.tsx. Every figure is live ({@link VaultView}, lib/farm/basis-live.ts): fork vault
 * state, recorded share-price history, Phoenix funding history; the borrow APY the vault is compared
 * against is the real Vanna USDC pool rate. Figures that need more history than exists render as 0.
 * Styled by the design's `.fm-card` family (components/farm/farm-v3.css).
 */
import { useState, type ReactNode } from "react";
import type { VaultView } from "@/lib/farm/basis-live";
import { Icon } from "@/components/v3/icons";
import { Info, Seg } from "@/components/v3/ui";
import { nf, pct, spct, usd } from "@/components/v3/format";
import { Chips } from "../fm-ui";
import { Card, RANGES, inRange, priceAxis } from "../vault-parts";
import { BasisChart, dayLabel } from "./basis-chart";

const pctAxis = (t: number, step: number) => pct(t, step < 1 ? 1 : 0);
const sign = (v: number) => (v >= 0 ? "pos" : "neg");
const z = (v: number | null | undefined) => (v !== null && v !== undefined && Number.isFinite(v) ? v : 0);

// ── Overview ───────────────────────────────────────────────────────────────

const ICONS = {
  down: <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4l4.5 4.5 3-3L14 10M14 10V6.5M14 10h-3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  up: <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12l4.5-4.5 3 3L14 6M14 6v3.5M14 6h-3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  scale: <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v12M4 14h8M3 5h10M3 5l-1.8 4.5a1.9 1.9 0 0 0 3.6 0zM13 5l-1.8 4.5a1.9 1.9 0 0 0 3.6 0z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" /></svg>,
  venue: <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4" fill="none" /><rect x="2" y="9" width="12" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4" fill="none" /><circle cx="4.8" cy="4.75" r=".9" fill="currentColor" /><circle cx="4.8" cy="11.25" r=".9" fill="currentColor" /></svg>,
};

function Risk({ icon, title, level, value, caption }: { icon: ReactNode; title: string; level: "low" | "med" | "high"; value: string; caption: string }) {
  return (
    <div className="fm-rt">
      <div className="fm-rth">
        {icon}
        {title}
      </div>
      <div className={`fm-meter ${level}`}>
        <i />
        <i />
        <i />
        <span>{level === "low" ? "Low" : level === "med" ? "Medium" : "High"}</span>
      </div>
      <b>{value}</b>
      <span>{caption}</span>
    </div>
  );
}

export function BasisOverview({ view, borrowApy }: { view: VaultView; borrowApy: number | null }) {
  const [range, setRange] = useState(30);
  const [hover, setHover] = useState<number | null>(null);
  const { def, state, funding } = view;
  const perp = `${def.asset}-PERP`;
  const sol = def.id === "basis-sol";

  // Yield breakdown: the 7-day average funding on the share of NAV held short, the vault fee (none),
  // and whatever the realised 7-day APY leaves after funding (Phoenix fees, execution, mark moves).
  const hedge = view.hedgeShare ?? 0;
  const funding7 = funding?.stats.avg7 ?? null;
  const fundingPart = z(funding7) * hedge;
  const apy7 = state?.apy7 ?? null;
  const residual = apy7 !== null && funding7 !== null ? apy7 - fundingPart : 0;
  const parts: [string, string, number][] = [
    ["Funding", `${pct(z(funding7), 1)} 7-day average on the ${nf(hedge * 100, 0)}% held short`, fundingPart],
    ["Phoenix fees + execution", apy7 === null ? "Shown once 7 days of share-price history exist" : "Realised 7D APY minus the funding share", residual],
    ["Vault fee", "No vault, deposit or exit fee", 0],
  ];
  const max = Math.max(1e-9, ...parts.map((p) => Math.abs(p[2])));

  // Legs.
  const spotUsd = z(state?.assetValueUsd);
  const shortUsd = z(state?.shortUsd);
  const maxLeg = Math.max(spotUsd, shortUsd, 1e-9);
  const mark = z(state?.markPriceUsd);
  const shortUnits = mark > 0 ? shortUsd / mark : 0;
  const dq = mark > 1e4 ? 5 : 4;
  const equity = z(state?.phoenixEquityUsd);
  const totalCap = spotUsd + Math.max(0, equity);
  const split = totalCap > 0 ? `${nf((spotUsd / totalCap) * 100, 0)} / ${nf((Math.max(0, equity) / totalCap) * 100, 0)}` : "0 / 0";
  const delta = z(state?.netDeltaPct);
  const liq = view.shortLiqRise;
  const liqText = shortUsd > 0 ? `+${nf(z(liq), 1)}%` : "None";

  // Risks.
  const nd = funding?.stats.negativeDays30 ?? 0;
  const fd = funding?.stats.days30 ?? 0;
  const spread = z(apy7) - z(borrowApy);

  // Vault APY vs USDC borrow chart.
  const s = inRange(view.apyDays, range);
  const readout =
    hover !== null && s[hover] ? (
      <>
        {dayLabel(s[hover].at)} · Vault <b>{pct(s[hover].value, 1)}</b> · USDC borrow <b>{pct(z(borrowApy), 1)}</b> · Spread{" "}
        <b className={sign(s[hover].value - z(borrowApy))}>{spct(s[hover].value - z(borrowApy), 1)}</b>
      </>
    ) : (
      <>
        Spread today <b className={sign(spread)}>{spct(spread, 1)}</b> per borrowed dollar
      </>
    );

  return (
    <>
      <Card title="Where the yield comes from" sub={<p className="fm-sub">Last 7 days, annualised</p>}>
        <div className="fm-wf num">
          {parts.map(([name, sub, value]) => (
            <div key={name} className="fm-wfr">
              <span className="t">
                {name}
                <small>{sub}</small>
              </span>
              <span className="fm-trk">
                <span style={{ width: `${(Math.abs(value) / max) * 100}%`, background: `var(${value >= 0 ? "--ok" : "--short"})` }} />
              </span>
              <span className={`v ${sign(value)}`}>{spct(value, 1)}</span>
            </div>
          ))}
          <div className="fm-wfr tot">
            <span className="t">Vault APY (7D)</span>
            <span />
            <span className="v">{pct(z(apy7), 1)}</span>
          </div>
        </div>
      </Card>

      <Card title="Vault APY vs USDC borrow APY" sub={<p className="fm-ro num">{readout}</p>} right={<Chips value={range} options={RANGES} onChange={setRange} />}>
        <BasisChart
          data={s.map((p) => p.value)}
          dates={s.map((p) => p.at)}
          reference={borrowApy ?? undefined}
          includeZero
          formatAxis={pctAxis}
          onHover={setHover}
          empty="Daily vault APY appears once the share price has been recorded on three different days"
          ariaLabel="Daily vault APY with the USDC borrow APY as a dashed line"
        />
        <div className="fm-legend">
          <span>
            <i />
            Vault APY (day over day)
          </span>
          <span>
            <i className="d" />
            USDC borrow APY · Vanna pool
          </span>
        </div>
      </Card>

      <Card
        title="Positions"
        sub={<p className="fm-sub">Both legs · live from the vault&apos;s accounts</p>}
        right={<span className={`mini ${Math.abs(delta) <= 2 ? "ok" : ""}`}>{Math.abs(delta) <= 2 ? "Neutral" : "Drifted"}</span>}
      >
        <div className="fm-legs num">
          <div className="fm-leg">
            <span className="fm-side l">LONG</span>
            <span>
              <b>{def.asset} spot</b>
              <small>
                {sol ? <Icon sym="PHX" className="fm-ico12" /> : <Icon sym="JUP" className="fm-ico12" />}
                {sol ? "Held at Phoenix" : "Jupiter · vault token account"}
              </small>
            </span>
            <span>
              {nf(z(state?.assetUnits), dq)} {def.asset}
            </span>
            <span className="usd">{usd(spotUsd)}</span>
          </div>
          <div className="fm-leg">
            <span className="fm-side s">SHORT</span>
            <span>
              <b>{perp}</b>
              <small>
                <Icon sym="PHX" className="fm-ico12" />
                Phoenix · 1x
              </small>
            </span>
            <span>
              {nf(shortUnits, dq)} {def.asset}
            </span>
            <span className="usd">{usd(shortUsd)}</span>
          </div>
        </div>
        <div className="fm-bal" aria-hidden="true">
          <span className="l">
            <i style={{ width: `${(spotUsd / maxLeg) * 100}%` }} />
          </span>
          <span className="r">
            <i style={{ width: `${(shortUsd / maxLeg) * 100}%` }} />
          </span>
        </div>
        <div className="fm-balk num">
          <span>Long {usd(spotUsd)}</span>
          <span>Short {usd(shortUsd)}</span>
        </div>
        <div className="fm-ms num">
          <div>
            <b>{spct(delta, 2)}</b>
            <span>Net delta</span>
          </div>
          <div>
            <b>1x</b>
            <span>Hedge</span>
          </div>
          <div>
            <b>{liqText}</b>
            <span>
              {def.asset} rise to short liquidation
              {sol && shortUsd > 0 ? " (excl. SOL collateral gain)" : ""}
            </span>
          </div>
          <div>
            <b>{split}</b>
            <span>{sol ? "Spot / USDC margin (SOL is the margin)" : "Spot / short margin"}</span>
          </div>
        </div>
      </Card>

      <Card title="Risks">
        <div className="fm-rk num">
          <Risk
            icon={ICONS.down}
            title="Negative funding"
            level={nd <= 3 ? "low" : nd <= 6 ? "med" : "high"}
            value={`${nd} / ${fd || 30} days`}
            caption={`${perp} days shorts paid instead of earning`}
          />
          <Risk
            icon={ICONS.scale}
            title="Below borrow APY"
            level={spread >= 3 ? "low" : spread >= 0 ? "med" : "high"}
            value={spct(spread, 1)}
            caption="7D vault APY over USDC borrow"
          />
          <Risk
            icon={ICONS.up}
            title="Short squeeze"
            level={shortUsd <= 0 || z(liq) >= 50 ? "low" : z(liq) >= 20 ? "med" : "high"}
            value={liqText}
            caption={`${def.asset} rise to liquidation`}
          />
          <Risk icon={ICONS.venue} title="Venue risk" level="med" value="2 venues" caption="Phoenix, Jupiter, oracles" />
        </div>
      </Card>
    </>
  );
}

// ── Analytics ──────────────────────────────────────────────────────────────

export function BasisAnalytics({ view }: { view: VaultView }) {
  const [perf, setPerf] = useState<"share" | "funding">("share");
  const [range, setRange] = useState(30);
  const [hover, setHover] = useState<number | null>(null);
  const { def, state, stats, funding } = view;
  const perp = `${def.asset}-PERP`;
  const fd = funding?.stats.days30 ?? 0;
  const positive = fd ? ((fd - (funding?.stats.negativeDays30 ?? 0)) / fd) * 100 : 0;
  const fDays = (funding?.days ?? []).map((d) => ({ at: d.at, value: d.apr }));
  const shown = inRange(perf === "share" ? view.sharePriceDays : fDays, range);
  const readout =
    hover === null || !shown[hover] ? (
      perf === "share" ? `USD per ${def.symbol}, daily, from recorded vault reads` : `${perp} on Phoenix mainnet, annualised, daily average`
    ) : perf === "share" ? (
      <>
        {dayLabel(shown[hover].at)} · <b>{nf(shown[hover].value, 6)}</b> USD per {def.symbol}
      </>
    ) : (
      <>
        {dayLabel(shown[hover].at)} · Funding <b className={sign(shown[hover].value)}>{spct(shown[hover].value, 1)}</b>
      </>
    );
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
      <Card title="Statistics" sub={<p className="fm-sub">From recorded hourly share prices and Phoenix&apos;s published funding</p>}>
        <div className="fm-sg num">
          {sg("Net APY 30D", pct(z(state?.apy30), 1), "After all costs", "Annualised share-price change over 30 days; 0.00% until 30 days are recorded.")}
          {sg("Net APY 90D", pct(z(stats.apy90), 1), "After all costs", "Annualised share-price change over 90 days; 0.00% until 90 days are recorded.")}
          {sg("Since launch", pct(z(stats.sinceLaunch), 1), since)}
          {sg("ROI", spct(z(stats.roi), 2), "Share price since recording began")}
          {sg("Sharpe ratio", nf(z(stats.sharpe), 2), "Daily returns, annualised", "Mean daily return divided by its standard deviation, times the square root of 365. Needs 3 daily returns.")}
          {sg("Max drawdown", pct(z(stats.maxDrawdown), 2), "Since recording began", "Largest fall in share price from a previous high.")}
          {sg("Positive funding", `${nf(positive, 0)}%`, `Days in the last ${fd || 30}`)}
          {sg("Avg funding 30D", spct(z(funding?.stats.avg30), 1), `${perp}, annualised`)}
          {sg("Vault fee", "0%", "No vault, deposit or exit fee")}
        </div>
      </Card>

      <section className="fm-card">
        <div className="fm-ch">
          <Seg
            small
            value={perf}
            options={[
              ["share", "Share price"],
              ["funding", "Funding rate"],
            ]}
            onChange={(p) => {
              setPerf(p);
              setHover(null);
            }}
          />
          <Chips value={range} options={RANGES} onChange={setRange} />
        </div>
        <p className="fm-ro num">{readout}</p>
        <BasisChart
          key={perf}
          data={shown.map((p) => p.value)}
          dates={shown.map((p) => p.at)}
          kind={perf === "share" ? "line" : "bar"}
          formatAxis={perf === "share" ? priceAxis : pctAxis}
          onHover={setHover}
          empty={perf === "share" ? "Share-price history starts recording when the vault is read; the chart appears after two days" : "Phoenix funding history is unavailable right now"}
          ariaLabel={perf === "share" ? "Share price line chart" : "Daily funding rate bar chart"}
        />
      </section>
    </>
  );
}

