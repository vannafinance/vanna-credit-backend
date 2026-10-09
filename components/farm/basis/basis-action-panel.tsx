"use client";

/**
 * Deposit / Withdraw column of a basis-vault page (the design's `dnAside`). The margin balances,
 * debts, borrow APYs and health factor it works from are real (account snapshot + Vanna pools +
 * `useV3Account`); the vault APY, TVL and share price are sample data. Nothing is sent: the vault
 * program isn't built, so the button stays disabled ("Coming soon") whatever the amount.
 *
 * Net APY = vault APY − borrow APY of the deposited token × (borrowed part ÷ deposit), where the
 * borrowed part is the smaller of the deposit and the margin account's debt in that token.
 */
import { useState } from "react";
import { BASIS_DEPOSIT_TOKENS, SERIES_DAYS, type BasisVault } from "@/lib/farm/basis-vaults";
import { Icon, IC } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { hfFmt, nf, pct, usd, usdC } from "@/components/v3/format";
import { hfZone } from "@/lib/account-model";
import { HowItWorks, PreviewBadge, TabsBox, Tiles, YieldList, useOutside } from "../fm-ui";

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
  /** The margin account's health factor (program-exact), null without a margin account. */
  hf: number | null;
}

const decimalsOf = (t: string) => (t === "SOL" ? 4 : 2);

export function BasisActionPanel({ vault: v, token, onToken, account }: { vault: BasisVault; token: string; onToken: (t: string) => void; account: BasisAccountInputs }) {
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [pctOn, setPctOn] = useState(0);
  const [menu, setMenu] = useState(false);
  const menuRef = useOutside(menu, () => setMenu(false));

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
    setPctOn(p);
    const f = Math.pow(10, decimalsOf(t));
    const a = Math.floor(((available * p) / 100) * f) / f;
    setAmount(a ? String(a) : "");
  };

  let note = "";
  if (!account.connected) note = "Connect a wallet to see your margin balances.";
  else if (!account.hasMargin) note = "Create a margin account first.";
  else if (deposit && units > available + 1e-9) note = `Not enough ${t} in your margin account.`;
  else if (deposit && usdIn !== null && v.tvl + usdIn > v.cap) note = "Vault is full.";

  const formula = !units
    ? ""
    : borrowedShare > 0 && borrow !== null && borrow !== undefined
      ? `${pct(v.apy7, 1)} vault − ${pct(borrow, 1)} ${t} borrow${borrowedShare < 0.999 ? ` on ${nf(borrowedShare * 100, 0)}% of it` : ""}`
      : `${pct(v.apy7, 1)} vault · own ${t}, no borrow cost`;

  return (
    <>
      <section className="fm-act">
        <TabsBox
          items={[
            ["deposit", "Deposit"],
            ["withdraw", "Withdraw"],
          ]}
          value={tab}
          onChange={(id) => {
            setTab(id);
            setAmount("");
            setPctOn(0);
            setMenu(false);
          }}
        />
        <div className="fm-amt">
          <div className="fm-amt-t">
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              aria-label="Amount"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^0-9.]/g, ""));
                setPctOn(0);
              }}
            />
            <span className="fm-tokw" ref={menuRef}>
              <button type="button" className="fm-tokb" disabled={!deposit} aria-haspopup="listbox" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
                <Icon sym={t} className="fm-ico22" />
                {t}
                {deposit && IC.chev}
              </button>
              {deposit && menu && (
                <div className="pop r fm-tokm" role="listbox">
                  <p>In your margin account</p>
                  {BASIS_DEPOSIT_TOKENS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={k === t ? "on" : ""}
                      onClick={() => {
                        onToken(k);
                        setMenu(false);
                        setAmount("");
                        setPctOn(0);
                      }}
                    >
                      <Icon sym={k} className="fm-ico22" />
                      {k}
                      <small className="num">
                        {nf(account.balances[k] ?? 0, decimalsOf(k))} · {(account.debts[k] ?? 0) > 0 && account.borrowApy[k] != null ? `borrow ${pct(account.borrowApy[k]!)}` : "not borrowed"}
                      </small>
                    </button>
                  ))}
                </div>
              )}
            </span>
          </div>
          <div className="fm-amt-u num">~ {usd(usdIn ?? 0)}</div>
          <div className="fm-amt-f">
            <span className="fm-pcs">
              {[10, 25, 50, 100].map((p) => (
                <button key={p} type="button" className={pctOn === p ? "on" : ""} onClick={() => applyPct(p)}>
                  {p}%
                </button>
              ))}
            </span>
            <button type="button" className="fm-maxl num" onClick={() => applyPct(100)}>
              {deposit ? `Margin: ${available > 0 ? nf(available, decimalsOf(t)) : "0"} ${t}` : `Position: ${usd(0)}`}
            </button>
          </div>
        </div>

        {deposit ? (
          <div>
            <div className="fm-net num">
              <div>
                <div className="lbl">
                  Net APY <Info text={`Borrow APY is charged only on the part of this deposit that came from your ${t} loan.`} />
                </div>
                <div className={`big ${units && netApy !== null && netApy < 0 ? "n" : ""}`}>{pct(units && netApy !== null ? netApy : 0, 1)}</div>
                <div className="f">{formula}</div>
              </div>
              <div className="r">
                <div className="lbl">Est. earnings</div>
                <div className="big">{usd(units && perYear !== null ? perYear / 12 : 0)}</div>
                <div className="f">{units && perYear !== null ? `per month · ${usd(perYear, 0)} a year` : ""}</div>
              </div>
            </div>
            <div className="fm-kvs num">
              <div className="kv">
                <span>You receive</span>
                <span>
                  {units && sharesOut !== null ? nf(sharesOut, 2) : "0"} {v.share}
                </span>
              </div>
              <div className="kv">
                <span>Deposit token borrow APY</span>
                <span>{pct(borrow ?? 0, 2)}</span>
              </div>
              {account.hf !== null && (
                <div className="kv">
                  <span>Net Health Factor</span>
                  <span className={hfZone(account.hf)}>{hfFmt(account.hf)}</span>
                </div>
              )}
            </div>
            {t === "SOL" && units > 0 && <p className="fm-warnn">Your SOL loan stays open. The vault is priced in USD, so if SOL rises your debt grows and this deposit does not.</p>}
          </div>
        ) : (
          <div className="fm-kvs num">
            <div className="kv">
              <span>You receive</span>
              <span>~ $0.00 USDC</span>
            </div>
            <div className="kv">
              <span>Burns</span>
              <span>0 {v.share}</span>
            </div>
          </div>
        )}
        {note && <div className="fm-note">{note}</div>}
        <button type="button" className="fm-cta" disabled>
          Coming soon
        </button>
        <p className="fm-dnnote">
          <PreviewBadge /> No transaction is sent — deposits open when the vault program ships.
        </p>
      </section>
      <Tiles
        items={[
          ["Total Value Locked", usdC(v.tvl)],
          ["Vault APY (7D)", pct(v.apy7, 1)],
        ]}
      />
      <YieldList
        rows={[
          ["Your Position", usd(0)],
          ["Earnings", usd(0)],
          ["Receipt", v.share],
        ]}
      />
      <HowItWorks
        steps={[
          ["Borrow on Margin", "Against any collateral Vanna accepts."],
          ["Deposit", "USDC, USDT or SOL from your margin account."],
          ["Vault hedges", "Spot on Jupiter, an equal 1x short on Phoenix."],
          ["Earn funding", "Shares count toward your health factor."],
        ]}
      />
    </>
  );
}
