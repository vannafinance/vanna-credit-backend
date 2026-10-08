"use client";

/**
 * Deposit / Withdraw column of a basis-vault page. The margin balances, debts and borrow APYs it
 * works from are real (account snapshot + Vanna pools); the vault APY and share price are sample
 * data. Deposits are not wired yet (the vault program isn't built), so the button stays disabled
 * with "Deposits open soon" once the amount is valid.
 *
 * Net APY = vault APY − borrow APY of the deposited token × (borrowed part ÷ deposit), where the
 * borrowed part is the smaller of the deposit and the margin account's debt in that token.
 */
import { useState } from "react";
import Image from "next/image";
import { iconPaths } from "@/lib/constants";
import { BASIS_DEPOSIT_TOKENS, SERIES_DAYS, fmtNum, fmtPct, fmtUsd, fmtUsdCompact, type BasisVault } from "@/lib/farm/basis-vaults";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import { Info, SampleDataBadge, useBasisColors } from "./basis-ui";

export interface BasisAccountInputs {
  connected: boolean;
  hasMargin: boolean;
  /** Units of each deposit token sitting in the margin vault. */
  balances: Record<string, number>;
  /** Units of each token the margin account owes. */
  debts: Record<string, number>;
  /** USD price of each token. */
  prices: Record<string, number | null>;
  /** Vanna pool borrow APY (%) of each token. */
  borrowApy: Record<string, number | null>;
}

const PCTS = [10, 25, 50, 100];
const TABS = [
  { id: "deposit", label: "Deposit" },
  { id: "withdraw", label: "Withdraw" },
];
const decimalsOf = (t: string) => (t === "SOL" ? 3 : 2);

