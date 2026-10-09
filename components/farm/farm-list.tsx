"use client";

/**
 * V3 Farm list screen (/farm) — the design's farm.js list view on live data:
 * banner · stats strip (connected) · Vaults | Positions · Lending/Single Assets | Delta-Neutral ·
 * pool / vault / threshold filters + search · sortable tables.
 *
 * Data: Kamino reserve metrics (`useFarmPools`, GET /api/farm/pools), the margin account's Kamino
 * cTokens and their earnings / net APY ({@link useFarmAccount}), farm history decoded from the margin
 * account's on-chain events (`useMarginHistory`). Basis and Perena rows use deployed vault state.
 */
import "./farm-v3.css";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Banner, Info, Seg, StatStrip } from "@/components/v3/ui";
import { Icon, IC } from "@/components/v3/icons";
import { cmp, hfFmt, nf, pct, sUsd, tokFmt, usd, usdC } from "@/components/v3/format";
import { hfZone, LIQ_HF } from "@/lib/account-model";
import { explorerUrl } from "@/lib/solana/config";
import { isFarmListed } from "@/lib/solana/farm";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import { useVaultAccount } from "@/lib/farm/use-vaults";
import { LiveVaultTable } from "./live-vault-table";
import { useFarmAccount, type FarmPositionRow } from "./use-farm-account";
import { Cell, CheckDropdown, SortHead, Venue, sortRows, useOutside, type SortState } from "./fm-ui";

const DN_SLIDES: [string, string][] = [
  ["Delta-neutral Vaults", "Deposit from your margin account. Each vault buys spot on Jupiter and holds an equal 1x short on Phoenix, and earns the funding."],
  ["Earn Funding, Not Direction", "Long spot and short perp cancel out the price move; the vault keeps the funding shorts are paid."],
  ["Vault receipts", "Shares stay in your margin account and are valued by Vanna. SOL Basis deposits start from your wallet."],
];

type Tab = "vaults" | "positions";
type Cat = "lend" | "dn";
type PosTab = "current" | "history";

/** "100M" / "$2.5k" / "8%" → number; null when empty or unparsable. */
const parseThr = (s: string) => {
  const m = s.trim().replace(/[$,%\s]/g, "").match(/^(\d*\.?\d+)([kmb])?$/i);
  return m ? parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase() as "k" | "m" | "b"] ?? 1) : null;
};
const dateLbl = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const timeLbl = (ms: number) =>
  ms ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

