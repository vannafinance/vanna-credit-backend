"use client";

/**
 * Portfolio → Trader → Margin: the margin stats grid (2 × 4), the health-factor meter, the
 * (the liquidation price and room before liquidation were removed from that card), and the live
 * margin "Positions" table (Current position | Position history). Health maths from
 * `useV3Account()` (program-exact: HF = holdings ÷ debt, liquidatable at 1.10); token amounts from
 * the account snapshot; interest and history decoded from the margin's own events.
 * Repay hands off to the Margin page (`/margin?repay=<asset>`).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Info } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { hfFmt, levFmt, nf, pct, tokFmt, usd } from "@/components/v3/format";
import { LIQ_HF, hfPos, hfZone } from "@/lib/account-model";
import type { MarginHistoryRow } from "@/lib/solana/history";
import type { Portfolio } from "./use-portfolio";
import { HfBar, HistNav, TT, TxCell, when } from "./pf-ui";
import { VannaLoader } from "@/components/v3/vanna-loader";

const TYPE_LABEL: Record<string, string> = {
  create: "Account created",
  deposit: "Deposit",
  withdraw: "Withdraw",
  borrow: "Borrow",
  repay: "Repay",
  liquidation: "Liquidation",
  "open-debt": "Debt opened",
  "close-debt": "Debt closed",
  "close-collateral": "Vault closed",
  swap: "Swap",
  "farm-deposit": "Farm supply",
  "farm-withdraw": "Farm withdraw",
  "perp-open": "Perps funding",
  "perp-order": "Perps order",
  "perp-settle": "Perps settle",
};
const mBadge = (t: string) =>
  /borrow/.test(t) ? "pf-mb-red" : /repay/.test(t) ? "pf-mb-green" : /withdraw|settle/.test(t) ? "pf-mb-amber" : /liquid/.test(t) ? "pf-mb-rose" : /create/.test(t) ? "pf-mb-purple" : "pf-mb-blue";
const amountOf = (r: MarginHistoryRow) => {
  const a = Number(r.amount) || 0;
  if (r.type === "swap") return `${tokFmt(a, r.symbol)} → ${tokFmt(Number(r.toAmount) || 0, r.toSymbol ?? "")}`;
  return r.symbol ? tokFmt(a, r.symbol) : "0";
};

function Stat({ k, v, tip }: { k: string; v: React.ReactNode; tip: string }) {
  return (
    <div className="pf-ms-c">
      <div className="pf-ms-k">
        {k}
        <Info text={tip} />
      </div>
      <div className="pf-ms-v num">{v}</div>
    </div>
  );
}

export function TraderMargin({ p }: { p: Portfolio }) {
  const router = useRouter();
  const [view, setView] = useState<"cur" | "hist">("cur");
  const { acct, px, snapshot, totals: T } = p;
  const now = acct.now;
  const hf = now?.hf ?? Infinity;
  const live = Boolean(now) && Number.isFinite(hf) && hf < 100;
  const debt = now?.debt ?? 0;
  const holdings = now?.holdings ?? 0;
  const noDebt = !(debt > 0.005);
  // Unweighted HF: value the holdings can lose before holdings ÷ debt hits 1.10.
  const left = Math.max(0, holdings - LIQ_HF * debt);

  const pNow = live ? hfPos(hf) : null;
  const pLiq = hfPos(LIQ_HF);

  // Until the margin account has loaded (`now` null) every figure shows its zero form: holdings
  // and debt default to 0, leverage to 0.00x, and the health factor reads "No debt" (never 0).
  const cells: [string, React.ReactNode, string][] = [
    ["Total Margin Balance", usd(holdings), TT.value],
    ["Total Collateral Deposited", usd(T.netDeposited ?? 0), TT.coll],
    ["Total Loan Taken", usd(debt), TT.borrowed],
    ["Cross Account Leverage", levFmt(now?.leverage ?? 0), TT.lev],
    ["Health Factor", live ? <span className={hfZone(hf)}>{hfFmt(hf)}</span> : hfFmt(hf), TT.hf],
    ["Cross Margin Ratio", pct(holdings > 0 ? (debt / holdings) * 100 : 0, 1), TT.ratio],
    ["Collateral Left Before Liquidation", noDebt ? "No debt" : usd(left), TT.left],
    ["Net Borrowed Interest Accrued", usd(T.interest ?? 0), TT.interest],
  ];

  // Token amounts from the account snapshot (receipts and the venue line excluded from "collateral").
  const collBal = Object.entries(snapshot?.collateralBalances ?? {})
    .map(([sym, b]) => ({ sym, amt: parseFloat(b.amount) || 0, usd: parseFloat(b.usdValue) || 0 }))
    .filter((c) => c.amt > 0);
  const debts = Object.entries(T.debtTokens)
    .filter(([, v]) => v > 0)
    .map(([sym, amt]) => ({ sym, amt, usd: amt * (px[sym] ?? 0) }));
  const debtTot = debts.reduce((t, d) => t + d.usd, 0);
  const any = collBal.length > 0 || debts.length > 0 || (acct.view?.account.venueValueUsd ?? 0) > 0;
  const venue = acct.view?.account.venueValueUsd ?? 0;
  const repay = (sym?: string) => router.push(sym ? `/margin?repay=${encodeURIComponent(sym)}` : "/margin");

  const hist = p.margin.rows.filter((r) => r.type !== "open-debt" && r.type !== "close-debt" && r.type !== "close-collateral");
  const cols = "1.3fr 1.45fr .8fr .85fr 1fr .8fr";
  const hcols = "1fr .9fr .9fr 1.4fr 1fr";

  return (
    <>
      <section className="pf-ms">
        <div className="pf-ms-r">
          {cells.slice(0, 4).map(([k, v, t]) => (
            <Stat key={k} k={k} v={v} tip={t} />
          ))}
        </div>
        <div className="pf-ms-r">
          {cells.slice(4).map(([k, v, t]) => (
            <Stat key={k} k={k} v={v} tip={t} />
          ))}
        </div>
        <div className="pf-liq">
          <div className="pf-liq-m">
            <div className="pf-ms-k">
              Health factor
              <Info text={TT.hf} />
            </div>
            <div className="pf-meter">
              {pNow !== null && (
                <span className="pf-ml pf-ml-t num" style={{ left: `${pNow}%`, transform: `translateX(-${pNow}%)` }}>
                  Now {hfFmt(hf)}
                </span>
              )}
              <HfBar hf={live ? hf : null} />
              <span className="pf-ml pf-ml-b num" style={{ left: `${pLiq}%`, transform: `translateX(-${pLiq}%)` }}>
                Liquidation {nf(LIQ_HF, 2)}
              </span>
            </div>
          </div>
          {/* Collateral liquidation price and room before liquidation were removed from this card (product request); the health factor bar shows the account's distance to 1.10. */}
        </div>
      </section>

      <section className="pf-mp">
        <div className="pf-mh">
          <h2>Positions</h2>
          {any && view === "cur" && <span className="pf-cnt">1</span>}
        </div>
        <div className="pf-tbar">
          <HistNav value={view} onChange={setView} />
        </div>
        {view === "hist" ? (
          !hist.length ? (
            <div className="pf-mempty">{p.margin.isLoading ? <VannaLoader size="block" /> : "No transaction history"}</div>
          ) : (
            <div className="pf-mt">
              <div className="pf-mth" style={{ gridTemplateColumns: hcols }}>
                <span>Date</span>
                <span>Type</span>
                <span>Asset</span>
                <span>Amount</span>
                <span>Tx Hash</span>
              </div>
              {hist.map((r, i) => (
                <div key={`${r.signature}-${i}`} className="pf-mrow" style={{ gridTemplateColumns: hcols }}>
                  <span className="pf-mc pf-mdate" data-l="Date">
                    {when(r.timestamp)}
                  </span>
                  <span className="pf-mc" data-l="Type">
                    <span className={`pf-mb ${mBadge(r.type)}`}>{TYPE_LABEL[r.type] ?? r.type}</span>
                  </span>
                  <span className="pf-mc" data-l="Asset">
                    {r.symbol ? (
                      <>
                        <Icon sym={r.symbol} className="ico pf-i20" />
                        {r.symbol}
                      </>
                    ) : (
                      "None"
                    )}
                  </span>
                  <span className="pf-mc num" data-l="Amount">
                    {amountOf(r)}
                  </span>
                  <span className="pf-mc" data-l="Tx Hash">
                    <TxCell sig={r.signature} />
                  </span>
                </div>
              ))}
            </div>
          )
        ) : !any ? (
          <div className="pf-mempty">
            <button type="button" className="pf-ghost" onClick={() => router.push("/margin")}>
              Open Position
            </button>
          </div>
        ) : (
          <div className="pf-mt">
            <div className="pf-mth" style={{ gridTemplateColumns: cols }}>
              <span>Collateral Deposited</span>
              <span>Borrowed Assets</span>
              <span>Leverage Taken</span>
              <span>Health Factor</span>
              <span>Interest accrued till date</span>
              <span>Action</span>
            </div>
            <div className="pf-mrow" style={{ gridTemplateColumns: cols }}>
              <div className="pf-mc pf-stack" data-l="Collateral Deposited">
                {collBal.map((c) => (
                  <div className="pf-asset" key={c.sym}>
                    <Icon sym={c.sym} className="ico pf-i20" />
                    <div>
                      <b className="num">{tokFmt(c.amt, c.sym)}</b>
                      <small className="num">{usd(c.usd)}</small>
                    </div>
                  </div>
                ))}
                {venue > 0.005 && (
                  <div className="pf-asset">
                    <Icon sym="PHX" className="ico pf-i20" />
                    <div>
                      <b className="num">Phoenix account</b>
                      <small className="num">{usd(venue)}</small>
                    </div>
                  </div>
                )}
                {!collBal.length && venue <= 0.005 && <span className="pf-zero">{usd(0)}</span>}
              </div>
              <div className="pf-mc pf-stack" data-l="Borrowed Assets">
                {debts.length ? (
                  debts.map((d) => {
                    const share = debtTot > 0 ? Math.round((d.usd / debtTot) * 100) : 0;
                    return (
                      <div className="pf-asset" key={d.sym}>
                        <Icon sym={d.sym} className="ico pf-i20" />
                        <div>
                          <b className="num">
                            {tokFmt(d.amt, d.sym)}
                            <Info text={`You owe ${tokFmt(d.amt, d.sym)} in total, interest included.`} />
                          </b>
                          <small className="num">{usd(d.usd)}</small>
                        </div>
                        {share > 0 && debts.length > 1 && <span className="pf-share num">{share}%</span>}
                      </div>
                    );
                  })
                ) : (
                  <span className="pf-zero">{usd(0)}</span>
                )}
              </div>
              <div className="pf-mc pf-strong num" data-l="Leverage Taken">
                {levFmt(now?.leverage ?? 0)}
              </div>
              <div className="pf-mc pf-strong num" data-l="Health Factor">
                <span className={live ? hfZone(hf) : ""}>{hfFmt(hf)}</span>
              </div>
              <div className="pf-mc num" data-l="Interest accrued">
                {usd(T.interest ?? 0)}
              </div>
              <div className="pf-mc pf-stack" data-l="Action">
                {debts.length ? (
                  debts.map((d) => (
                    <button key={d.sym} type="button" className="pf-repay" aria-label={`Repay ${d.sym}`} onClick={() => repay(d.sym)}>
                      Repay <Icon sym={d.sym} className="ico pf-i14" />
                    </button>
                  ))
                ) : (
                  <button type="button" className="pf-repay" disabled>
                    Repay
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
