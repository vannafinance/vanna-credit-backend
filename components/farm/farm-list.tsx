"use client";

/**
 * V3 Farm list screen (/farm) — the design's farm.js list view on live data:
 * banner · stats strip (connected) · Vaults | Positions · Lending/Single Assets | Delta-Neutral ·
 * pool / vault / threshold filters + search · sortable tables.
 *
 * Data: Kamino reserve metrics (`useFarmPools`, GET /api/farm/pools), the margin account's Kamino
 * cTokens and their earnings / net APY ({@link useFarmAccount}), farm history decoded from the margin
 * account's on-chain events (`useMarginHistory`). Basis rows use deployed vault state
 * (./vault-rows.tsx), in the same row / sortable-header style as the Kamino rows; Perena vaults get
 * their own table under the Kamino one (Lending/Single Assets), with Perena's published APY.
 */
import "./farm-v3.css";
import { apyText } from "@/lib/farm/yield";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Banner, Info, Seg, StatStrip } from "@/components/v3/ui";
import { Icon, IC } from "@/components/v3/icons";
import { cmp, hfFmt, nf, pct, sUsd, tokFmt, usd, usdC } from "@/components/v3/format";
import { hfZone, LIQ_HF } from "@/lib/account-model";
import { explorerUrl } from "@/lib/solana/config";
import { isFarmListed } from "@/lib/solana/farm";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import { useVaults, useVaultAccount } from "@/lib/farm/use-vaults";
import { perenaProduct, positionOf, usePerenaMarket, vaultHref } from "@/lib/farm/basis-live";
import { VaultTable, basisApyMinis, useBasisApys } from "./vault-rows";
import { useFarmAccount, type FarmPositionRow } from "./use-farm-account";
import { Cell, CheckDropdown, SortHead, Venue, sortRows, useOutside, type SortState } from "./fm-ui";
import { VannaLoader } from "@/components/v3/vanna-loader";

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
  ms ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "Never";

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
  const [perenaSort, setPerenaSort] = useState<SortState>(null);
  const liveVaults = useVaults();
  const basisApys = useBasisApys();
  const perenaMarket = usePerenaMarket();
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
  // Basis / Perena positions in the strip: their earnings (value now − net USDC in, from the margin
  // account's history) and their APY (Basis: realized 7D or the Phoenix-funding estimate; Perena:
  // Perena's published 7D APY), weighted by value together with the Kamino positions.
  const vaultPos = VAULTS.filter((v) => vaultHoldings.some((c) => c.mint === v.mint && c.amount > 0)).map((v) => {
    const p = positionOf(v, vaultAccount.margin, farm.history, farm.historyComplete);
    const apy = v.kind === "basis" ? basisApys[v.id]?.value ?? null : perenaProduct(perenaMarket, v.id).apy7 ?? null;
    return { value: p.valueUsd, earned: p.earnedUsd, apy };
  });
  const vaultEarned = vaultPos.reduce((sum, p) => sum + (p.earned ?? 0), 0);
  const earnedTotal = (t.earned ?? 0) + vaultEarned;
  const earnedKnown = t.earned !== null || vaultPos.some((p) => p.earned !== null);
  const kaminoW = t.netApy !== null ? t.tvl : 0;
  const vaultW = vaultPos.filter((p) => p.apy !== null).reduce((sum, p) => sum + p.value, 0);
  const netFarmApy =
    kaminoW + vaultW > 0 ? ((t.netApy ?? 0) * 100 * kaminoW + vaultPos.reduce((sum, p) => sum + (p.apy !== null ? p.apy * p.value : 0), 0)) / (kaminoW + vaultW) : null;
  const netTip =
    "Value-weighted yearly yield of all your farm positions at today's rates: Kamino supply APY after the Vanna borrow rate on the part funded by your debt in the same token; Basis vaults at their realized 7-day APY (or, until a vault has 7 days of history, the estimate from Phoenix funding on its short; fewer days of share-price history are never annualised); Perena at its published 7-day APY.";
  const strip = farm.connected && (
    <div className="fm-fsw">
      <StatStrip
        center
        n={5}
        items={[
          { icon: IC.wallet, label: "Your Deposit TVL", value: usd(t.tvl + vaultTvl) },
          {
            icon: IC.coins,
            label: (
              <>
                Your Earnings{" "}
                <Info text="Kamino and vault positions: what you can redeem now minus what you put in (net of withdrawals), from your margin account's on-chain history, at today's price." />
              </>
            ),
            value: sUsd(earnedKnown ? earnedTotal : 0),
            valueClass: earnedKnown && earnedTotal > 0 ? "pos" : earnedKnown && earnedTotal < 0 ? "neg" : "",
          },
          {
            icon: IC.pct,
            label: (
              <>
                Net Farm APY <Info text={netTip} />
              </>
            ),
            value: pct(netFarmApy ?? 0),
            valueClass: netFarmApy !== null && netFarmApy < 0 ? "neg" : "",
          },
          {
            icon: IC.spark,
            label: (
              <>
                Pending Rewards <Info text="Kamino farm reward emissions aren't read by the app yet, so they aren't shown." />
              </>
            ),
            value: usd(0),
          },
          {
            icon: IC.heart,
            label: (
              <>
                Net Health Factor <Info text={`Your margin account's health factor, the same number as on Margin; at ${nf(LIQ_HF, 2)} or below it can be liquidated.`} />
              </>
            ),
            value: hfFmt(hf),
            // Same colouring as Margin: green "No debt", zone colour otherwise.
            valueClass: hf === null ? "z-ok" : hfZone(hf),
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
              <Cell v={`${cmp(p.totalSupply ?? 0)} ${p.symbol}`} mini={usd(p.totalSupplyUsd ?? 0)} />
              <Cell v={`${cmp(p.totalBorrow ?? 0)} ${p.symbol}`} mini={usd(p.totalBorrowUsd ?? 0)} />
              <Cell v={pct((p.supplyApy ?? 0) * 100)} />
              <Cell v={pct((p.borrowApy ?? 0) * 100)} />
              <Cell v={pct((p.utilization ?? 0) * 100)} />
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

  // Perena vaults: their own table under the Kamino one (a vault has no borrow side, so it gets its
  // own columns), in the same row / pill / sortable-header style.
  const perenaTable = () => {
    const query = q.trim().toLowerCase();
    const items = VAULTS.filter((v) => v.kind === "perena" && (!query || `${v.name} ${v.symbol} perena usdc`.toLowerCase().includes(query)) && keepAsset(v.asset)).map((v) => {
      const st = liveVaults.data.find((x) => x.id === v.id);
      const product = perenaProduct(perenaMarket, v.id);
      const apy = product.apy7 ?? 0;
      const tvl = st?.navUsd ?? 0;
      const px = st?.sharePriceUsd ?? 0;
      const supply = px > 0 ? tvl / px : 0;
      const held = vaultHoldings.find((c) => c.mint === v.mint);
      return {
        v: { asset: v.symbol, prot: "Perena", tvl, px, apy, holders: product.holders ?? 0, hold: held?.usd ?? 0 },
        el: (
          <Link key={v.id} href={vaultHref(v.id)} className="fm-tr fm-row k7" aria-label={`Open ${v.name} vault`}>
            <Cell
              v={
                <span className="fm-tk">
                  <Icon sym="SOL" className="fm-chn" />
                  <Icon sym={v.symbol} className="fm-ico16" />
                  {v.symbol}
                </span>
              }
              mini={["Perena", "Vault"]}
            />
            <Cell v={<Venue name="Perena" />} />
            <Cell v={`${cmp(supply)} ${v.symbol}`} mini={usd(tvl)} />
            <Cell v={usd(px, 6)} mini="USDC per share" />
            <Cell v={pct(apy)} cls={apy > 0 ? "pos" : ""} />
            <Cell v={nf(product.holders ?? 0, 0)} />
            <Cell v={`${nf(held?.amount ?? 0, 4)} ${v.symbol}`} mini={usd(held?.usd ?? 0)} />
          </Link>
        ),
      };
    });
    if (!items.length) return null;
    return (
      <>
        <h2 className="fm-tblh">
          <Icon sym="Perena" className="fm-ico16 fm-inl" />
          Perena vaults
        </h2>
        <div className="fm-tbl" aria-label="Perena vaults">
          <SortHead
            cls="k7"
            sort={perenaSort}
            onSort={setPerenaSort}
            cols={[
              ["Asset", "asset"],
              ["Protocol", "prot"],
              ["Total Value Locked", "tvl", "Receipt supply × share price, read on chain by Vanna."],
              ["Share Price", "px", "USDC per receipt, from Perena's on-chain price account."],
              ["APY (7D)", "apy", "Perena's published 7-day APY (api.perena.org), as on app.perena.org/earn."],
              ["Holders", "holders", "Wallets holding the receipt, from Perena's public API."],
              ["Holding", "hold"],
            ]}
          />
          {sortRows(items, perenaSort).map((x) => x.el)}
        </div>
      </>
    );
  };

  const dnTable = () => <VaultTable query={q} keepAsset={keepAsset} keepApy={keepThr} sort={sort} onSort={setSort} />;

  const posTable = () => {
    // Kamino cTokens and Basis / Perena receipts held in the margin account, one table.
    const vaultItems = VAULTS.filter((v) => vaultHoldings.some((c) => c.mint === v.mint && c.amount > 0) && keepAsset(v.asset)).map((v) => {
      const p = positionOf(v, vaultAccount.margin, farm.history, farm.historyComplete);
      const st = liveVaults.data.find((x) => x.id === v.id);
      const basis = v.kind === "basis";
      // Basis: realized 7D APY, else the Phoenix-funding estimate (same as the Delta-Neutral list).
      const basisApy = basis ? basisApys[v.id] : undefined;
      // Perena: Perena's published 7D APY (the fork has no 7-day history of its own yet).
      const apy = basisApy ? basisApy.value : perenaProduct(perenaMarket, v.id).apy7 ?? st?.apy7 ?? null;
      return {
        v: { asset: v.name, prot: basis ? "Jupiter · Phoenix" : "Perena", hold: p.valueUsd, earn: p.earnedUsd ?? 0, apy: apy === null ? Number.NEGATIVE_INFINITY : apy / 100 },
        el: (
          <Link key={v.id} href={vaultHref(v.id)} className="fm-tr fm-row k5" aria-label={`Open ${v.name}`}>
            <Cell
              v={
                <span className="fm-tk">
                  <Icon sym={basis ? v.asset : v.symbol} className="fm-ico16" />
                  {v.name}
                </span>
              }
              mini={[basis ? "Basis" : "Perena", v.symbol]}
            />
            <Cell v={<Venue name={basis ? "Jupiter · Phoenix" : "Perena"} />} />
            <Cell v={`${nf(p.shares, 4)} ${v.symbol}`} mini={usd(p.valueUsd)} />
            {p.earnedUsd === null ? (
              <Cell v={usd(0)} mini="history incomplete" />
            ) : (
              <Cell v={sUsd(p.earnedUsd)} mini={p.since ? `since ${dateLbl(p.since)}` : undefined} cls={p.earnedUsd >= 0 ? "pos" : "neg"} />
            )}
            <Cell
              v={apyText(apy)}
              mini={basis ? basisApyMinis(basisApy, st?.apy7Source, st?.returnSinceLaunchPct, st?.sinceLaunchDays) : undefined}
            />
          </Link>
        ),
      };
    });
    if (!farm.connected || (!farm.rows.length && !vaultItems.length)) return <div className="fm-empty">{farm.positionsLoading ? <VannaLoader size="block" /> : "No farm positions yet"}</div>;
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
              <Cell v={usd(0)} mini="history incomplete" />
            ) : (
              <Cell v={sUsd(r.earnedUsd)} mini={r.since ? `since ${dateLbl(r.since)}` : undefined} cls={r.earnedUsd >= 0 ? "pos" : "neg"} />
            )}
            <Cell v={pct((r.apy ?? 0) * 100)} />
          </Link>
        ),
      }));
    const rows = sortRows([...items, ...vaultItems], sort).map((x) => x.el);
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
            ["APY", "apy", "Kamino's current supply APY; for Basis vaults, the realized 7-day vault APY or, until 7 days of history exist, the Phoenix-funding estimate (Est.); for Perena, its published 7-day APY."],
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
              mini={r.type === "farm-deposit" ? (r.vaultId ? "Deposit" : "Supply") : "Withdraw"}
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
  const body = pos ? (posTab === "history" ? histTable() : posTable()) : dn ? dnTable() : <>{lendTable()}{perenaTable()}</>;

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
              <span className="fm-ddw" ref={thrRef}>
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
              </span>
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
