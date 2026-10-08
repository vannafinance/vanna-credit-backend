"use client";

/**
 * Left-column tabs of a basis-vault page: Overview (yield breakdown, APY vs borrow APY, both legs,
 * risks), Analytics (statistics, share price / funding, monthly returns, capital allocation) and
 * All Transactions. Vault figures are sample data (lib/farm/basis-vaults.ts); the borrow APY the
 * vault is compared against is the real Vanna pool rate of the selected deposit token.
 * Styled by the design's `.fm-card` family (components/farm/farm-v3.css).
 */
import { useState, type ReactNode } from "react";
import { HEDGE, SERIES_DAYS, monthlyReturns, seriesLabel, type BasisVault } from "@/lib/farm/basis-vaults";
import { Icon } from "@/components/v3/icons";
import { Info, Seg } from "@/components/v3/ui";
import { nf, pct, spct, usdC } from "@/components/v3/format";
import { Chips } from "../fm-ui";
import { BasisChart } from "./basis-chart";

const pctAxis = (t: number, step: number) => pct(t, step < 1 ? 1 : 0);
/** Share price shrinks to ~4 significant digits on the axis. */
const priceAxis = (t: number, step: number) => nf(t, Math.max(2, -Math.floor(Math.log10(step))));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Range chips used above every basis chart. */
export const RANGES: [number, string][] = [
  [7, "1 Week"],
  [30, "1 Month"],
  [90, "3 Months"],
  [SERIES_DAYS, "All Time"],
];
const sign = (v: number) => (v >= 0 ? "pos" : "neg");

