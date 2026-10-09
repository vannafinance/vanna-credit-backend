"use client";

/**
 * Right column of the V3 Margin screen: Margin Account Info, the Liquidation card (health factor +
 * meter, room before liquidation, a liquidation price per exposed volatile asset) and the
 * "Oracles and LTs" collapsible (each token's real oracle source, price and freshness).
 *
 * Account numbers come from the program-exact model (`useV3Account`); prices / freshness from
 * GET /api/prices (each asset's on-chain OracleConfig: Kamino Scope first, Pyth fallback).
 */
import { useState } from "react";
import toast from "react-hot-toast";
import { Icon, IC, VMark } from "@/components/v3/icons";
import { hfFmt, hfLabel, nf, pct, price as pxFmt, roomSub, roomText, roomZone, usd } from "@/components/v3/format";
import { LIQ_HF, hfPos, hfZone } from "@/lib/account-model";
import { usePriceEntries, type PriceEntry } from "@/hooks/use-token-prices";
import { TOKENS } from "@/lib/solana/tokens";
import { ORACLE_PROGRAM_ID, VANNA_PROGRAM_ID, explorerUrl } from "@/lib/solana/config";
import { exposedVolatile, liqBuffer, noDebt } from "./mg-sim";
import { LblTip, MI, TIPS } from "./mg-ui";
import type { MarginScreen } from "./use-margin-screen";

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-6)}`;

function Addr({ value }: { value: string }) {
  return (
    <span className="mg-addr">
      <span>{short(value)}</span>
      <button
        type="button"
        aria-label="Copy address"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => toast.success("Address copied"));
        }}
      >
        {MI.copy}
      </button>
      <a href={explorerUrl("address", value)} target="_blank" rel="noopener noreferrer" aria-label="Open in explorer">
        {IC.ext}
      </a>
    </span>
  );
}

const SOURCE: Record<string, string> = { scope: "Kamino Scope", pyth: "Pyth" };
const ageFmt = (s: number | null) => (s === null ? "N/A" : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${nf(s / 3600, 1)}h`);

