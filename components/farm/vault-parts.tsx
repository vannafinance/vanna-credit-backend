"use client";

/**
 * Pieces shared by the V3 Basis and Perena vault pages: the design's `.fm-card` wrapper, the range
 * chips and slicing, the stat-strip cell, the share-price chart card and the All Transactions tab
 * (this wallet's real vault history; there is no vault-wide event feed, so "Vault Activity" is an
 * honest empty state). Styled by ./farm-v3.css.
 */
import { useState, type ReactNode } from "react";
import { Info, Seg } from "@/components/v3/ui";
import { nf, sUsd, usd } from "@/components/v3/format";
import { explorerUrl } from "@/lib/solana/config";
import type { VaultDefinition } from "@/lib/solana/vault-catalogue";
import type { LiveVault } from "@/lib/solana/vault-state";
import type { VaultPosition } from "@/lib/farm/basis-live";
import { DAY, type DayPoint } from "@/lib/farm/nav-math";
import { Chips } from "./fm-ui";
import { BasisChart, dayLabel } from "./basis/basis-chart";

/** Range chips used above every vault chart; 0 = everything recorded. */
export const RANGES: [number, string][] = [
  [7, "1 Week"],
  [30, "1 Month"],
  [90, "3 Months"],
  [0, "All Time"],
];

/** The points of `series` inside the last `days` (0 = all). */
export function inRange(series: DayPoint[], days: number): DayPoint[] {
  if (!days || !series.length) return series;
  const from = series[series.length - 1].at - days * DAY;
  return series.filter((p) => p.at > from);
}

/** Share price axis: ~4 significant digits. */
export const priceAxis = (t: number, step: number) => nf(t, Math.max(2, -Math.floor(Math.log10(step))));

/** The design's `.fm-card` with its header row. */
export function Card({ title, sub, right, children }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode }) {
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

/** One stats-strip cell. */
export function Stat({ label, value, tip, cls = "", sub }: { label: string; value: ReactNode; tip?: string; cls?: string; /** Small chips under the value (e.g. a funding APR beside a vault APY). */ sub?: ReactNode[] }) {
  return (
    <article>
      <div className="lbl">
        {label}
        {tip && <Info text={tip} />}
      </div>
      <div className={`fm-sv ${cls}`}>{value}</div>
      {sub && sub.length > 0 && (
        <span className="fm-cs">
          {sub.map((m, k) => (
            <span key={k} className="fm-mini">
              {m}
            </span>
          ))}
        </span>
      )}
    </article>
  );
}

/** Daily share price (last recorded observation of each UTC day). */
export function SharePriceCard({ days, receipt, title = "Share price" }: { days: DayPoint[]; receipt: string; title?: string }) {
  const [range, setRange] = useState(30);
  const [hover, setHover] = useState<number | null>(null);
  const s = inRange(days, range);
  const readout =
    hover !== null && s[hover] ? (
      <>
        {dayLabel(s[hover].at)} · <b>{nf(s[hover].value, 6)}</b> USD per {receipt}
      </>
    ) : (
      `USD per ${receipt}, daily, from recorded vault reads`
    );
  return (
    <Card title={title} sub={<p className="fm-ro num">{readout}</p>} right={<Chips value={range} options={RANGES} onChange={setRange} />}>
      <BasisChart
        data={s.map((p) => p.value)}
        dates={s.map((p) => p.at)}
        formatAxis={priceAxis}
        onHover={setHover}
        empty="Share-price history starts recording when the vault is read; the chart appears after two days"
        ariaLabel="Share price line chart"
      />
    </Card>
  );
}

const dateFmt = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const timeFmt = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

/** All Transactions tab: this wallet's position and its deposits / withdrawals in the vault. */
export function VaultTransactions({ def, state, position }: { def: VaultDefinition; state: LiveVault | null; position: VaultPosition & { connected: boolean } }) {
  const [tab, setTab] = useState<"current" | "vault">("current");
  const price = state?.sharePriceUsd ?? 0;
  return (
    <>
      <section className="fm-card">
        <div className="fm-pvh">
          <div>
            <div className="lbl">My Vault Position</div>
            <div className="fm-big num">{usd(position.valueUsd)}</div>
          </div>
          <div className="fm-pvr num">
            <span>
              {nf(position.shares, 6)} {def.symbol}
            </span>
            <span className={(position.earnedUsd ?? 0) > 0 ? "pos" : (position.earnedUsd ?? 0) < 0 ? "neg" : ""}>
              {sUsd(position.earnedUsd ?? 0)} earned
            </span>
          </div>
        </div>
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
        {tab === "vault" ? (
          <div className="fm-nopos">Vault-wide activity isn&apos;t indexed yet. Your own deposits and withdrawals are under Current Position.</div>
        ) : position.rows.length ? (
          <div className="fm-mtw">
            <table className="fm-txt num">
              <thead>
                <tr>
                  {["Date", "Action", "USDC", "Shares", "Value now", "Tx"].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {position.rows.map((r, i) => (
                  <tr key={`${r.signature}-${i}`}>
                    <td>
                      {dateFmt(r.timestamp)} <small>{timeFmt(r.timestamp)}</small>
                    </td>
                    <td>{r.type === "farm-deposit" ? "Deposit" : "Withdraw"}</td>
                    <td>{nf(Number(r.amount), 2)}</td>
                    <td>{nf(Number(r.receiptAmount ?? 0), 6)}</td>
                    <td>{usd(Number(r.receiptAmount ?? 0) * price)}</td>
                    <td>
                      <a className="fm-link" href={explorerUrl("tx", r.signature)} target="_blank" rel="noreferrer">
                        {r.signature.slice(0, 6)}…{r.signature.slice(-4)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="fm-nopos">{position.connected ? "No transactions in this vault yet" : "Connect your wallet to see your vault transactions"}</div>
        )}
      </section>
    </>
  );
}
