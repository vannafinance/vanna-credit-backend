"use client";

/**
 * Portfolio → Lender → Predict (design portfolio.js `lendPredict`, V4), on real data: the connected
 * wallet's World positions from GET /api/predict/positions/:owner. The prompt counts World shares
 * in the wallet that are not earning yet (Start earning opens Predict's linked wallets sheet, which
 * moves them into Vanna's pool). Predict Stats, the Earned card (no earnings history is indexed, so
 * it shows today's total and an empty chart note, never an invented curve), and the positions
 * table with Source (Vanna pool / World wallet) and Status. History = the wallet's own Predict
 * trades rebuilt from fork transactions.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, IC, VMark } from "@/components/v3/icons";
import { nf, pct, sUsd, usd } from "@/components/v3/format";
import { usePredictActivity } from "@/hooks/use-predict";
import { predictHref } from "@/lib/predict/view";
import { rowsOf, usePredictAccount } from "@/components/predict/positions";
import { LinkedSheet, openLinkedSheet } from "@/components/predict/linked-sheet";
import { Badge, ChartCard, Ct, Grid, HistNav, InfoCard, Success, Tag, TxCell, sign, when } from "./pf-ui";
import { VannaLoader } from "@/components/v3/vanna-loader";

const TP = {
  pVal: "Value of your Yes/No shares at today's price; each pays $1 if its side wins and $0 if it loses.",
  pVault: "The paired part of your shares, earning in Vanna's USDC pool, at today's share price.",
  pYield: "Yield your shares in Vanna's pool earn now, paid as extra shares of your side (worth $0 if it loses).",
  pEarned: "Passive yield earned so far, paid in shares of your side at today's price (worth $0 if it loses).",
  pPays: "The most your positions can pay together; where only one outcome can win, only your best case there counts.",
};

/** Share price in cents, 1 decimal (as on Predict). */
const c1 = (v: number) => `${nf(v <= 1 ? v * 100 : v, 1)}¢`;

const HIST_COLS = ".9fr .7fr 1.9fr .7fr 1fr";
const HIST_HEADS = ["Date", "Type", "Trade", "Status", "Tx Hash"];

/** Source badge as on Predict: Vanna (in the pool) or World (in the wallet), both on Solana. */
const Src = ({ src }: { src: "vanna" | "world" }) => (
  <span className="pf-src">
    {src === "vanna" ? <VMark size={14} /> : <Icon sym="WORLD" className="ico pf-i14" />}
    {src === "vanna" ? "Vanna" : "World"}
  </span>
);

