"use client";

/**
 * Portfolio → Lender → Predict (BETA): UI ONLY. Every figure comes from the shared Predict sample
 * module (`lib/predict-sample.ts`, the design's PredictAPI; in-memory session store) — never from
 * the chain, never counted in the header cards — and the tab says so. No transactions: "Earn on
 * them" / "Review" open the Predict import sheet (sample), rows link to the sample event pages.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Info } from "@/components/v3/ui";
import { Icon, IC } from "@/components/v3/icons";
import { nf, pct, sUsd, usd } from "@/components/v3/format";
import { usePredictSample, EMPTY_PREDICT_SUMMARY } from "@/lib/predict-sample";
import { ImportSheet } from "@/components/predict/import-sheet";
import { ChartCard, Ct, Grid, HistNav, InfoCard, Tag, sign } from "./pf-ui";

const TP = {
  pVal: "Value of your Yes/No shares at today's price; each pays $1 if its side wins and $0 if it loses.",
  pVault: "The matched part of your shares, merged into USDC and lent in the USDC Earn pool, at today's share price.",
  pYield: "Yield your shares earn now in the USDC Earn pool, paid as extra shares of your side (worth $0 if it loses).",
  pEarned: "Passive yield earned so far, paid in shares of your side at today's price (worth $0 if it loses).",
  pPays: "Maximum payout if your picks win: $1 per share, yield shares included.",
};

/** Share price in cents, 1 decimal (as on Predict). */
const c1 = (v: number) => `${nf(v <= 1 ? v * 100 : v, 1)}¢`;

/** Illustrative 30-day "earned" curve for the sample (the design's `curve()`); sample data only. */
const curve = (end: number, seed = 5, n = 31) =>
  Array.from({ length: n }, (_, i) => {
    const f = i / (n - 1);
    const w = 1 + 0.12 * Math.sin(i * 1.7 + seed) * (1 - f) * (i < n - 1 ? 1 : 0);
    return Math.max(0, end * Math.pow(f, 1.12) * w);
  });

