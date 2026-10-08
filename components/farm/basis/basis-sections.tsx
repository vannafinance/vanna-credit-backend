"use client";

/**
 * Left-column tabs of a basis-vault page: Overview (yield breakdown, APY vs borrow APY, both legs,
 * risks), Analytics (statistics, share price / funding, monthly returns, capital allocation) and
 * All Transactions. Vault figures are sample data (lib/farm/basis-vaults.ts); the borrow APY the
 * vault is compared against is the real Vanna pool rate of the selected deposit token.
 */
import { useState, type ReactNode } from "react";
import {
  HEDGE,
  SERIES_DAYS,
  fmtNum,
  fmtPct,
  fmtSignedPct,
  fmtUsdCompact,
  monthlyReturns,
  seriesLabel,
  type BasisVault,
} from "@/lib/farm/basis-vaults";
import { BasisChart, RangeChips } from "./basis-chart";
import { BasisCard, Info, MiniTag, RANGES, Segmented, useBasisColors, useSignClass } from "./basis-ui";

const pctAxis = (t: number, step: number) => fmtPct(t, step < 1 ? 1 : 0);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Share price shrinks to ~4 significant digits on the axis. */
const priceAxis = (t: number, step: number) => fmtNum(t, Math.max(2, -Math.floor(Math.log10(step))));

// ── Overview ───────────────────────────────────────────────────────────────

function Meter({ level }: { level: "low" | "med" | "high" }) {
  const c = useBasisColors();
  const color = level === "low" ? (c.isDark ? "#3FC0A3" : "#0B7A63") : level === "med" ? (c.isDark ? "#E0AC5C" : "#8A5A06") : c.isDark ? "#F0666E" : "#C9333B";
  const filled = level === "low" ? 1 : level === "med" ? 2 : 3;
  return (
    <div className="flex items-center gap-[3px] text-[11px] font-semibold" style={{ color }}>
      {[0, 1, 2].map((i) => (
        <i key={i} className={`block w-3.5 h-1 rounded-sm ${i < filled ? "" : c.track}`} style={i < filled ? { background: color } : undefined} />
      ))}
      <span className="ml-1">{level === "low" ? "Low" : level === "med" ? "Medium" : "High"}</span>
    </div>
  );
}

function RiskTile({ icon, title, level, value, caption }: { icon: ReactNode; title: string; level: "low" | "med" | "high"; value: string; caption: string }) {
  const c = useBasisColors();
  return (
    <div className={`rounded-xl border p-3 flex flex-col gap-2 min-w-0 ${c.tile} ${c.line}`}>
      <div className={`flex items-center gap-1.5 text-[12px] font-semibold ${c.title}`}>
        <span className="text-[#703AE6] shrink-0">{icon}</span>
        {title}
      </div>
      <Meter level={level} />
      <div className={`text-[16px] font-semibold leading-tight tabular-nums ${c.text}`}>{value}</div>
      <div className={`text-[11px] ${c.label}`}>{caption}</div>
    </div>
  );
}

const ICONS = {
  down: <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4l4.5 4.5 3-3L14 10M14 10V6.5M14 10h-3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  up: <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 12l4.5-4.5 3 3L14 6M14 6v3.5M14 6h-3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  scale: <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v12M4 14h8M3 5h10M3 5l-1.8 4.5a1.9 1.9 0 0 0 3.6 0zM13 5l-1.8 4.5a1.9 1.9 0 0 0 3.6 0z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" /></svg>,
  venue: <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4" fill="none" /><rect x="2" y="9" width="12" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4" fill="none" /></svg>,
};