export function RightColumn({ m }: { m: MarginScreen }) {
  const [orc, setOrc] = useState(false);
  const { data: entries } = usePriceEntries();
  const n = m.now;
  const nd = noDebt(n);
  const on = m.connected && m.hasAccount;
  const empty = !(n.holdings > 0.01) && nd;

  const rows: [string, React.ReactNode, string][] = on
    ? [
        ["Total Borrowed value", usd(n.debt), TIPS.borrowed],
        ["Net Available Collateral", usd(n.equity), TIPS.equity],
        ["Total Value", usd(n.holdings), TIPS.value],
        ["Net Health Factor", <span key="hf" className={nd ? "z-ok" : hfZone(n.hf)}>{hfFmt(n.hf)}</span>, TIPS.hf],
        ["Net Borrow Rate", pct(m.borrowRate * 100), TIPS.rate],
      ]
    : [
        ["Total Borrowed value", "$0.00", TIPS.borrowed],
        ["Net Available Collateral", "$0.00", TIPS.equity],
        ["Total Value", "$0.00", TIPS.value],
        ["Net Health Factor", "No debt", TIPS.hf],
        ["Net Borrow Rate", "0.00%", TIPS.rate],
      ];

  return (
    <>
      <header className="mg-rh">
        <span className="mg-rh-ic">
          <VMark size={22} />
        </span>
        <div>
          <h2>Margin Account Info</h2>
          <p>Stay updated details and status.</p>
        </div>
      </header>
      <article className="mg-ic">
        {rows.map(([k, v, t]) => (
          <div key={k} className="mg-ir">
            <span>
              <LblTip k={k} tip={t} />
            </span>
            <span className="num">{v}</span>
          </div>
        ))}
      </article>
      {on && !empty && <LiquidationCard m={m} />}
      <article className="mg-ic">
        <button type="button" className="mg-exh" aria-expanded={orc} onClick={() => setOrc((v) => !v)}>
          Oracles and LTs{MI.chev13}
        </button>
        {orc && (
          <div className="mg-exb">
            <div className="mg-ir">
              <span>Oracle (Vanna price agent)</span>
              <span>
                <Addr value={ORACLE_PROGRAM_ID.toBase58()} />
              </span>
            </div>
            <div className="mg-ir">
              <span>
                <LblTip
                  k="Liquidation Threshold"
                  tip="The account can be liquidated when its health factor is at or below 1.10. The health factor is unweighted: every asset counts at its full oracle value (no per-asset collateral weights)."
                />
              </span>
              <span className="num">{nf(LIQ_HF, 2)}x</span>
            </div>
            <div className="mg-ir">
              <span>Vanna Program</span>
              <span>
                <Addr value={VANNA_PROGRAM_ID.toBase58()} />
              </span>
            </div>
            {TOKENS.map((t) => {
              const e = entries?.[t.symbol] as (PriceEntry & { source?: string | null }) | undefined;
              return (
                <div key={t.symbol} className="mg-ir">
                  <span>
                    <Icon sym={t.symbol} />
                    {t.symbol}
                    <span className="mini">{e?.source ? (SOURCE[e.source] ?? e.source) : "N/A"}</span>
                  </span>
                  <span className="num">
                    {e?.usd ? `$${pxFmt(e.usd)}` : usd(0)}
                    <span className={`mini ${e ? (e.stale ? "" : "ok") : ""}`} title={e?.stale ? "Older than the asset's max price age" : "Within the asset's max price age"}>
                      {e ? `${e.stale ? "stale" : "fresh"} · ${ageFmt(e.ageSecs)}` : "N/A"}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </article>
    </>
  );
}

/** HF + meter, room before liquidation, and the liquidation price of each exposed volatile asset. */
function LiquidationCard({ m }: { m: MarginScreen }) {
  const n = m.now;
  const r = m.acct.room;
  const nd = !r || r.state === "nodebt";
  const room = r && (
    <div className="mg-ir mg-lqr">
      <span>
        <LblTip k="Room before liquidation" tip={TIPS.room} />
      </span>
      <span className="mg-lqv">
        <b className={`num ${roomZone(r)}`}>{roomText(r)}</b>
        <small>{roomSub(r)}</small>
      </span>
    </div>
  );
  const head = (
    <div className="mg-lq-h">
      <h3>
        <LblTip k="Liquidation" tip={TIPS.hf} />
      </h3>
      {nd ? <span className="mg-zp z-ok">No debt</span> : <span className={`mg-zp ${hfZone(n.hf)}`}>{hfLabel(n.hf)}</span>}
    </div>
  );
  if (nd) {
    return (
      <article className="mg-ic mg-lq">
        {head}
        {room}
      </article>
    );
  }
  const tick = hfPos(LIQ_HF);
  // One row per exposed volatile asset (account-level price, every other price held); none when liquidatable now.
  const lp = r.state === "now" ? [] : exposedVolatile(m.model).map((s) => ({ s, p: m.acct.liqPriceOf(s), now: m.acct.priceOf(s) }));
  return (
    <article className="mg-ic mg-lq">
      {head}
      <div className="mg-lq-hf">
        <b className={`num ${hfZone(n.hf)}`}>{hfFmt(n.hf)}</b>
        <span>
          Liquidation at {nf(LIQ_HF, 2)} · buffer {usd(liqBuffer(n))}
        </span>
      </div>
      <div className="mg-lq-bar">
        <div className="hfbar">
          <i style={{ left: `${hfPos(n.hf)}%` }} />
        </div>
        <div className="mg-lq-tk">
          <i style={{ left: `${tick}%` }} />
          <span className="c" style={{ left: `${tick}%` }}>
            {nf(LIQ_HF, 2)}
          </span>
          <span style={{ right: 0 }}>2.50+</span>
        </div>
      </div>
      {room}
      {lp.map((x) => (
        <div key={x.s} className="mg-ir mg-lqr">
          <span>
            <Icon sym={x.s} />
            <span>
              <LblTip k={`${x.s} liquidation price`} tip={`${x.s} price at which the account reaches health factor 1.10, every other price held. None = no ${x.s} move liquidates it on its own.`} />
            </span>
          </span>
          <span className="mg-lqp num">
            {x.p !== null ? `$${pxFmt(x.p)}` : "None"}
            {x.now > 0 && <small>now ${pxFmt(x.now)}</small>}
          </span>
        </div>
      ))}
    </article>
  );
}