export function BasisActionPanel({ vault: v, token, onToken, account }: { vault: BasisVault; token: string; onToken: (t: string) => void; account: BasisAccountInputs }) {
  const c = useBasisColors();
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [pct, setPct] = useState(0);
  const [menu, setMenu] = useState(false);

  const deposit = tab === "deposit";
  const t = deposit ? token : "USDC";
  const units = Number.parseFloat(amount) || 0;
  const price = account.prices[t] ?? (t === "SOL" ? null : 1);
  const usdIn = price === null ? null : units * price;
  const available = deposit ? account.balances[t] ?? 0 : 0; // no vault position until integration
  const borrow = account.borrowApy[t];

  const borrowedPart = Math.min(units, account.debts[t] ?? 0);
  const borrowedShare = units ? borrowedPart / units : 0;
  const netApy = borrow === null || borrow === undefined ? null : v.apy7 - borrow * borrowedShare;
  const perYear = usdIn !== null && netApy !== null ? (usdIn * netApy) / 100 : null;
  const sharesOut = usdIn !== null ? usdIn / v.sharePrice[SERIES_DAYS - 1] : null;

  const applyPct = (p: number) => {
    setPct(p);
    const f = Math.pow(10, decimalsOf(t));
    setAmount(String(Math.floor(((available * p) / 100) * f) / f));
  };

  let cta = "Deposits open soon";
  if (!account.connected) cta = "Connect Wallet";
  else if (!account.hasMargin) cta = "Create a margin account first";
  else if (!deposit) cta = "No position in this vault yet";
  else if (!units) cta = "Enter an amount";
  else if (units > available + 1e-9) cta = `Not enough ${t} in your margin account`;
  else if (usdIn !== null && v.tvl + usdIn > v.cap) cta = "Vault is full";

  const formula = !units
    ? ""
    : borrowedShare > 0 && borrow !== null && borrow !== undefined
      ? `${fmtPct(v.apy7)} vault − ${fmtPct(borrow)} ${t} borrow${borrowedShare < 0.999 ? ` on ${fmtNum(borrowedShare * 100, 0)}% of it` : ""}`
      : `${fmtPct(v.apy7)} vault · own ${t}, no borrow cost`;

  const fieldBg = c.isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]";
  const kv = (k: React.ReactNode, value: React.ReactNode) => (
    <div className="flex justify-between items-center gap-3 text-[12px] py-1">
      <span className={`inline-flex items-center gap-1 ${c.label}`}>{k}</span>
      <span className={`font-semibold text-right ${c.text}`}>{value}</span>
    </div>
  );

  return (
    <>
      <section className={`rounded-2xl border p-4 sm:px-5 flex flex-col gap-3.5 ${c.isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"}`}>
        <AnimatedTabs
          type="border"
          containerClassName={`w-full rounded-xl border p-1 ${c.isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E5E7EB]"}`}
          tabClassName="!flex-1 !px-2 text-[12px]"
          tabs={TABS}
          activeTab={tab}
          onTabChange={(id) => { setTab(id as "deposit" | "withdraw"); setAmount(""); setPct(0); setMenu(false); }}
        />

        <div className={`rounded-xl border ${fieldBg}`}>
          <div className="flex items-center gap-2.5 px-3 pt-3">
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              aria-label="Amount"
              value={amount}
              onChange={(e) => { setAmount(e.target.value.replace(/[^0-9.]/g, "")); setPct(0); }}
              className={`flex-1 min-w-0 bg-transparent outline-none text-[20px] font-semibold tabular-nums placeholder:opacity-20 ${c.text}`}
            />
            <div className="relative shrink-0">
              <button
                type="button"
                disabled={!deposit}
                onClick={() => setMenu((m) => !m)}
                aria-haspopup="listbox"
                className={`inline-flex items-center gap-1.5 rounded-full border pl-1 pr-2 py-1 text-[13px] font-semibold ${fieldBg} ${c.text} ${deposit ? "cursor-pointer" : ""}`}
              >
                <Image src={iconPaths[t] ?? "/coins/default.svg"} alt="" width={22} height={22} className="rounded-full" />
                {t}
                {deposit && <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>}
              </button>
              {deposit && menu && (
                <div role="listbox" className={`absolute right-0 top-[calc(100%+6px)] w-[230px] rounded-xl border p-1 z-20 shadow-xl ${c.isDark ? "bg-[#161616] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"}`}>
                  <p className={`text-[11px] px-2 pt-1.5 pb-1 ${c.label}`}>In your margin account</p>
                  {BASIS_DEPOSIT_TOKENS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => { onToken(k); setMenu(false); setAmount(""); setPct(0); }}
                      className={`w-full flex items-center gap-2 p-2 rounded-lg text-[13px] font-semibold text-left cursor-pointer ${c.text} ${
                        k === t ? (c.isDark ? "bg-[#1E1E1E]" : "bg-[#F5F5F5]") : c.isDark ? "hover:bg-[#1E1E1E]" : "hover:bg-[#F5F5F5]"
                      }`}
                    >
                      <Image src={iconPaths[k] ?? "/coins/default.svg"} alt="" width={22} height={22} className="rounded-full" />
                      {k}
                      <small className={`ml-auto text-[11px] font-medium tabular-nums ${c.label}`}>
                        {fmtNum(account.balances[k] ?? 0, decimalsOf(k))} · {(account.debts[k] ?? 0) > 0 && account.borrowApy[k] != null ? `borrow ${fmtPct(account.borrowApy[k]!)}` : "not borrowed"}
                      </small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className={`text-[12px] px-3 pt-0.5 pb-2 tabular-nums ${c.label}`}>~ {usdIn === null ? "—" : fmtUsd(usdIn)}</div>
          <div className="flex items-center justify-between gap-2 px-3 pb-3 flex-wrap">
            <span className="flex gap-1">
              {PCTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => applyPct(p)}
                  className={`px-2 py-1 rounded-lg text-[10px] font-semibold border cursor-pointer ${
                    pct === p ? "bg-[#703AE6] border-[#703AE6] text-white" : c.isDark ? "bg-[#2A2A2A] border-[#333333] text-[#A7A7A7]" : "bg-[#F0F0F0] border-[#E2E2E2] text-[#888888]"
                  }`}
                >
                  {p}%
                </button>
              ))}
            </span>
            <button type="button" onClick={() => applyPct(100)} className={`text-[11px] underline underline-offset-2 tabular-nums cursor-pointer ${c.label}`}>
              {deposit ? `Margin: ${fmtNum(available, decimalsOf(t))} ${t}` : `Position: ${fmtUsd(0)}`}
            </button>
          </div>
        </div>

        {deposit ? (
          <div>
            <div className={`flex justify-between items-end gap-3 px-3.5 py-3 rounded-xl border tabular-nums ${fieldBg}`}>
              <div className="min-w-0">
                <div className={`flex items-center gap-1 text-[12px] font-medium ${c.label}`}>
                  Net APY <Info label="Net APY" text={`Borrow APY is charged only on the part of this deposit that came from your ${t} loan.`} />
                </div>
                <div className={`text-[22px] font-bold leading-tight ${netApy !== null && netApy < 0 ? c.neg : c.pos}`}>{units && netApy !== null ? fmtPct(netApy) : "—"}</div>
                <div className={`text-[11px] mt-0.5 ${c.label}`}>{formula}</div>
              </div>
              <div className="text-right shrink-0">
                <div className={`text-[12px] font-medium ${c.label}`}>Est. earnings</div>
                <div className={`text-[22px] font-bold leading-tight ${c.text}`}>{units && perYear !== null ? fmtUsd(perYear / 12) : "—"}</div>
                <div className={`text-[11px] mt-0.5 ${c.label}`}>{units && perYear !== null ? `per month · ${fmtUsd(perYear, 0)} a year` : ""}</div>
              </div>
            </div>
            <div className="mt-2">
              {kv("You receive", `${units && sharesOut !== null ? fmtNum(sharesOut, 2) : "0"} ${v.share}`)}
              {kv("Deposit token borrow APY", borrow == null ? "—" : fmtPct(borrow, 2))}
            </div>
            {t === "SOL" && units > 0 && (
              <p className={`text-[11px] leading-[1.45] rounded-[10px] border px-2.5 py-2 mt-2 ${c.warn} ${c.isDark ? "bg-[#DFA24A]/10 border-[#DFA24A]/30" : "bg-[#F59E0B]/10 border-[#F59E0B]/30"}`}>
                Your SOL loan stays open. The vault is priced in USD, so if SOL rises your debt grows and this deposit does not.
              </p>
            )}
          </div>
        ) : (
          <div>
            {kv("You receive", "~ $0.00 USDC")}
            {kv("Burns", `0 ${v.share}`)}
          </div>
        )}

        <button type="button" disabled className={`w-full h-10 rounded-lg text-[13px] font-semibold ${c.isDark ? "bg-[#333333] text-[#888888]" : "bg-[#D4D4D8] text-white"} cursor-not-allowed`}>
          {cta}
        </button>
        <div className="flex justify-center">
          <SampleDataBadge />
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2 tabular-nums">
        {[
          ["Total Value Locked", fmtUsdCompact(v.tvl)],
          ["Vault APY (7D)", fmtPct(v.apy7)],
        ].map(([k, value]) => (
          <div key={k} className={`rounded-xl border p-3 flex flex-col gap-1 min-w-0 ${c.isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"}`}>
            <span className={`text-[12px] font-medium ${c.isDark ? "text-[#888888]" : "text-[#777777]"}`}>{k}</span>
            <span className={`text-[20px] font-bold leading-tight ${c.text}`}>{value}</span>
          </div>
        ))}
      </div>

      <div className={`rounded-xl border overflow-hidden tabular-nums ${c.line}`}>
        {[
          ["Your Position", "—"],
          ["Earnings", "—"],
          ["Receipt", v.share],
        ].map(([k, value], i) => (
          <div key={k} className={`flex justify-between px-3.5 py-2.5 text-[12px] ${i === 2 ? (c.isDark ? "bg-[#161616]" : "bg-[#F2F2F2]") : c.isDark ? "bg-[#1A1A1A]" : "bg-[#F7F7F7]"}`}>
            <span className={`font-medium ${c.label}`}>{k}</span>
            <span className={`font-semibold ${c.text}`}>{value}</span>
          </div>
        ))}
      </div>

      <div className={`rounded-2xl border p-4 flex flex-col gap-3 ${c.isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]"}`}>
        <p className={`text-[13px] font-semibold ${c.text}`}>How it works</p>
        {[
          ["Borrow on Margin", "Against any collateral Vanna accepts."],
          ["Deposit", "USDC, USDT or SOL from your margin account."],
          ["Vault hedges", "Spot on Jupiter, an equal 1x short on Phoenix."],
          ["Earn funding", "Shares count toward your health factor."],
        ].map(([title, desc], i) => (
          <div key={title} className="flex gap-3 items-start">
            <div className="w-6 h-6 rounded-full bg-[#703AE6]/10 flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-[11px] font-bold text-[#703AE6]">{i + 1}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <p className={`text-[12px] font-semibold ${c.text}`}>{title}</p>
              <p className={`text-[11px] font-medium ${c.isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>{desc}</p>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
