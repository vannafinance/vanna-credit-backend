"use client";

/**
 * V3 Kamino vault page (/farm/:id) — the design's `kamView`: back link, title + tags, Kamino stats
 * bar, All Transactions | Analytics panel, and the Supply / Withdraw column ({@link KaminoAction}).
 *
 * Data: Kamino reserve metrics (`useFarmPool`), the margin account's cTokens for this vault and their
 * earnings ({@link useFarmAccount}), this vault's farm-deposit / farm-withdraw events from the margin
 * account's on-chain history. There is no position-value time series on chain, so the position summary
 * shows today's value and earned yield.
 */
import "./farm-v3.css";
import { useState } from "react";
import { Icon } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { cmp, nf, pct, tokFmt, usd } from "@/components/v3/format";
import { explorerUrl } from "@/lib/solana/config";
import { useFarmPool } from "@/lib/farm/use-farm";
import type { FarmPoolConfig } from "@/lib/farm/pools";
import { useFarmAccount, type FarmPositionRow } from "./use-farm-account";
import { KaminoAction } from "./kamino-action";
import { BackLink, Cell, HowItWorks, TabsBox, Tiles, Venue, VTag, YieldList } from "./fm-ui";
import { PositionTxPanel } from "./position-tx";
import { VannaLoader } from "@/components/v3/vanna-loader";

const COLS = {
  current: [
    ["Asset", "1.2fr"],
    ["Protocol", "1fr"],
    ["Supplied", "1.2fr"],
    ["Receipt balance", "1.2fr"],
    ["APY", ".8fr"],
  ],
  history: [
    ["Date", "1.1fr"],
    ["Type", ".9fr"],
    ["Amount", "1.1fr"],
    ["Status", ".8fr"],
    ["Tx Hash", "1fr"],
  ],
} as const;

const m = (v: number | null, kind: "pct" | "usd") => (kind === "pct" ? pct(v !== null && Number.isFinite(v) ? v * 100 : 0) : usd(v !== null && Number.isFinite(v) ? v : 0));