export function LenderPredict() {
  const router = useRouter();
  const [view, setView] = useState<"cur" | "hist">("cur");
  const acct = usePredictAccount();
  const hist = usePredictActivity();
  const s = acct.data?.summary ?? { value: 0, cost: 0, pnl: 0, inVault: 0, earned: 0, apy: 0, payout: 0, count: 0, perMonth: 0 };
  const rows = rowsOf(acct.data);
  const idle = acct.data?.importable ?? [];
  const idleV = idle.reduce((t, x) => t + x.value, 0);
  const pooledV = rows.filter((r) => r.kind === "pool").reduce((t, r) => t + r.value, 0);
  const browse = () => router.push("/predict");

  if (!acct.connected)
    return (
      <div className="pf-emptyc">
        Connect a wallet to see your prediction positions.
        <button type="button" className="pf-lnk" onClick={browse}>
          Browse markets
        </button>
      </div>
    );

  return (
    <>
      <LinkedSheet />
      {idle.length > 0 && (
        <section className="pf-imps">
          <div className="pf-imp pf-hot">
            <span className="pf-imp-ic">
              <Icon sym="WORLD" className="ico pf-i20" />
            </span>
            <div className="pf-imp-t">
              <b className="num">
                {idle.length} World position{idle.length > 1 ? "s" : ""} not earning yet, {usd(idleV)}
              </b>
              <span className="pf-imp-s num">
                <Src src="world" />
                <span>In your wallet</span>
                <span className="pf-imp-apy">Earn up to {pct(Math.max(0, ...idle.map((x) => x.apy)), 1)}</span>
              </span>
            </div>
            <button type="button" className="pf-imp-b" onClick={openLinkedSheet}>
              Start earning
            </button>
          </div>
        </section>
      )}
      <div className="pf-row2">
        <InfoCard
          title="Predict Stats"
          rows={[
            ["Predictions value", usd(s.value), "", TP.pVal],
            ["Earning in USDC pool", usd(s.inVault), "", TP.pVault],
            ["Passive yield", <>{pct(s.apy)}<small className="pf-on"> on {usd(pooledV)}</small></>, s.apy > 0 ? "pf-up" : "", TP.pYield],
            ["Earned", sUsd(s.earned), s.earned > 0.004 ? "pf-up" : "", TP.pEarned],
            ["Pays if right", usd(s.payout), "", TP.pPays],
            ["Open Positions", String(rows.length)],
          ]}
        />
        <ChartCard
          title="Earned"
          value={sUsd(s.earned)}
          sub={`${pct(s.apy)} on ${usd(pooledV)} in Vanna's pool`}
          series={null}
          h={198}
          empty="Earnings history is not available yet. The total above is live."
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
          <Grid
            cols={HIST_COLS}
            heads={HIST_HEADS}
            empty={hist.isLoading ? <VannaLoader size="block" /> : "No transactions yet"}
            rows={(hist.data ?? []).map((t, i) => ({
              key: `${t.signature}-${t.marketId}-${t.outcome}-${i}`,
              onClick: t.eventId ? () => router.push(predictHref(t.eventId!, t.marketId, t.outcome)) : undefined,
              cells: [
                <Ct key="d">{when(t.time ?? 0)}</Ct>,
                <Badge key="t" act={t.side === "buy" ? "Buy" : "Sell"} />,
                <Ct key="a" desc={t.question}>
                  {`${nf(t.shares, 2)} ${t.outcomeLabel} at ${c1(t.price)}, ${usd(t.cash)}`}
                </Ct>,
                <Success key="s" />,
                <TxCell key="h" sig={t.signature} />,
              ],
            }))}
          />
        ) : (
          <Grid
            cols="1.75fr 1fr .7fr .85fr .9fr 1.2fr .75fr 1fr .8fr"
            heads={[
              "Market",
              "Source",
              "Outcome",
              "Shares",
              "Value",
              // A plain string so the mobile card layout can label the cell (Grid uses string heads as labels).
              "Earning in USDC pool",
              "Earned",
              "Status",
              "Pays if right",
            ]}
            empty={acct.loading ? <VannaLoader size="block" /> : "No positions yet."}
            rows={rows.map((r) => {
              const pool = r.kind === "pool";
              const part = r.p.shares > 0 ? r.shares / r.p.shares : 0;
              return {
                key: r.key,
                onClick: () => router.push(predictHref(r.eventId, r.marketId, r.side)),
                cells: [
                  <Ct key="m" desc={r.event !== r.market ? r.event : ""}>
                    {r.market}
                  </Ct>,
                  <Src key="src" src={r.src} />,
                  <Tag key="o" cls={r.side === "yes" ? "pf-t-yes" : "pf-t-no"}>
                    {r.label}
                  </Tag>,
                  <Ct key="s" desc={<span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{c1(r.avg)} {IC.arrow} {c1(r.now)}</span>}>
                    {nf(r.shares, 2)}
                  </Ct>,
                  <Ct key="v" desc={<span className={sign(r.pnl)}>{sUsd(r.pnl)}</span>}>
                    {usd(r.value)}
                  </Ct>,
                  <Ct key="iv">{usd(pool ? r.p.inVault * Math.min(1, r.p.poolValueShares ? r.shares / r.p.poolValueShares : 0) : 0)}</Ct>,
                  <Ct key="e">
                    <span className={pool && r.p.earned > 0.004 ? "pos" : ""}>{sUsd(pool ? r.p.earned : 0)}</span>
                  </Ct>,
                  <Tag key="st" cls={r.status.cls === "ok" ? "pf-t-ok" : r.status.cls === "mute" ? "" : "pf-t-warn"}>
                    {r.status.txt}
                  </Tag>,
                  <Ct key="p">{usd(r.p.pays * part)}</Ct>,
                ],
              };
            })}
          />
        )}
      </section>
    </>
  );
}
