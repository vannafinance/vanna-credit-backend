"use client";

/**
 * Portfolio → Balances: every token the user holds, split between the connected wallet and the margin
 * account, with amounts and USD values. Wallet balances come from the wallet store (on-chain reads);
 * margin holdings from the account snapshot (the same rows the health factor values, Farm receipts
 * such as kSOL / USD* / vbSOL included), plus the Phoenix perps account as one line when it holds
 * anything. Wallet tokens are priced with the oracle prices the app uses everywhere (`p.px`).
 */
import { useMemo, useState } from "react";
import { useUserStore } from "@/store/user";
import { findToken } from "@/lib/solana/tokens";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import { IC, Icon } from "@/components/v3/icons";
import { tokFmt, usd } from "@/components/v3/format";
import type { Portfolio } from "./use-portfolio";
import { Ct, Grid } from "./pf-ui";

type View = "wallet" | "margin";

interface BalanceRow {
  symbol: string;
  name: string;
  wallet: number;
  walletUsd: number;
  margin: number;
  marginUsd: number;
  /** A margin-account line that isn't a token (the Phoenix perps account): value only. */
  valueOnly?: boolean;
}

const nameOf = (sym: string) =>
  findToken(sym)?.name ??
  VAULTS.find((v) => v.symbol === sym)?.name ??
  (sym.startsWith("k") ? `Kamino ${sym.slice(1)} receipt` : sym);

export function Balances({ p }: { p: Portfolio }) {
  const tokenBalances = useUserStore((s) => s.tokenBalances);
  const [view, setView] = useState<View>("wallet");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const by = new Map<string, BalanceRow>();
    const row = (sym: string) => {
      let r = by.get(sym);
      if (!r)
        by.set(
          sym,
          (r = {
            symbol: sym,
            name: nameOf(sym),
            wallet: 0,
            walletUsd: 0,
            margin: 0,
            marginUsd: 0,
          }),
        );
      return r;
    };
    for (const [sym, raw] of Object.entries(tokenBalances)) {
      const amt = parseFloat(raw) || 0;
      if (amt <= 0) continue;
      const r = row(sym);
      r.wallet = amt;
      r.walletUsd = amt * (p.px[sym] ?? 0);
    }
    for (const c of p.snapshot?.api.margin.collateral ?? []) {
      if (!(c.amount > 0)) continue;
      const r = row(c.symbol);
      r.margin += c.amount;
      r.marginUsd += c.usd;
    }
    const phoenix = p.acct.view?.account.venueValueUsd ?? 0;
    if (phoenix > 0.005)
      by.set("Phoenix", {
        symbol: "Phoenix",
        name: "Phoenix perps account",
        wallet: 0,
        walletUsd: 0,
        margin: 0,
        marginUsd: phoenix,
        valueOnly: true,
      });
    return [...by.values()].sort(
      (a, b) => b.walletUsd + b.marginUsd - (a.walletUsd + a.marginUsd),
    );
  }, [tokenBalances, p.px, p.snapshot, p.acct.view]);

  const walletTotal = rows.reduce((t, r) => t + r.walletUsd, 0);
  const marginTotal = rows.reduce((t, r) => t + r.marginUsd, 0);
  const inView = (r: BalanceRow, v: View) =>
    v === "wallet" ? r.wallet > 0 : r.marginUsd > 0;
  const shown = rows
    .filter(
      (r) =>
        inView(r, view) &&
        (!q || `${r.symbol} ${r.name}`.toLowerCase().includes(q.toLowerCase())),
    )
    // Each view sorts by the value it shows.
    .sort((a, b) =>
      view === "wallet" ? b.walletUsd - a.walletUsd : b.marginUsd - a.marginUsd,
    );
  const amt = (v: number, sym: string) => (v > 0 ? tokFmt(v, sym) : "0");
  const price = (r: BalanceRow) =>
    r.valueOnly
      ? "N/A"
      : (p.px[r.symbol] ?? 0) > 0
        ? usd(p.px[r.symbol])
        : usd(r.margin > 0 ? r.marginUsd / r.margin : 0);
  const token = (r: BalanceRow) => (
    <Ct key="t" desc={r.name !== r.symbol ? r.name : undefined}>
      <Icon sym={r.symbol} className="ico pf-i16" />
      {r.symbol}
    </Ct>
  );
  const tiles: [string, number, string][] = [
    [
      "Wallet",
      walletTotal,
      `${rows.filter((r) => r.wallet > 0).length} tokens`,
    ],
    [
      "Margin account",
      marginTotal,
      `${rows.filter((r) => r.marginUsd > 0).length} holdings · debt not subtracted`,
    ],
    ["Total", walletTotal + marginTotal, `${rows.length} assets`],
  ];

  return (
    <>
      <div className="pf-bal-sum">
        {tiles.map(([k, v, sub]) => (
          <div key={k} className="pf-bal-t">
            <span>{k}</span>
            <b className="num">{usd(v)}</b>
            <small>{sub}</small>
          </div>
        ))}
      </div>
      <section className="pf-tbl">
        <div className="pf-tbar">
          <nav className="pf-seg" role="tablist" aria-label="Balances of">
            {(
              [
                ["wallet", "Wallet"],
                ["margin", "Margin account"],
              ] as [View, string][]
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={view === k}
                className={view === k ? "on" : ""}
                onClick={() => setView(k)}
              >
                {l}
              </button>
            ))}
          </nav>
          <label className="search pf-search">
            {IC.search}
            <input
              placeholder="Search tokens"
              aria-label="Search tokens"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
        </div>
        <Grid
          cols="1.6fr 1.3fr 1fr 1fr"
          heads={[
            "Token",
            view === "wallet" ? "Wallet balance" : "Margin balance",
            "Price",
            "Value",
          ]}
          empty={
            q
              ? "No tokens match"
              : view === "wallet"
                ? "Your wallet holds no tokens yet. Use the Faucet."
                : "Your margin account holds nothing yet."
          }
          rows={shown.map((r) => {
            const bal = view === "wallet" ? r.wallet : r.margin;
            const value = view === "wallet" ? r.walletUsd : r.marginUsd;
            return {
              key: r.symbol,
              cells: [
                token(r),
                <Ct key="b">
                  {r.valueOnly ? "USDC + positions" : amt(bal, r.symbol)}
                </Ct>,
                <Ct key="p">{price(r)}</Ct>,
                <Ct key="v">
                  <b>{usd(value)}</b>
                </Ct>,
              ],
            };
          })}
        />
      </section>
    </>
  );
}