export function KaminoVault({ id }: { id: string }) {
  const { pool, isLoading } = useFarmPool(id);
  const farm = useFarmAccount();
  const [left, setLeft] = useState<"tx" | "an">("tx");

  if (!pool) {
    return (
      <div className="v3">
        <div className="page">
          <BackLink />
          <section className="fm-nf">
            {isLoading ? <VannaLoader caption="Loading pool" /> : <h1>Pool not found</h1>}
            {!isLoading && <p>&ldquo;{id}&rdquo; isn&apos;t a Farm vault.</p>}
          </section>
        </div>
      </div>
    );
  }
  const position = farm.rows.find((r) => r.poolId === pool.id) ?? null;
  const stat = (l: string, v: string) => (
    <article>
      <div className="lbl">{l}</div>
      <div className="fm-sv">{v}</div>
    </article>
  );

  return (
    <div className="v3">
      <div className="page">
        <BackLink />
        <div className="fm-vh">
          <Icon sym={pool.symbol} className="fm-ico28" />
          <h1>{pool.symbol}</h1>
          <span className="fm-tag">Vault</span>
          <VTag name="Kamino" />
        </div>
        <section className="fm-stats num">
          {stat("Supply APY", m(pool.supplyApy, "pct"))}
          {stat("Borrow APY", m(pool.borrowApy, "pct"))}
          {stat("Utilization Rate", m(pool.utilization, "pct"))}
          {stat("Total Pool Supply", m(pool.totalSupplyUsd, "usd"))}
        </section>
        <div className="fm-cols">
          <div className="fm-main">
            <TabsBox
              items={[
                ["tx", "All Transactions"],
                ["an", "Analytics"],
              ]}
              value={left}
              onChange={setLeft}
            />
            <div className="fm-panel kp">{left === "an" ? <Analytics pool={pool} /> : <Transactions pool={pool} position={position} farm={farm} />}</div>
          </div>
          <aside className="fm-aside">
            <KaminoAction pool={pool} position={position} />
            <Tiles
              items={[
                ["Total Value Locked", m(pool.totalSupplyUsd, "usd")],
                ["Supply APY", m(pool.supplyApy, "pct")],
              ]}
            />
            <YieldList
              rows={[
                ["Your Position", usd(position ? position.liquidityUsd : 0)],
                ["Receipt", pool.receiptSymbol],
              ]}
            />
            <HowItWorks
              steps={[
                ["Choose a vault", "Pick the asset to supply to Kamino"],
                ["Supply from your margin account", "Supply the asset already in your margin account (deposited, borrowed or swapped in) to Kamino"],
                ["Earn Kamino supply yield", "The cTokens stay in your margin account and count toward its health factor"],
                ["Withdraw anytime", "Redeem back into your margin account, then repay or withdraw on the Margin page"],
              ]}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function Analytics({ pool }: { pool: FarmPoolConfig }) {
  const sc = (h: string, main: string, sub: string, tip: string) => (
    <div className="fm-sc">
      <div className="lbl">
        {h} <Info text={tip} />
      </div>
      <b>{main}</b>
      <span>{sub}</span>
    </div>
  );
  const tok = (v: number | null) => `${cmp(v ?? 0)} ${pool.symbol}`;
  return (
    <>
      <h2 className="fm-h21">Statistics</h2>
      <div className="fm-scg num">
        {sc("Supply APY", m(pool.supplyApy, "pct"), "Annual yield on supplied assets", `The yearly yield Kamino pays on ${pool.symbol} supplied to this reserve (Kamino main market).`)}
        {sc("Borrow APY", m(pool.borrowApy, "pct"), "Annual cost to borrow on Kamino", `The yearly rate Kamino charges people who borrow ${pool.symbol} from this reserve.`)}
        {sc("Utilization", m(pool.utilization, "pct"), "Borrowed / Total Supply", "The share of this reserve that is lent out right now.")}
        {sc("Total Supply", tok(pool.totalSupply), m(pool.totalSupplyUsd, "usd"), `All ${pool.symbol} supplied to this Kamino reserve, by everyone.`)}
        {sc("Total Borrow", tok(pool.totalBorrow), m(pool.totalBorrowUsd, "usd"), `All ${pool.symbol} borrowed from this Kamino reserve, by everyone.`)}
      </div>
    </>
  );
}

function Transactions({ pool, position, farm }: { pool: FarmPoolConfig; position: FarmPositionRow | null; farm: ReturnType<typeof useFarmAccount> }) {
  const history = farm.history
    .filter((r) => (r.type === "farm-deposit" || r.type === "farm-withdraw") && r.symbol === pool.symbol)
    .map((r) => ({ ...r, label: r.type === "farm-deposit" ? "Supply" : "Withdraw" }));

  const current = position
    ? [
        [
          <Cell
            key="a"
            v={
              <span className="fm-tk">
                <Icon sym={pool.symbol} className="fm-ico16" />
                {pool.symbol}
              </span>
            }
            mini="Vault"
          />,
          <Cell key="p" v={<Venue name="Kamino" />} />,
          <Cell key="s" v={tokFmt(position.underlying, pool.symbol)} mini={usd(position.liquidityUsd)} />,
          <Cell key="r" v={`${nf(position.receipts, 6)} ${pool.receiptSymbol}`} />,
          <Cell key="y" v={m(pool.supplyApy, "pct")} />,
        ],
      ]
    : [];
  const rows = history.map((r) => ({
    label: r.label,
    cells: [
      <Cell key="d" v={new Date(r.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} mini={new Date(r.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })} />,
      <Cell key="t" v={r.label} />,
      <Cell key="m" v={tokFmt(Number(r.amount), pool.symbol)} />,
      <Cell key="s" v={<span className="fm-ok">Success</span>} />,
      <Cell
        key="h"
        v={
          <a className="fm-link" href={explorerUrl("tx", r.signature)} target="_blank" rel="noreferrer">
            {r.signature.slice(0, 8)}…{r.signature.slice(-4)}
          </a>
        }
      />,
    ],
  }));

  // Layout, filters and column visibility live in the shared panel (also used by the Perena page).
  return (
    <PositionTxPanel
      summary={[
        ["Position value", usd(position ? position.liquidityUsd : 0)],
        ["Receipt balance", `${nf(position ? position.receipts : 0, 6)} ${pool.receiptSymbol}`],
        ["Earned yield", usd(position?.earnedUsd ?? 0), position?.since ? `Since ${new Date(position.since).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : undefined],
      ]}
      cols={COLS}
      current={current}
      history={rows}
      typeOptions={["Supply", "Withdraw"]}
    />
  );
}
