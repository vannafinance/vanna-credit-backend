"use client";

/**
 * Positions section of the V3 Margin screen: Current Positions (the whole cross-collateral account
 * as one row — collateral deposited, borrowed funds still idle in the vault, borrowed assets with
 * their share, account leverage, health factor, interest accrued, Repay) and Positions History
 * (decoded on-chain margin events, lib/solana/history.ts). Header chips link to the Spot / Perps /
 * Farm pages with the account's live counts, plus Flash repay.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { Info } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { hfFmt, levFmt, timeFmt, tokFmt, usd } from "@/components/v3/format";
import { FlashRepayButton } from "@/components/v3/flash-repay";
import { hfZone, isStable } from "@/lib/account-model";
import { findToken } from "@/lib/solana/tokens";
import { explorerUrl } from "@/lib/solana/config";
import { accruedInterestBySymbol } from "@/lib/margin/amounts";
import { useMarginHistory } from "@/hooks/use-margin";
import { useFarmPositions } from "@/lib/farm/use-farm";
import { LblTip, MI, TIPS } from "./mg-ui";
import { noDebt } from "./mg-sim";
import type { MarginScreen } from "./use-margin-screen";

const DUST_USD = 0.01;
const DUST = 1e-6;
const PER_PAGE = 5;
const usdL = (v: number) => (!(v > 0) ? "$0.00" : v < 0.01 ? "<$0.01" : usd(v));
const isReceipt = (s: string) => /^k[A-Z]/.test(s);

/** History event → badge class / label. */
const BADGE: Record<string, [string, string]> = {
  create: ["create", "Account created"],
  deposit: ["deposit", "Deposit"],
  withdraw: ["withdraw", "Withdraw"],
  borrow: ["borrow", "Borrow"],
  repay: ["repay", "Repay"],
  liquidation: ["liquidation", "Liquidated"],
};

interface Asset {
  sym: string;
  amt: number;
  usd: number;
  tag?: string;
}