export function FarmList() {
  const farm = useFarmAccount();
  const vaultAccount = useVaultAccount();
  const vaultHoldings = vaultAccount.margin?.collateral.filter(c => VAULTS.some(v => v.mint === c.mint)) ?? [];
  const vaultTvl = vaultHoldings.reduce((sum, c) => sum + c.usd, 0);
  const [tab, setTab] = useState<Tab>("vaults");
  const [cat, setCat] = useState<Cat>("lend");
  const [posTab, setPosTab] = useState<PosTab>("current");
  const [q, setQ] = useState("");
  const [poolSel, setPoolSel] = useState<string[]>([]);
  const [vaultSel, setVaultSel] = useState<string[]>([]);
  const [op, setOp] = useState<"gt" | "lt">("gt");
  const [thr, setThr] = useState("");
  const [thrOpen, setThrOpen] = useState(false);
  const [sort, setSort] = useState<SortState>(null);
  const thrRef = useOutside(thrOpen, () => setThrOpen(false));

  // "Back to pools" from a basis vault lands on /farm?category=delta-neutral.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("category") === "delta-neutral") setCat("dn");
  }, []);

  const resetList = () => {
    setPoolSel([]);
    setVaultSel([]);
    setThr("");
    setSort(null);
    setThrOpen(false);
  };
  const dn = tab === "vaults" && cat === "dn";
  const thrVal = parseThr(thr);
  const keepThr = (v: number | null) => thrVal === null || (v !== null && (op === "gt" ? v > thrVal : v < thrVal));
  const keepAsset = (s: string) => (!poolSel.length || poolSel.includes(s)) && (!vaultSel.length || vaultSel.includes(s));
  const thrLbl = thrVal === null ? "Anything" : `${op === "gt" ? "Over" : "Under"} ${dn ? pct(thrVal, 1) : usdC(thrVal)}`;

  const listed = useMemo(() => farm.pools.filter((p) => isFarmListed(p.symbol)), [farm.pools]);
  const positionBySymbol = useMemo(() => new Map(farm.rows.map((r) => [r.symbol, r])), [farm.rows]);
  const farmHistory = useMemo(() => farm.history.filter((r) => r.type === "farm-deposit" || r.type === "farm-withdraw"), [farm.history]);

  const assets =
    tab === "positions"
      ? [...new Set((posTab === "history" ? farmHistory.map((r) => r.symbol) : [...farm.rows.map((r) => r.symbol), ...VAULTS.filter(v => vaultHoldings.some(c => c.mint === v.mint)).map(v => v.asset)]).filter(Boolean))]
      : dn
        ? VAULTS.filter(v => v.kind === "basis").map((v) => v.asset)
        : listed.map((p) => p.symbol);
  const poolsLbl = poolSel.length ? (poolSel.length > 2 ? `${poolSel.length} Pools` : poolSel.join(", ")) : "All Pools";

  // ---- Stats strip (connected): live margin holdings across Kamino, Basis and Perena. ----
  const t = farm.totals;
  const hf = farm.hf;
  const netTip =
    "Yearly yield of your farm positions after borrow cost: the value-weighted Kamino supply APY, minus the Vanna borrow rate on the part of each position funded by your debt in the same token (the smaller of the position's value and that debt). Rates are today's on-chain rates.";
  const strip = farm.connected && (
    <div className="fm-fsw">
      <StatStrip
        n={5}
        items={[
          { icon: IC.wallet, label: "Your Deposit TVL", value: usd(t.tvl + vaultTvl) },
          {
            icon: IC.coins,
            label: (
              <>
                Your Earnings{" "}
                <Info text="Underlying you can redeem now minus what you supplied (net of withdrawals), from your margin account's on-chain history, at today's price. Shows — when that history is incomplete." />
              </>
            ),
            value: vaultHoldings.length > 0 || t.earned === null ? "—" : usd(t.earned),
            valueClass: t.earned !== null && t.earned > 0 ? "pos" : "",
          },
          {
            icon: IC.pct,
            label: (
              <>
                Net Farm APY <Info text={netTip} />
              </>
            ),
            value: vaultHoldings.length > 0 || t.netApy === null ? "—" : pct(t.netApy * 100),
            valueClass: t.netApy !== null && t.netApy < 0 ? "neg" : "",
            sub: t.grossApy === null ? (farm.rows.length || vaultHoldings.length ? "" : "No farm positions") : `${pct(t.grossApy * 100)} before borrow cost`,
          },
          {
            icon: IC.spark,
            label: (
              <>
                Pending Rewards <Info text="Kamino farm reward emissions aren't read by the app yet, so they aren't shown." />
              </>
            ),
            value: "—",
          },
          {
            icon: IC.heart,
            label: (
              <>
                Net Health Factor <Info text={`Your margin account's health factor, the same number as on Margin; at ${nf(LIQ_HF, 2)} or below it can be liquidated.`} />
              </>
            ),
            value: hf === null ? "—" : hfFmt(hf),
            valueClass: hf === null ? "" : hfZone(hf),
          },
        ]}
      />
    </div>
  );

  // ---- Tables ----
  const lendTable = () => {
    const query = q.trim().toLowerCase();
    const items = listed
      .filter((p) => (!query || p.symbol.toLowerCase().includes(query) || "kamino".includes(query)) && keepAsset(p.symbol) && keepThr(p.totalBorrowUsd))
      .map((p) => {
        const pos = positionBySymbol.get(p.symbol);
        return {
          v: { asset: p.symbol, prot: "Kamino", dep: p.totalSupplyUsd ?? 0, bor: p.totalBorrowUsd ?? 0, sup: p.supplyApy ?? 0, bora: p.borrowApy ?? 0, util: p.utilization ?? 0, hold: pos?.liquidityUsd ?? 0 },
          el: (
            <Link key={p.id} href={`/farm/${p.id}`} className="fm-tr fm-row k8" aria-label={`Open ${p.symbol} vault`}>
              <Cell
                v={
                  <span className="fm-tk">
                    <Icon sym="SOL" className="fm-chn" />
                    <Icon sym={p.symbol} className="fm-ico16" />
                    {p.symbol}
                  </span>
                }
                mini={["Kamino", "Supply"]}
              />
              <Cell v={<Venue name="Kamino" />} />
              <Cell v={p.totalSupply === null ? "—" : `${cmp(p.totalSupply)} ${p.symbol}`} mini={p.totalSupplyUsd === null ? undefined : usd(p.totalSupplyUsd)} />
              <Cell v={p.totalBorrow === null ? "—" : `${cmp(p.totalBorrow)} ${p.symbol}`} mini={p.totalBorrowUsd === null ? undefined : usd(p.totalBorrowUsd)} />
              <Cell v={p.supplyApy === null ? "—" : pct(p.supplyApy * 100)} />
              <Cell v={p.borrowApy === null ? "—" : pct(p.borrowApy * 100)} />
              <Cell v={p.utilization === null ? "—" : pct(p.utilization * 100)} />
              <Cell v={pos ? tokFmt(pos.underlying, p.symbol) : `0 ${p.symbol}`} mini={pos ? usd(pos.liquidityUsd) : "$0.00"} />
            </Link>
          ),
        };
      });
    const rows = sortRows(items, sort).map((x) => x.el);
    return (
      <div className="fm-tbl">
        <SortHead
          cls="k8"
          sort={sort}
          onSort={setSort}
          cols={[
            ["Asset", "asset"],
            ["Protocol", "prot"],
            ["Total Deposits", "dep"],
            ["Total Borrow", "bor"],
            ["Supply APY", "sup", "Kamino's current yearly supply yield on this reserve (Kamino main market)."],
            ["Borrow APY", "bora", "Kamino's current yearly borrow rate on this reserve."],
            ["Utilization", "util"],
            ["Holding", "hold"],
          ]}
        />
        {rows.length ? rows : <div className="fm-none">No vaults match these filters</div>}
      </div>
    );
  };

  const dnTable = () => <LiveVaultTable kind="basis" query={q} keepAsset={keepAsset}/>;

  const posTable = () => {
    if (!farm.rows.length && vaultHoldings.length) return null;
    if (!farm.connected || !farm.rows.length) return <div className="fm-empty">{farm.positionsLoading ? "Loading positions…" : "No farm positions yet"}</div>;
    const items = farm.rows
      .filter((r) => keepAsset(r.symbol))
      .map((r: FarmPositionRow) => ({
        v: { asset: r.symbol, prot: "Kamino", hold: r.liquidityUsd, earn: r.earnedUsd ?? 0, apy: r.apy ?? 0 },
        el: (
          <Link key={r.poolId} href={`/farm/${r.poolId}`} className="fm-tr fm-row k5" aria-label={`Open ${r.symbol}`}>
            <Cell
              v={
                <span className="fm-tk">
                  <Icon sym="SOL" className="fm-chn" />
                  <Icon sym={r.symbol} className="fm-ico16" />
                  {r.symbol}
                </span>
              }
              mini={["Kamino", r.receiptSymbol]}
            />
            <Cell v={<Venue name="Kamino" />} />
            <Cell v={tokFmt(r.underlying, r.symbol)} mini={usd(r.liquidityUsd)} />
            {r.earnedUsd === null ? (
              <Cell v="—" mini="history incomplete" />
            ) : (
              <Cell v={sUsd(r.earnedUsd)} mini={r.since ? `since ${dateLbl(r.since)}` : undefined} cls={r.earnedUsd >= 0 ? "pos" : "neg"} />
            )}
            <Cell v={r.apy === null ? "—" : pct(r.apy * 100)} />
          </Link>
        ),
      }));
    const rows = sortRows(items, sort).map((x) => x.el);
    return (
      <div className="fm-tbl">
        <SortHead
          cls="k5"
          sort={sort}
          onSort={setSort}
          cols={[
            ["Asset", "asset"],
            ["Protocol", "prot"],
            ["Holdings", "hold"],
            ["Earnings", "earn", "Redeemable now minus supplied (net of withdrawals), from your on-chain history, at today's price."],
            ["APY", "apy", "Kamino's current supply APY."],
          ]}
        />
        {rows.length ? rows : <div className="fm-none">No positions match these filters</div>}
      </div>
    );
  };

  const histTable = () => {
    if (!farm.connected || !farmHistory.length) return <div className="fm-empty">No farm activity yet</div>;
    const items = farmHistory
      .filter((r) => keepAsset(r.symbol))
      .map((r, i) => ({
        v: { asset: r.symbol, prot: "Kamino", amt: Number(r.amount), tx: -i },
        el: (
          <div key={`${r.signature}-${i}`} className="fm-tr fm-row k4 static">
            <Cell
              v={
                <span className="fm-tk">
                  <Icon sym={r.symbol} className="fm-ico16" />
                  {r.symbol}
                </span>
              }
              mini={r.type === "farm-deposit" ? "Supply" : "Withdraw"}
            />
            <Cell v={<Venue name={r.vaultId?.startsWith("basis-") ? "Jupiter · Phoenix" : r.vaultId ? "Perena" : "Kamino"} />} mini={timeLbl(r.timestamp)} />
            <Cell v={tokFmt(Number(r.amount), r.symbol)} />
            <Cell
              v={
                <a className="fm-link" href={explorerUrl("tx", r.signature)} target="_blank" rel="noreferrer">
                  {r.signature.slice(0, 8)}…
                </a>
              }
            />
          </div>
        ),
      }));
    const rows = sortRows(items, sort).map((x) => x.el);
    return (
      <div className="fm-tbl">
        <SortHead
          cls="k4"
          sort={sort}
          onSort={setSort}
          cols={[
            ["Asset", "asset"],
            ["Protocol", "prot"],
            ["Amount", "amt"],
            ["Tx Hash", "tx"],
          ]}
        />
        {rows.length ? rows : <div className="fm-none">No activity matches these filters</div>}
      </div>
    );
  };

  const pos = tab === "positions";
  const body = pos ? (posTab === "history" ? histTable() : <>{posTable()}<LiveVaultTable positions query={q}/></>) : dn ? dnTable() : <>{lendTable()}<LiveVaultTable kind="perena" query={q} keepAsset={keepAsset}/></>;

  return (
    <div className="v3">
      <div className="page">
        <Banner key={dn ? "dn" : "lend"} page="farm" slides={dn ? DN_SLIDES : undefined} />
        {strip}

        <div className={`fm-bar ${farm.connected ? "st" : ""}`}>
          <Seg<Tab>
            value={tab}
            options={[
              ["vaults", "Vaults"],
              ["positions", "Positions"],
            ]}
            onChange={(v) => {
              setTab(v);
              resetList();
            }}
          />
          {pos ? (
            <Seg<PosTab>
              value={posTab}
              options={[
                ["current", "Current Position"],
                ["history", "Position History"],
              ]}
              onChange={(v) => {
                setPosTab(v);
                setSort(null);
              }}
            />
          ) : (
            <Seg<Cat>
              value={cat}
              options={[
                ["lend", "Lending/Single Assets"],
                ["dn", "Delta-Neutral"],
              ]}
              onChange={(v) => {
                setCat(v);
                resetList();
              }}
            />
          )}
        </div>

        <div className="fm-filters">
          <div className="fm-fl">
            <CheckDropdown
              options={assets}
              selected={poolSel}
              onChange={setPoolSel}
              placeholder="Search for pools"
              trigger={(open, toggle) => (
                <button type="button" className={`fm-dd ${poolSel.length ? "set" : ""}`} aria-haspopup="listbox" aria-expanded={open} onClick={toggle}>
                  <Icon sym="SOL" className="fm-ico16" />
                  {poolsLbl} {IC.chev}
                </button>
              )}
            />
            {!pos && (
              <label className="fm-search">
                {IC.search}
                <input placeholder="Search for Pools" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search for pools" />
              </label>
            )}

          </div>
          {!pos && (
            <div className="fm-fr">
              <span className="fm-vl">Vaults:</span>
              <CheckDropdown
                right
                options={assets}
                selected={vaultSel}
                onChange={setVaultSel}
                placeholder="Search for vaults"
                trigger={(open, toggle) => (
                  <button type="button" className={`fm-all ${vaultSel.length ? "set" : ""}`} aria-haspopup="listbox" aria-expanded={open} onClick={toggle}>
                    <FilterIcon />
                    {vaultSel.length ? vaultSel.join(", ") : "All"}
                  </button>
                )}
              />
              {!dn && <span className="fm-ddw" ref={thrRef}>
                <button type="button" className="fm-chip" aria-haspopup="dialog" aria-expanded={thrOpen} onClick={() => setThrOpen((o) => !o)}>
                  {dn ? "Vault APY" : "Total Borrow"} <span>{thrLbl}</span>
                </button>
                {thrOpen && (
                  <div className="pop r fm-tpop" role="dialog" aria-label={`${dn ? "Vault APY" : "Total Borrow"} filter`}>
                    <div className="fm-tph">
                      <span>{dn ? "Vault APY, %" : "Total Borrow, USD"}</span>
                      <button
                        type="button"
                        className="fm-reset"
                        onClick={() => {
                          setThr("");
                          setOp("gt");
                        }}
                      >
                        Reset
                      </button>
                    </div>
                    <div className="fm-seg2">
                      <button type="button" className={op === "gt" ? "on" : ""} onClick={() => setOp("gt")}>
                        Greater than
                      </button>
                      <button type="button" className={op === "lt" ? "on" : ""} onClick={() => setOp("lt")}>
                        Less than
                      </button>
                    </div>
                    <input
                      className="fm-thr num"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={dn ? "e.g. 8" : "e.g. 100M"}
                      value={thr}
                      onChange={(e) => setThr(e.target.value)}
                      aria-label={dn ? "Vault APY in percent" : "Total borrow in USD"}
                    />
                  </div>
                )}
              </span>}
            </div>
          )}
        </div>

        <div className="fm-tw">{body}</div>
      </div>
    </div>
  );
}

function FilterIcon() {
  return (
    <svg width="17" height="12" viewBox="0 0 17 12" aria-hidden="true">
      <path d="M1 1h15M4 6h9M7 11h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