export function LenderPredict() {
  const router = useRouter();
  const [view, setView] = useState<"cur" | "hist">("cur");
  // `rev` changes after sample buys / sells / imports, so these re-read the store.
  const P = usePredictSample();
  const s = { ...EMPTY_PREDICT_SUMMARY, ...P.summary() };
  const pos = P.positions();
  const imp = P.importable();
  // Day labels for the sample curve, fixed at mount (a render-time clock would be impure).
  const [labels] = useState(() => {
    const now = Date.now();
    return Array.from({ length: 31 }, (_, i) => new Date(now - (30 - i) * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  });

  // As on Predict: wallet shares count only when listed on Vanna; Polymarket ones all show.
  const wallet = imp.filter((x) => x.source === "wallet" && x.listed !== false);
  const poly = imp.filter((x) => x.source === "polymarket");
  const sum = (xs: typeof imp) => xs.reduce((t, x) => t + (x.value || 0), 0);
  const best = (xs: typeof imp) => Math.max(0, ...xs.map((x) => x.apy || 0));
  const browse = () => router.push("/predict");

  return (
    <>
      <ImportSheet />
      <div className="pf-emptyc" style={{ padding: "12px 16px", flexDirection: "row", justifyContent: "flex-start", textAlign: "left" }}>
        <Tag cls="pf-t-warn">Preview</Tag>
        Predict is a preview: these are sample positions to show the layout, not yours, and they are not counted in your net worth.
      </div>
      {(wallet.length > 0 || poly.length > 0) && (
        <section className="pf-imps">
          {wallet.length > 0 && (
            <div className="pf-imp pf-hot">
              <span className="pf-imp-ic">
                <Icon sym="WORLD" className="ico pf-i20" />
              </span>
              <div className="pf-imp-t">
                <b className="num">
                  {wallet.length} position{wallet.length > 1 ? "s" : ""} in your wallet · {usd(sum(wallet))}
                </b>
                <span className="pf-imp-s num">
                  <span className="pf-src">
                    <Icon sym="WORLD" className="ico pf-i14" />
                    Wallet · World
                  </span>
                  not earning yet<span className="pf-imp-apy">Earn up to {pct(best(wallet), 1)}</span>
                </span>
              </div>
              <button type="button" className="pf-imp-b" onClick={() => P.openImport("wallet")}>
                Earn on them
              </button>
            </div>
          )}
          {poly.length > 0 && (
            <div className="pf-imp">
              <span className="pf-imp-ic">
                <Icon sym="POLY" className="ico pf-i20" />
              </span>
              <div className="pf-imp-t">
                <b className="num">
                  {poly.length} Polymarket position{poly.length > 1 ? "s" : ""} can move here · {usd(sum(poly))}
                </b>
                <span className="pf-imp-s num">
                  <span className="pf-src">
                    <Icon sym="POLY" className="ico pf-i14" />
                    Polymarket
                  </span>
                  on Polygon<span className="pf-imp-apy">Earn up to {pct(best(poly), 1)}</span>
                </span>
              </div>
              <button type="button" className="pf-btn" onClick={() => P.openImport("polymarket")}>
                Review
              </button>
            </div>
          )}
        </section>
      )}
      <div className="pf-row2">
        <InfoCard
          title="Predict Stats"
          rows={[
            ["Positions Value", usd(s.value), "", TP.pVal],
            ["In USDC vault", usd(s.inVault), "", TP.pVault],
            ["Passive yield", pct(s.apy), s.apy > 0 ? "pf-up" : "", TP.pYield],
            ["Earned", sUsd(s.earned), s.earned > 0.004 ? "pf-up" : "", TP.pEarned],
            ["Pays if right", usd(s.payout), "", TP.pPays],
            ["Open Positions", String(s.count || pos.length)],
          ]}
        />
        <ChartCard
          title="Earned"
          value={sUsd(s.earned)}
          sub={`${pct(s.apy)} passive yield`}
          series={[{ name: "Earned", color: "var(--pf-c-m)", pts: curve(s.earned) }]}
          labels={labels}
          h={198}
          min={0}
          empty="No sample positions yet"
        />
      </div>
      <section className="pf-tbl">
        <header className="pf-tblh">
          <h2>Positions Table</h2>
          <div className="pf-tools">
            <button type="button" className="pf-lnk" onClick={browse}>
              Browse markets
            </button>
          </div>
        </header>
        <div className="pf-tbar">
          <HistNav value={view} onChange={setView} />
        </div>
        {view === "hist" ? (
          <Grid cols="1fr" heads={[]} rows={[]} empty="Preview: no transactions (Predict is not live yet)" />
        ) : (
          <Grid
            cols="2.3fr .8fr 1fr 1fr 1fr .85fr .85fr 1fr"
            heads={[
              "Market",
              "Outcome",
              "Shares",
              "Value",
              <>
                In USDC vault
                <Info text={TP.pVault} />
              </>,
              "Earned",
              "Passive yield",
              "Pays if right",
            ]}
            empty="No positions yet."
            rows={pos.map((x) => ({
              key: x.id,
              onClick: () => router.push(P.href(x.eventId, x.marketId || undefined)),
              cells: [
                <Ct
                  key="m"
                  desc={x.event && x.market && x.event !== x.market ? x.event : ""}
                  tags={x.queued && x.queued > 0 ? <Tag cls="pf-t-warn">Sell queued {nf(x.queued, 2)}</Tag> : undefined}
                >
                  {x.market || x.event}
                </Ct>,
                <Tag key="o" cls={x.side === "yes" ? "pf-t-yes" : "pf-t-no"}>
                  {x.label || (x.side === "yes" ? "Yes" : "No")}
                </Tag>,
                <Ct key="s" desc={<span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{c1(x.avg)} {IC.arrow} {c1(x.mark)}</span>}>
                  {nf(x.shares, 2)}
                </Ct>,
                <Ct key="v" desc={<span className={sign(x.pnl)}>{sUsd(x.pnl)}</span>}>
                  {usd(x.value)}
                </Ct>,
                <Ct key="iv">{usd(x.inVault)}</Ct>,
                <Ct key="e">
                  <span className={x.earned > 0.004 ? "pos" : ""}>{sUsd(x.earned)}</span>
                </Ct>,
                <Ct key="y">{pct(x.apy)}</Ct>,
                <Ct key="p">{usd(x.pays)}</Ct>,
              ],
            }))}
          />
        )}
      </section>
    </>
  );
}