export function BasisOverview({ vault: v, token, borrowApy }: { vault: BasisVault; token: string; borrowApy: number | null }) {
  const c = useBasisColors();
  const sign = useSignClass();
  const [range, setRange] = useState(30);
  const [hover, setHover] = useState<number | null>(null);

  const gross = v.funding7 * HEDGE - v.perpFee * HEDGE - v.exec;
  const parts: [string, string, number][] = [
    ["Funding", `${fmtPct(v.funding7)} on the half held short`, v.funding7 * HEDGE],
    ["Phoenix fees", "Position and borrow fees", -v.perpFee * HEDGE],
    ["Execution", "Jupiter swaps, rebalancing", -v.exec],
    ["Vault fee", `${v.fee}% of profit`, (-gross * v.fee) / 100],
  ];
  const max = Math.max(...parts.map((p) => Math.abs(p[2])));

  const leg = v.tvl * HEDGE;
  const spot = leg * (1 + v.delta / 100);
  const maxLeg = Math.max(leg, spot);
  const tokenDp = v.price > 1e4 ? 3 : 1;
  const spread = borrowApy === null ? null : v.apy7 - borrowApy;
  const squeeze = 98;
  const nd = v.negativeDays30;

  const s = SERIES_DAYS - range;
  const series = v.apy.slice(s);
  const readout =
    hover !== null ? (
      <>
        {seriesLabel(s + hover)} · Vault <b className={c.title}>{fmtPct(series[hover])}</b>
        {borrowApy !== null && (
          <>
            {" "}· {token} borrow <b className={c.title}>{fmtPct(borrowApy)}</b> · Spread{" "}
            <b className={sign(series[hover] - borrowApy)}>{fmtSignedPct(series[hover] - borrowApy)}</b>
          </>
        )}
      </>
    ) : spread !== null ? (
      <>
        Spread today <b className={sign(spread)}>{fmtSignedPct(spread)}</b> per borrowed dollar
      </>
    ) : (
      <>{token} borrow APY unavailable</>
    );

  return (
    <>
      <BasisCard title="Where the yield comes from" sub="Last 7 days, annualised">
        <div className="grid gap-2.5 tabular-nums">
          {parts.map(([name, sub, value]) => (
            <div key={name} className="grid grid-cols-[minmax(0,1fr)_minmax(60px,200px)_58px] gap-3 items-center text-[13px]">
              <span className={`min-w-0 ${c.text}`}>
                {name}
                <small className={`block text-[11px] ${c.label}`}>{sub}</small>
              </span>
              <span className={`block h-2 rounded-full overflow-hidden ${c.track}`}>
                <span className="block h-full rounded-full" style={{ width: `${(Math.abs(value) / max) * 100}%`, background: value >= 0 ? (c.isDark ? "#3FC0A3" : "#0B7A63") : c.isDark ? "#F0666E" : "#FC5457" }} />
              </span>
              <span className={`text-right font-semibold ${sign(value)}`}>{fmtSignedPct(value)}</span>
            </div>
          ))}
          <div className={`grid grid-cols-[minmax(0,1fr)_minmax(60px,200px)_58px] gap-3 items-center text-[13px] border-t pt-2.5 ${c.line}`}>
            <span className={`font-semibold ${c.title}`}>Vault APY</span>
            <span />
            <span className={`text-right font-semibold ${c.text}`}>{fmtPct(v.apy7)}</span>
          </div>
        </div>
      </BasisCard>

      <BasisCard
        title={`Vault APY vs ${token} borrow APY`}
        sub={<span className="tabular-nums">{readout}</span>}
        right={<RangeChips value={range} options={RANGES} onChange={setRange} />}
      >
        <BasisChart data={series} start={s} reference={borrowApy ?? undefined} includeZero formatAxis={pctAxis} onHover={setHover} ariaLabel="Daily vault APY with the borrow APY as a dashed line" />
        <div className={`flex gap-3.5 flex-wrap text-[11px] mt-2 ${c.label}`}>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block w-3.5 border-t-2 border-[#703AE6]" />Vault APY</span>
          <span className="inline-flex items-center gap-1.5"><i className={`inline-block w-3.5 border-t-2 border-dashed ${c.isDark ? "border-[#888888]" : "border-[#777777]"}`} />{token} borrow APY · follows the token you deposit</span>
        </div>
      </BasisCard>

      <BasisCard
        title="Positions"
        sub={`Both legs · rebalanced ${v.rebalanced}`}
        right={<MiniTag className={c.isDark ? "!bg-[#3FC0A3]/10 !text-[#3FC0A3]" : "!bg-[#10B981]/10 !text-[#0B7A63]"}>Neutral</MiniTag>}
      >
        <div className="grid gap-2 tabular-nums">
          {[
            { side: "LONG", what: `${v.asset} spot`, venue: "Jupiter", amount: spot },
            { side: "SHORT", what: v.perp, venue: "Phoenix · 1x", amount: leg },
          ].map((l) => (
            <div key={l.side} className={`grid grid-cols-[54px_minmax(0,1fr)_auto] sm:grid-cols-[62px_minmax(0,1fr)_auto_auto] gap-3 items-center text-[13px] px-3 py-2.5 rounded-[10px] ${c.tile}`}>
              <span
                className={`text-[11px] font-bold tracking-wide text-center rounded-md py-0.5 ${
                  l.side === "LONG" ? (c.isDark ? "text-[#4FD3DD] bg-[#32EEE2]/15" : "text-[#1C7C83] bg-[#32EEE2]/20") : c.isDark ? "text-[#F0666E] bg-[#F0666E]/15" : "text-[#C9333B] bg-[#FC5457]/10"
                }`}
              >
                {l.side}
              </span>
              <span className="min-w-0">
                <b className={`font-semibold ${c.title}`}>{l.what}</b>
                <small className={`block text-[11px] ${c.label}`}>{l.venue}</small>
              </span>
              <span className={c.text}>
                {fmtNum(l.amount / v.price, tokenDp)} {v.asset}
              </span>
              <span className={`hidden sm:inline ${c.text}`}>{fmtUsdCompact(l.amount)}</span>
            </div>
          ))}
        </div>
        {/* Long vs short balance bar, centred on the neutral line */}
        <div className="relative grid grid-cols-2 h-2.5 mt-4 mb-1.5" aria-hidden="true">
          <span className="flex justify-end">
            <i className={`block h-full rounded-l-full ${c.isDark ? "bg-[#32EEE2]" : "bg-[#22CED9]"}`} style={{ width: `${(spot / maxLeg) * 100}%` }} />
          </span>
          <span>
            <i className={`block h-full rounded-r-full ${c.isDark ? "bg-[#F0666E]" : "bg-[#FC5457]"}`} style={{ width: `${(leg / maxLeg) * 100}%` }} />
          </span>
          <span className={`absolute left-1/2 -top-1 -bottom-1 w-0.5 -translate-x-px rounded ${c.isDark ? "bg-white" : "bg-[#181822]"}`} />
        </div>
        <div className={`flex justify-between text-[11px] ${c.label}`}>
          <span>Long {fmtUsdCompact(spot)}</span>
          <span>Short {fmtUsdCompact(leg)}</span>
        </div>
        <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3.5 pt-3.5 border-t tabular-nums ${c.line}`}>
          {[
            [fmtSignedPct(v.delta, 2), "Net delta"],
            ["1x", "Hedge"],
            [`+${squeeze}%`, `${v.asset} rise to short liquidation`],
            ["50 / 50", "Spot / short margin"],
          ].map(([value, k]) => (
            <div key={k}>
              <div className={`text-[14px] font-semibold ${c.title}`}>{value}</div>
              <div className={`text-[11px] ${c.label}`}>{k}</div>
            </div>
          ))}
        </div>
      </BasisCard>

      <BasisCard title="Risks">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <RiskTile icon={ICONS.down} title="Negative funding" level={nd <= 3 ? "low" : nd <= 6 ? "med" : "high"} value={`${nd} / 30 days`} caption="shorts paid instead of earning" />
          <RiskTile
            icon={ICONS.scale}
            title="Below borrow APY"
            level={spread === null ? "med" : spread >= 3 ? "low" : spread >= 0 ? "med" : "high"}
            value={spread === null ? "—" : fmtSignedPct(spread)}
            caption={`spread over ${token} borrow`}
          />
          <RiskTile icon={ICONS.up} title="Short squeeze" level="low" value={`+${squeeze}%`} caption={`${v.asset} rise to liquidation`} />
          <RiskTile icon={ICONS.venue} title="Venue risk" level="med" value="2 venues" caption="Phoenix, Jupiter, oracles" />
        </div>
      </BasisCard>
    </>
  );
}

// ── Analytics ──────────────────────────────────────────────────────────────

export function BasisAnalytics({ vault: v }: { vault: BasisVault }) {
  const c = useBasisColors();
  const sign = useSignClass();
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
        {seriesLabel(s + hover)} · <b className={c.title}>{fmtNum(data[hover], 4)}</b> USDC per {v.share}
      </>
    ) : (
      <>
        {seriesLabel(s + hover)} · Funding <b className={sign(data[hover])}>{fmtSignedPct(data[hover])}</b> · Vault that day{" "}
        <b className={c.title}>{fmtPct(v.apy[s + hover])}</b>
      </>
    );

  const leg = v.tvl * HEDGE;
  const idle = v.tvl * 0.004;
  const alloc: [string, string, number, string][] = [
    ["Jupiter", `Spot ${v.asset}`, leg - idle / 2, c.isDark ? "#32EEE2" : "#22CED9"],
    ["Phoenix", `${v.perp} short margin (USDC)`, leg - idle / 2, c.isDark ? "#F0666E" : "#FC5457"],
    ["Idle", "USDC buffer for withdrawals", idle, "#9CA3AF"],
  ];

  const stat = (k: string, value: string, d: string, tip?: string) => (
    <div key={k}>
      <div className={`flex items-center gap-1 text-[12px] font-medium whitespace-nowrap ${c.label}`}>
        {k}
        {tip && <Info text={tip} label={k} />}
      </div>
      <div className={`text-[16px] font-semibold mt-1 ${c.text}`}>{value}</div>
      <div className={`text-[11px] ${c.label}`}>{d}</div>
    </div>
  );

  return (
    <>
      <BasisCard title="Statistics">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-5 tabular-nums">
          {stat("Net APY 30D", fmtPct(v.apy30), "After all fees")}
          {stat("Net APY 90D", fmtPct(v.apy90), "After all fees")}
          {stat("Since launch", fmtPct(v.apyAll), `Annualised, from ${seriesLabel(0)}`)}
          {stat("ROI", fmtSignedPct(v.roi, 2), "Since launch, net")}
          {stat("Sharpe ratio", fmtNum(v.sharpe, 2), "Daily returns, annualised", "Mean daily return divided by its standard deviation, times the square root of 365.")}
          {stat("Max drawdown", fmtPct(v.maxDrawdown, 2), "Since launch", "Largest fall in share price from a previous high.")}
          {stat("Positive funding", `${fmtNum(((30 - v.negativeDays30) / 30) * 100, 0)}%`, "Days in the last 30")}
          {stat("Avg funding 30D", fmtSignedPct(v.funding30), `${v.perp}, annualised`)}
          {stat("Vault fee", `${v.fee}%`, "Of profit · no deposit or exit fee")}
        </div>
      </BasisCard>

      <BasisCard
        title={<Segmented size="sm" value={perf} options={[["share", "Share price"], ["funding", "Funding rate"]]} onChange={(p) => { setPerf(p); setHover(null); }} />}
        right={<RangeChips value={range} options={RANGES} onChange={setRange} />}
      >
        <p className={`text-[12px] min-h-[18px] -mt-1.5 mb-1 tabular-nums ${c.label}`}>{readout}</p>
        <BasisChart
          key={perf}
          data={data}
          start={s}
          kind={perf === "share" ? "line" : "bar"}
          formatAxis={perf === "share" ? priceAxis : pctAxis}
          onHover={setHover}
          ariaLabel={perf === "share" ? "Share price line chart" : "Daily funding rate bar chart"}
        />
      </BasisCard>

      <BasisCard
        title="Monthly returns"
        sub={<span className="tabular-nums">Since launch {fmtSignedPct(m.since)} {fees} · from {seriesLabel(0)}</span>}
        right={
          <div className={`flex gap-x-3 gap-y-2 items-center flex-wrap text-[11px] font-semibold tracking-wide ${c.label}`}>
            FEES <Segmented size="sm" value={fees} options={[["gross", "Gross"], ["net", "Net"]]} onChange={setFees} />
            BASIS <Segmented size="sm" value={basis} options={[["roi", "ROI"], ["apy", "APY"]]} onChange={setBasis} />
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[12px] tabular-nums">
            <thead>
              <tr>
                <th className={`font-medium py-1.5 px-1 text-left ${c.label}`}>Year</th>
                {MONTHS.map((mo) => (
                  <th key={mo} className={`font-medium py-1.5 px-1 text-right ${c.label}`}>{mo}</th>
                ))}
                <th className={`font-medium py-1.5 px-1 text-right ${c.label}`}>YTD</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(m.rows).map((ys) => {
                const y = Number(ys);
                return (
                  <tr key={y}>
                    <td className={`py-2 px-1 border-t font-bold ${c.line} ${c.text}`}>{y}</td>
                    {MONTHS.map((_, i) => {
                      const cell = m.rows[y][i];
                      return cell ? (
                        <td key={i} className={`py-2 px-1 border-t text-right font-medium ${c.line} ${sign(cell.value)}`}>
                          {fmtSignedPct(cell.value)}
                          {cell.mtd && <sup className={`text-[9px] ml-0.5 ${c.label}`}>MTD</sup>}
                        </td>
                      ) : (
                        <td key={i} className={`py-2 px-1 border-t text-right ${c.line} ${c.quiet}`}>–</td>
                      );
                    })}
                    <td className={`py-2 px-1 border-t text-right font-bold ${c.line} ${sign(m.ytd[y])}`}>{fmtSignedPct(m.ytd[y])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </BasisCard>

      <BasisCard title="Where the capital sits" sub={<span className="tabular-nums">{fmtUsdCompact(v.tvl)} across 2 venues</span>}>
        <div className="flex h-2.5 rounded-full overflow-hidden gap-0.5 mb-3">
          {alloc.map(([name, , amount, color]) => (
            <i key={name} className="block h-full" style={{ width: `${(amount / v.tvl) * 100}%`, background: color }} />
          ))}
        </div>
        {alloc.map(([name, sub, amount, color], i) => (
          <div key={name} className={`grid grid-cols-[12px_minmax(0,1fr)_auto_auto] gap-2.5 items-center text-[13px] py-[7px] tabular-nums ${i ? `border-t ${c.line}` : ""}`}>
            <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: color }} />
            <span className={c.text}>
              <b className="font-semibold">{name}</b>
              <small className={`block text-[11px] ${c.label}`}>{sub}</small>
            </span>
            <span className={c.text}>{fmtUsdCompact(amount)}</span>
            <span className={`text-[12px] min-w-[46px] text-right ${c.label}`}>{fmtPct((amount / v.tvl) * 100)}</span>
          </div>
        ))}
      </BasisCard>
    </>
  );
}

// ── All Transactions ───────────────────────────────────────────────────────

export function BasisTransactions({ vault: v }: { vault: BasisVault }) {
  const c = useBasisColors();
  const [tab, setTab] = useState<"current" | "vault">("current");
  const N = SERIES_DAYS;
  const dp = v.price > 1e4 ? 4 : 2;
  // Vault-wide activity (sample): daily funding settlements and a keeper rebalance.
  const activity: string[][] = [
    [seriesLabel(N - 1), "Funding settled", `+${fmtUsdCompact((v.tvl * v.apy7) / 36500)}`, "Vault"],
    [seriesLabel(N - 2), "Rebalance", `Short +${fmtNum(504 / v.price, dp)} ${v.asset}`, "Keeper"],
    [seriesLabel(N - 2), "Funding settled", `+${fmtUsdCompact((v.tvl * v.apy[N - 2]) / 36500)}`, "Vault"],
    [seriesLabel(N - 3), "Funding settled", `+${fmtUsdCompact((v.tvl * v.apy[N - 3]) / 36500)}`, "Vault"],
  ];
  const empty = <div className={`py-10 text-center text-[14px] font-medium ${c.label}`}>No position in this vault yet</div>;

  return (
    <>
      <BasisCard>
        <div className={`text-[13px] font-medium ${c.label}`}>My Vault Position</div>
        <div className={`text-[22px] font-bold leading-tight ${c.text}`}>—</div>
        {empty}
      </BasisCard>
      <BasisCard title="All Transactions" right={<Segmented size="sm" value={tab} options={[["current", "Current Position"], ["vault", "Vault Activity"]]} onChange={setTab} />}>
        {tab === "current" ? (
          empty
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-[12px] tabular-nums">
              <thead>
                <tr>
                  {["Date", "Action", "Amount", "By"].map((h) => (
                    <th key={h} className={`text-left font-medium py-1.5 px-2 border-b ${c.line} ${c.label}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activity.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className={`py-2 px-2 ${i < activity.length - 1 ? `border-b ${c.line}` : ""} ${j === 0 ? c.label : c.text}`}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </BasisCard>
    </>
  );
}