export function Positions({ m, flashable, onRepay, onOpen }: { m: MarginScreen; flashable: boolean; onRepay: (sym: string) => void; onOpen: () => void }) {
  const [tab, setTab] = useState<"cur" | "hist">("cur");
  const [page, setPage] = useState(1);
  const { rows: hist } = useMarginHistory();
  const { positions: farm } = useFarmPositions(m.address);
  const n = m.now;
  const nd = noDebt(n);

  const data = useMemo(() => {
    const snap = m.snap;
    const debts = (snap?.debts ?? []).filter((d) => d.debt > DUST).sort((a, b) => b.usd - a.usd);
    const debtOf = new Map(debts.map((d) => [d.symbol, d]));
    const coll: Asset[] = [];
    const idle: Asset[] = [];
    for (const c of snap?.collateral ?? []) {
      // The Phoenix venue holds no tokens: it is valued by the oracle (collateral + position equity).
      if (!findToken(c.symbol) && !isReceipt(c.symbol)) {
        if (c.usd > DUST_USD) coll.push({ sym: "PHX", amt: 0, usd: c.usd, tag: "perps" });
        continue;
      }
      if (!(c.amount > DUST)) continue;
      const px = c.amount > 0 ? c.usd / c.amount : 0;
      // Borrowed tokens still sitting in the vault are "idle"; the rest was deposited / bought.
      const idleAmt = Math.min(c.amount, debtOf.get(c.symbol)?.debt ?? 0);
      const dep = c.amount - idleAmt;
      if (dep * px > DUST_USD) coll.push({ sym: c.symbol, amt: dep, usd: dep * px });
      if (idleAmt * px > DUST_USD) idle.push({ sym: c.symbol, amt: idleAmt, usd: idleAmt * px, tag: "idle" });
    }
    coll.sort((a, b) => b.usd - a.usd);
    const totalDebt = debts.reduce((t, d) => t + d.usd, 0);
    const accrued = accruedInterestBySymbol(hist, Object.fromEntries(debts.map((d) => [d.symbol, d.debt])));
    const interestUsd = debts.reduce((t, d) => t + (accrued[d.symbol] ?? 0) * (d.debt > 0 ? d.usd / d.debt : 0), 0);
    const spot = (snap?.collateral ?? []).filter((c) => findToken(c.symbol) && !isReceipt(c.symbol) && !isStable(c.symbol) && c.usd > DUST_USD).length;
    return { debts, coll, idle, totalDebt, accrued, interestUsd, spot };
  }, [m.snap, hist]);

  const history = useMemo(() => hist.filter((r) => r.type in BADGE), [hist]);
  const pages = Math.max(1, Math.ceil(history.length / PER_PAGE));
  const pg = Math.min(page, pages);
  const has = data.coll.length > 0 || data.debts.length > 0 || data.idle.length > 0;
  const perps = m.acct.view?.positions.length ?? 0;
  const mods: [string, string, number][] = (
    [
      ["/trade/spot", "Spot", data.spot],
      ["/trade/perps", "Perps", perps],
      ["/farm", "Farm", farm.length],
    ] as [string, string, number][]
  ).filter((x) => x[2] > 0);

  const asset = (a: Asset) => (
    <div key={`${a.sym}${a.tag ?? ""}`} className="mg-as">
      <Icon sym={a.sym} />
      <div>
        <div className="mg-an num">
          {a.sym === "PHX" ? "Phoenix perps" : tokFmt(a.amt, a.sym)}
          {a.tag && <span className="mg-tag">{a.tag}</span>}
        </div>
        <div className="mg-au num">{usdL(a.usd)}</div>
      </div>
    </div>
  );
  const debtTip = (sym: string, amt: number, px: number) => {
    const i = data.accrued[sym];
    return i === null || i === undefined
      ? `You owe ${tokFmt(amt, sym)}. The interest split is unavailable: the transaction that opened this loan is outside the scanned on-chain history.`
      : `You owe ${tokFmt(amt, sym)}, including about ${tokFmt(i, sym)} (${usdL(i * px)}) of interest accrued so far.`;
  };
  const debtCell = (inline: boolean) =>
    data.debts.length ? (
      data.debts.map((d) => {
        const sh = data.totalDebt > 0 ? Math.round((d.usd / data.totalDebt) * 100) : 0;
        const chip = sh > 0 ? <span className="mg-shp num">{sh}%</span> : null;
        return (
          <div key={d.symbol} className="mg-as">
            <Icon sym={d.symbol} />
            <div>
              <div className="mg-an num">
                {tokFmt(d.debt, d.symbol)} <Info text={debtTip(d.symbol, d.debt, d.debt > 0 ? d.usd / d.debt : 0)} />
              </div>
              <div className="mg-au num">
                {usdL(d.usd)}
                {inline && chip}
              </div>
            </div>
            {!inline && chip}
          </div>
        );
      })
    ) : (
      <span className="mg-mut">$0</span>
    );
  const collCell = data.coll.length || data.idle.length ? [...data.coll, ...data.idle].map(asset) : <span className="mg-mut">$0</span>;
  const hfCell = <span className={nd ? "z-ok" : hfZone(n.hf)}>{hfFmt(n.hf)}</span>;
  const intr = data.debts.length ? usd(data.interestUsd) : "$0.00";

  const cur = (
    <>
      <div className="mg-tbl">
        <div className="mg-thr" role="row">
          <span>Collateral Deposited</span>
          <span>
            <LblTip k="Borrowed Assets" tip={TIPS.borrowed} />
          </span>
          <span>
            <LblTip k="Leverage Taken" tip={TIPS.lev} />
          </span>
          <span>
            <LblTip k="Health Factor" tip={TIPS.hf} />
          </span>
          <span>
            <LblTip k="Interest accrued till date" tip={TIPS.interest} />
          </span>
          <span>Action</span>
        </div>
        <div className="mg-tb">
          <div className="mg-tr2">
            <div className="mg-td">{collCell}</div>
            <div className="mg-td">{debtCell(false)}</div>
            <div className="mg-td big num">{levFmt(n.leverage)}</div>
            <div className="mg-td big num">{hfCell}</div>
            <div className="mg-td num">{intr}</div>
            <div className="mg-td">
              {data.debts.length ? (
                data.debts.map((d) => (
                  <button key={d.symbol} type="button" className="mg-rp" onClick={() => onRepay(d.symbol)}>
                    Repay{data.debts.length > 1 ? ` ${d.symbol}` : ""}
                  </button>
                ))
              ) : (
                <button type="button" className="mg-rp" disabled>
                  Repay
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="mg-mob">
        <div className="mg-mc">
          <div className="mg-g2">
            <div>
              <p className="mg-ml">Collateral Deposited</p>
              <div className="mg-col">{collCell}</div>
            </div>
            <div>
              <p className="mg-ml">Borrowed Assets</p>
              <div className="mg-col">{debtCell(true)}</div>
            </div>
          </div>
          <div className="mg-mst">
            <div>
              <p>Leverage</p>
              <p className="num">{levFmt(n.leverage)}</p>
            </div>
            <div>
              <p>Health Factor</p>
              <p className="num">{hfCell}</p>
            </div>
            <div>
              <p>Interest Accrued</p>
              <p className="num">{intr}</p>
            </div>
          </div>
          <div className="mg-mra">
            {data.debts.length ? (
              data.debts.map((d) => (
                <button key={d.symbol} type="button" className="mg-rp" onClick={() => onRepay(d.symbol)}>
                  Repay {d.symbol}
                </button>
              ))
            ) : (
              <button type="button" className="mg-rp" disabled>
                Repay
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );

  const rows = history.slice((pg - 1) * PER_PAGE, pg * PER_PAGE);
  const badge = (t: string) => <span className={`mg-badge2 ${BADGE[t]?.[0] ?? "deposit"}`}>{BADGE[t]?.[1] ?? t}</span>;
  const tx = (sig: string) => (
    <a className="mg-tx-l" href={explorerUrl("tx", sig)} target="_blank" rel="noopener noreferrer">
      {sig.slice(0, 4)}…{sig.slice(-4)}
    </a>
  );
  const amountOf = (r: (typeof history)[number]) => (r.type === "create" ? null : Number(r.amount) || 0);
  const pager =
    pages > 1 ? (
      <div className="mg-pg">
        <button type="button" disabled={pg === 1} aria-label="Previous page" onClick={() => setPage(pg - 1)}>
          {MI.prev}
        </button>
        <span className="num">
          {pg} of {pages}
        </span>
        <button type="button" disabled={pg === pages} aria-label="Next page" onClick={() => setPage(pg + 1)}>
          {MI.next}
        </button>
      </div>
    ) : null;
  const histView = (
    <>
      <div className="mg-tbl">
        <div className="mg-thr" role="row">
          {["Date", "Type", "Asset", "Amount", "Tx Hash"].map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
        <div className="mg-tb">
          {rows.map((r) => {
            const a = amountOf(r);
            return (
              <div key={`${r.signature}${r.type}${r.symbol}`} className="mg-tr2">
                <div className="mg-td mg-dt num">{timeFmt(r.timestamp)}</div>
                <div className="mg-td">{badge(r.type)}</div>
                <div className="mg-td">
                  {a !== null ? (
                    <div className="mg-as">
                      <Icon sym={r.symbol} />
                      <span className="mg-an">{r.symbol}</span>
                    </div>
                  ) : (
                    "N/A"
                  )}
                </div>
                <div className="mg-td num">{a !== null ? tokFmt(a, r.symbol, false) : "0"}</div>
                <div className="mg-td">{tx(r.signature)}</div>
              </div>
            );
          })}
        </div>
        {pager}
      </div>
      <div className="mg-mob">
        {rows.map((r) => {
          const a = amountOf(r);
          return (
            <div key={`${r.signature}${r.type}${r.symbol}`} className="mg-mh">
              <Icon sym={a !== null ? r.symbol : "Vanna"} />
              <div className="mg-mt">
                <div>
                  {badge(r.type)}
                  <span className="num">{a !== null ? tokFmt(a, r.symbol) : ""}</span>
                </div>
                <small className="num">{timeFmt(r.timestamp)}</small>
              </div>
              {tx(r.signature)}
            </div>
          );
        })}
        {pager}
      </div>
    </>
  );

  return (
    <section className="mg-pos" id="mg-pos">
      <div className="mg-ph">
        <div className="mg-pt">
          <h2>Positions</h2>
          {has && <span className="mg-cnt num">1</span>}
        </div>
        <div className="mg-pa">
          {mods.map(([href, l, c]) => (
            <Link key={l} href={href} className="mg-oc" aria-label={`Open ${l}`}>
              {l} <b className="num">{c}</b>
            </Link>
          ))}
          <FlashRepayButton className="mg-fbtn" disabled={!flashable} />
        </div>
      </div>
      <nav className="mg-ptabs" role="tablist">
        {(
          [
            ["cur", "Current Positions", "Current"],
            ["hist", "Positions History", "History"],
          ] as const
        ).map(([k, l, s]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            <span className="mg-s">{s}</span>
            <span className="mg-l">{l}</span>
          </button>
        ))}
      </nav>
      {tab === "hist" ? (
        history.length ? (
          histView
        ) : (
          <section className="mg-empty">
            <p>No transaction history</p>
          </section>
        )
      ) : has ? (
        cur
      ) : (
        <section className="mg-empty">
          <button type="button" className="mg-ghost" onClick={onOpen}>
            Open Position
          </button>
        </section>
      )}
    </section>
  );
}