/** The design's `.fm-card` with its header row. */
function Card({ title, sub, right, children }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="fm-card">
      {(title || right) && (
        <div className="fm-ch">
          <div>
            {title && <h3>{title}</h3>}
            {sub}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

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

export function BasisOverview({ vault: v, token, borrowApy }: { vault: BasisVault; token: string; borrowApy: number | null }) {
  const [range, setRange] = useState(30);
  const [hover, setHover] = useState<number | null>(null);

  const gross = v.funding7 * HEDGE - v.perpFee * HEDGE - v.exec;
  const parts: [string, string, number][] = [
    ["Funding", `${pct(v.funding7, 1)} on the half held short`, v.funding7 * HEDGE],
    ["Phoenix fees", "Position and borrow fees", -v.perpFee * HEDGE],
    ["Execution", "Jupiter swaps, rebalancing", -v.exec],
    ["Vault fee", `${v.fee}% of profit`, (-gross * v.fee) / 100],
  ];
  const max = Math.max(...parts.map((p) => Math.abs(p[2])));
  const leg = v.tvl * HEDGE;
  const spot = leg * (1 + v.delta / 100);
  const maxLeg = Math.max(leg, spot);
  const dq = v.price > 1e4 ? 3 : 1;
  const spread = borrowApy === null ? null : v.apy7 - borrowApy;
  const squeeze = 98;
  const nd = v.negativeDays30;

  const s = SERIES_DAYS - range;
  const series = v.apy.slice(s);
  const readout =
    hover !== null ? (
      <>
        {seriesLabel(s + hover)} · Vault <b>{pct(series[hover], 1)}</b>
        {borrowApy !== null && (
          <>
            {" "}· {token} borrow <b>{pct(borrowApy, 1)}</b> · Spread <b className={sign(series[hover] - borrowApy)}>{spct(series[hover] - borrowApy, 1)}</b>
          </>
        )}
      </>
    ) : spread !== null ? (
      <>
        Spread today <b className={sign(spread)}>{spct(spread, 1)}</b> per borrowed dollar
      </>
    ) : (
      <>{token} borrow APY unavailable</>
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
            <span className="t">Vault APY</span>
            <span />
            <span className="v">{pct(v.apy7, 1)}</span>
          </div>
        </div>
      </Card>

      <Card title={`Vault APY vs ${token} borrow APY`} sub={<p className="fm-ro num">{readout}</p>} right={<Chips value={range} options={RANGES} onChange={setRange} />}>
        <BasisChart data={series} start={s} reference={borrowApy ?? undefined} includeZero formatAxis={pctAxis} onHover={setHover} ariaLabel="Daily vault APY with the borrow APY as a dashed line" />
        <div className="fm-legend">
          <span>
            <i />
            Vault APY
          </span>
          <span>
            <i className="d" />
            {token} borrow APY · follows the token you deposit
          </span>
        </div>
      </Card>

      <Card title="Positions" sub={<p className="fm-sub">Both legs · rebalanced {v.rebalanced}</p>} right={<span className="mini ok">Neutral</span>}>
        <div className="fm-legs num">
          <div className="fm-leg">
            <span className="fm-side l">LONG</span>
            <span>
              <b>{v.asset} spot</b>
              <small>
                <Icon sym="JUP" className="fm-ico12" />
                Jupiter
              </small>
            </span>
            <span>
              {nf(spot / v.price, dq)} {v.asset}
            </span>
            <span className="usd">{usdC(spot)}</span>
          </div>
          <div className="fm-leg">
            <span className="fm-side s">SHORT</span>
            <span>
              <b>{v.perp}</b>
              <small>
                <Icon sym="PHX" className="fm-ico12" />
                Phoenix · 1x
              </small>
            </span>
            <span>
              {nf(leg / v.price, dq)} {v.asset}
            </span>
            <span className="usd">{usdC(leg)}</span>
          </div>
        </div>
        <div className="fm-bal" aria-hidden="true">
          <span className="l">
            <i style={{ width: `${(spot / maxLeg) * 100}%` }} />
          </span>
          <span className="r">
            <i style={{ width: `${(leg / maxLeg) * 100}%` }} />
          </span>
        </div>
        <div className="fm-balk num">
          <span>Long {usdC(spot)}</span>
          <span>Short {usdC(leg)}</span>
        </div>
        <div className="fm-ms num">
          <div>
            <b>{spct(v.delta, 2)}</b>
            <span>Net delta</span>
          </div>
          <div>
            <b>1x</b>
            <span>Hedge</span>
          </div>
          <div>
            <b>+{squeeze}%</b>
            <span>{v.asset} rise to short liquidation</span>
          </div>
          <div>
            <b>50 / 50</b>
            <span>Spot / short margin</span>
          </div>
        </div>
      </Card>

      <Card title="Risks">
        <div className="fm-rk num">
          <Risk icon={ICONS.down} title="Negative funding" level={nd <= 3 ? "low" : nd <= 6 ? "med" : "high"} value={`${nd} / 30 days`} caption="shorts paid instead of earning" />
          <Risk
            icon={ICONS.scale}
            title="Below borrow APY"
            level={spread === null ? "med" : spread >= 3 ? "low" : spread >= 0 ? "med" : "high"}
            value={spread === null ? "—" : spct(spread, 1)}
            caption={`spread over ${token} borrow`}
          />
          <Risk icon={ICONS.up} title="Short squeeze" level="low" value={`+${squeeze}%`} caption={`${v.asset} rise to liquidation`} />
          <Risk icon={ICONS.venue} title="Venue risk" level="med" value="2 venues" caption="Phoenix, Jupiter, oracles" />
        </div>
      </Card>
    </>
  );
}

// ── Analytics ──────────────────────────────────────────────────────────────

export function BasisAnalytics({ vault: v }: { vault: BasisVault }) {
  const [perf, setPerf] = useState<"share" | "funding">("share");
  const [range, setRange] = useState(90);
  const [hover, setHover] = useState<number | null>(null);
  const [fees, setFees] = useState<"gross" | "net">("net");
  const [basis, setBasis] = useState<"roi" | "apy">("roi");
  const m = monthlyReturns(v, fees, basis);

  const s = SERIES_DAYS - range;
  const data = perf === "share" ? v.sharePrice.slice(s) : v.funding.slice(s);
  const readout =
    hover === null ? (
      perf === "share" ? `USDC per ${v.share}, net of fees` : `${v.perp} on Phoenix, annualised, daily`
    ) : perf === "share" ? (
      <>
        {seriesLabel(s + hover)} · <b>{nf(data[hover], 4)}</b> USDC per {v.share}
      </>
    ) : (
      <>
        {seriesLabel(s + hover)} · Funding <b className={sign(data[hover])}>{spct(data[hover], 1)}</b> · Vault that day <b>{pct(v.apy[s + hover], 1)}</b>
      </>
    );

  const leg = v.tvl * HEDGE;
  const idle = v.tvl * 0.004;
  const alloc: [string, string, number, string, string?][] = [
    ["Jupiter", `Spot ${v.asset}`, leg - idle / 2, "var(--long)", "JUP"],
    ["Phoenix", `${v.perp} short margin (USDC)`, leg - idle / 2, "var(--short)", "PHX"],
    ["Idle", "USDC buffer for withdrawals", idle, "var(--quiet)"],
  ];
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
      <Card title="Statistics">
        <div className="fm-sg num">
          {sg("Net APY 30D", pct(v.apy30, 1), "After all fees")}
          {sg("Net APY 90D", pct(v.apy90, 1), "After all fees")}
          {sg("Since launch", pct(v.apyAll, 1), `Annualised, from ${seriesLabel(0)}`)}
          {sg("ROI", spct(v.roi, 2), "Since launch, net")}
          {sg("Sharpe ratio", nf(v.sharpe, 2), "Daily returns, annualised", "Mean daily return divided by its standard deviation, times the square root of 365.")}
          {sg("Max drawdown", pct(v.maxDrawdown, 2), "Since launch", "Largest fall in share price from a previous high.")}
          {sg("Positive funding", `${nf(((30 - v.negativeDays30) / 30) * 100, 0)}%`, "Days in the last 30")}
          {sg("Avg funding 30D", spct(v.funding30, 1), `${v.perp}, annualised`)}
          {sg("Vault fee", `${v.fee}%`, "Of profit · no deposit or exit fee")}
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
          data={data}
          start={s}
          kind={perf === "share" ? "line" : "bar"}
          formatAxis={perf === "share" ? priceAxis : pctAxis}
          onHover={setHover}
          ariaLabel={perf === "share" ? "Share price line chart" : "Daily funding rate bar chart"}
        />
      </section>

      <Card
        title="Monthly returns"
        sub={
          <p className="fm-sub num">
            Since launch {spct(m.since, 1)} {fees} · from {seriesLabel(0)}
          </p>
        }
        right={
          <div className="fm-tgl">
            FEES{" "}
            <Seg
              small
              value={fees}
              options={[
                ["gross", "Gross"],
                ["net", "Net"],
              ]}
              onChange={setFees}
            />{" "}
            BASIS{" "}
            <Seg
              small
              value={basis}
              options={[
                ["roi", "ROI"],
                ["apy", "APY"],
              ]}
              onChange={setBasis}
            />
          </div>
        }
      >
        <div className="fm-mtw">
          <table className="fm-mt num">
            <thead>
              <tr>
                <th>Year</th>
                {MONTHS.map((mo) => (
                  <th key={mo}>{mo}</th>
                ))}
                <th>YTD</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(m.rows).map((ys) => {
                const y = Number(ys);
                return (
                  <tr key={y}>
                    <td className="y">{y}</td>
                    {MONTHS.map((_, i) => {
                      const cell = m.rows[y][i];
                      return cell ? (
                        <td key={i} className={sign(cell.value)}>
                          {spct(cell.value, 1)}
                          {cell.mtd && <sup>MTD</sup>}
                        </td>
                      ) : (
                        <td key={i} className="e">
                          –
                        </td>
                      );
                    })}
                    <td className={`y ${sign(m.ytd[y])}`}>{spct(m.ytd[y], 1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Where the capital sits" sub={<p className="fm-sub num">{usdC(v.tvl)} across 2 venues</p>}>
        <div className="fm-al">
          {alloc.map(([name, , amount, color]) => (
            <i key={name} style={{ width: `${(amount / v.tvl) * 100}%`, background: color }} />
          ))}
        </div>
        {alloc.map(([name, sub, amount, color, logo]) => (
          <div key={name} className="fm-alr num">
            <span className="sw" style={{ background: color }} />
            <span>
              <b>
                {logo && <Icon sym={logo} className="fm-ico14" />}
                {name}
              </b>
              <small>{sub}</small>
            </span>
            <span>{usdC(amount)}</span>
            <span className="p">{pct((amount / v.tvl) * 100, 1)}</span>
          </div>
        ))}
      </Card>
    </>
  );
}

// ── All Transactions ───────────────────────────────────────────────────────

export function BasisTransactions({ vault: v }: { vault: BasisVault }) {
  const [tab, setTab] = useState<"current" | "vault">("current");
  const N = SERIES_DAYS;
  const dp = v.price > 1e4 ? 4 : 2;
  // Vault-wide activity (sample): daily funding settlements and a keeper rebalance.
  const activity: string[][] = [
    [seriesLabel(N - 1), "Funding settled", `+${usdC((v.tvl * v.apy7) / 36500)}`, "—", "Vault"],
    [seriesLabel(N - 2), "Rebalance", `Short +${nf(504 / v.price, dp)} ${v.asset}`, "—", "Keeper"],
    [seriesLabel(N - 2), "Funding settled", `+${usdC((v.tvl * v.apy[N - 2]) / 36500)}`, "—", "Vault"],
    [seriesLabel(N - 3), "Funding settled", `+${usdC((v.tvl * v.apy[N - 3]) / 36500)}`, "—", "Vault"],
  ];
  return (
    <>
      <section className="fm-card">
        <div className="fm-pvh">
          <div>
            <div className="lbl">My Vault Position</div>
            <div className="fm-big num">—</div>
          </div>
        </div>
        <div className="fm-nopos">No position in this vault yet</div>
      </section>
      <section className="fm-card">
        <div className="fm-ch">
          <h3>All Transactions</h3>
          <Seg
            small
            value={tab}
            options={[
              ["current", "Current Position"],
              ["vault", "Vault Activity"],
            ]}
            onChange={setTab}
          />
        </div>
        {tab === "current" ? (
          <div className="fm-nopos">No position in this vault yet</div>
        ) : (
          <div className="fm-mtw">
            <table className="fm-txt num">
              <thead>
                <tr>
                  {["Date", "Action", "Amount", "Shares", "By"].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activity.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
