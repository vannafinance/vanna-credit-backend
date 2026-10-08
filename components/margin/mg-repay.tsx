"use client";

/**
 * "Repay Loan" tab (V3 design). Shows the true on-chain debt of the chosen asset (accrued to
 * fork-now) next to the balance of the chosen SOURCE, a form with quick-% chips, the before → after
 * preview and Pay Now; plus Flash repay entry points (close positions and repay every loan).
 *
 * Same rules as before (`checkRepaySource`, `useRepay`): MB repays from the margin vault
 * (`user_repay_from_margin`), WB from the wallet (`public_repay_from_wallet`). The 100% chip is a
 * FULL repay (`repay_all`, closes the debt position): the source must then hold debt + 0.2% accrual
 * buffer. Borrowed tokens in the vault are usually slightly less than the accrued debt, so a full
 * repay from margin is often short — the tab says so and offers the wallet instead.
 */
import { useEffect, useMemo, useState } from "react";
import { Info } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { hfFmt, tokFmt, usd } from "@/components/v3/format";
import { FlashRepayButton } from "@/components/v3/flash-repay";
import { BorrowDropdownOptions } from "@/lib/constants";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { findToken } from "@/lib/solana/tokens";
import { accruedInterestBySymbol, checkRepaySource, spendableWalletAmount, toTokenAmountString } from "@/lib/margin/amounts";
import { useMarginHistory, useRepay } from "@/hooks/use-margin";
import { accountNumbers, liqBuffer, noDebt, withRepay } from "./mg-sim";
import { PctChips, PrevBox, PrevRow, RatioBtn, TIPS, TokenDropdown, toneHf, usePop } from "./mg-ui";
import type { MarginScreen } from "./use-margin-screen";

/** "<$0.01" for sub-cent non-zero values, "$0.00" for zero. */
const usdL = (v: number) => (!(v > 0) ? "$0.00" : v < 0.01 ? "<$0.01" : usd(v));

export function RepayTab({ m, prefill, flashable }: { m: MarginScreen; prefill?: { sym: string; n: number }; flashable: boolean }) {
  const pop = usePop();
  const firstDebt = m.snap?.debts.find((d) => d.debt > 0)?.symbol;
  const [sym, setSym] = useState<string>(() => findToken(prefill?.sym)?.symbol ?? firstDebt ?? BorrowDropdownOptions[0]);
  const [input, setInput] = useState("");
  const [pct, setPct] = useState(0);
  const [src, setSrc] = useState<"margin" | "wallet">("margin");
  const mutation = useRepay();

  // A positions-row Repay click / Portfolio's ?repay= hand-off preselects that asset.
  useEffect(() => {
    const s = findToken(prefill?.sym)?.symbol;
    if (s) {
      setSym(s);
      setInput("");
      setPct(0);
    }
  }, [prefill?.sym, prefill?.n]);

  // Once debts load, default to the first asset that actually has one.
  const [touched, setTouched] = useState(Boolean(prefill));
  useEffect(() => {
    if (!touched && firstDebt) setSym(firstDebt);
  }, [firstDebt, touched]);

  // Reset on wallet disconnect so the previous user's figures don't linger.
  useEffect(() => {
    if (!m.address) {
      setInput("");
      setPct(0);
    }
  }, [m.address]);

  // Repayable = the borrowable tokens, plus any other asset that still carries debt.
  const options = useMemo(
    () => [...BorrowDropdownOptions, ...(m.snap?.debts ?? []).filter((d) => d.debt > 0 && !BorrowDropdownOptions.includes(d.symbol)).map((d) => d.symbol)],
    [m.snap],
  );

  const price = m.prices[sym] ?? 0;
  const debt = m.debt(sym);
  const vault = m.vault(sym);
  const wallet = m.wbal(sym);
  const srcBal = src === "margin" ? vault : spendableWalletAmount(sym, wallet);
  const amt = parseFloat(input) || 0;
  const full = pct === 100 || (debt > 0 && amt >= debt);
  const check = checkRepaySource({ symbol: sym, source: src, all: full, amount: amt, debt, vaultAmount: vault, walletAmount: wallet });
  const short = amt > 0 && !check.ok;

  // Interest accrued since this debt position opened, from decoded on-chain events (null = unknown).
  const { rows: hist, isLoading: histLoading } = useMarginHistory();
  const accrued = useMemo(
    () => (histLoading || !(debt > 0) ? null : (accruedInterestBySymbol(hist, { [sym]: debt })[sym] ?? null)),
    [hist, histLoading, debt, sym],
  );
  const debtTip =
    debt > 0
      ? accrued !== null
        ? `You owe ${tokFmt(debt, sym)} on this loan, including about ${tokFmt(accrued, sym)} (${usdL(accrued * price)}) of interest accrued so far.`
        : `You owe ${tokFmt(debt, sym)} on this loan. The principal / interest split is unavailable: the transaction that opened it is outside the scanned on-chain history.`
      : `You have no ${sym} loan to repay.`;

  const pick = (p: number) => {
    setPct(p);
    // 10/25/50% are fractions of the TRUE debt, capped to the source; 100% is a full repay (never capped).
    if (p === 100) return setInput(toTokenAmountString(debt, sym) || "");
    setInput(toTokenAmountString(Math.min((debt * p) / 100, srcBal), sym));
  };
  const changeSrc = (s: "margin" | "wallet") => {
    setSrc(s);
    // A partial chip amount was capped to the old source's balance — recompute it.
    if (pct > 0 && pct < 100) {
      setInput("");
      setPct(0);
    }
  };
  const pay = async () => {
    if (!(amt > 0) || !check.ok) return;
    try {
      await mutation.mutateAsync(full ? { symbol: sym, all: true, source: src } : { symbol: sym, amount: toTokenAmountString(amt, sym), source: src });
      setInput("");
      setPct(0);
    } catch {
      // The progress modal already shows the decoded error (useRepay).
    }
  };

  // Preview — never for a repay that cannot happen.
  const b = m.now;
  const x = full ? debt : Math.min(amt, debt);
  const a = accountNumbers(withRepay(m.model, { symbol: sym, usd: x * price }, src));
  const showPrev = m.connected && (amt > 0 || full) && b.debt > 0 && debt > 0 && check.ok;

  const tile = (k: string, tip: string, v: number) => (
    <article className="mg-tile">
      <span className="mg-tk">
        {k} <Info text={tip} />
      </span>
      <span className="mg-tv num">
        <Icon sym={sym} className="ico mg-tvi" />
        {tokFmt(v, sym)}
      </span>
      {price > 0 && <span className="mg-sub num">~ {usdL(v * price)}</span>}
    </article>
  );

  return (
    <div className="mg-rep">
      <div className="mg-rep-in">
        <section className="mg-tiles">
          {tile("Net Outstanding Amount to Repay", debtTip, debt)}
          {tile(
            src === "margin" ? "Available Balance in Margin Account" : "Available Balance in Wallet",
            src === "margin" ? TIPS.avail : "Selected asset in your connected wallet. SOL keeps 0.05 SOL for fees.",
            srcBal,
          )}
        </section>
        <article className="mg-cc">
          <div className="mg-r">
            <span className="mg-lbl">Repay</span>
            <PctChips value={pct} label="Repay percentage" onPick={pick} />
          </div>
          <div className="mg-r">
            <TokenDropdown
              id="rep"
              sym={sym}
              list={options}
              pop={pop}
              onPick={(s) => {
                setTouched(true);
                setSym(s);
                setInput("");
                setPct(0);
              }}
            />
            <input
              className="mg-amt num"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={input}
              aria-label="Repay amount"
              onChange={(e) => {
                const v = validateAmountChange(e.target.value);
                if (v === null) return;
                // A chip only fills the field; once edited, the typed amount is authoritative.
                setPct(0);
                setInput(v);
              }}
            />
          </div>
          <div className="mg-r">
            <RatioBtn sym={sym} price={price} />
            <span className="mg-usdr num" aria-live="polite">
              ~ {usdL(amt * price)}
            </span>
          </div>
          <div className="mg-r">
            <span className="mg-sub mg-inl">
              Repay From: <b>{src === "margin" ? "Margin Account" : "Wallet"}</b>
              <Info text="WB repays from your wallet; MB repays from your margin account's vault." />
            </span>
            <span className="mg-seg lg" role="group" aria-label="Repay source">
              <button type="button" className={src === "wallet" ? "on" : ""} aria-pressed={src === "wallet"} aria-label="Repay from wallet balance" onClick={() => changeSrc("wallet")}>
                WB
              </button>
              <button type="button" className={src === "margin" ? "on" : ""} aria-pressed={src === "margin"} aria-label="Repay from margin balance" onClick={() => changeSrc("margin")}>
                MB
              </button>
            </span>
          </div>
        </article>

        {short && check.reason && (
          <div className="mg-am" role="status">
            <span>{check.reason}</span>
            <span className="mg-am-a">
              {src === "margin" && (
                <button type="button" onClick={() => changeSrc("wallet")}>
                  Repay from wallet instead
                </button>
              )}
              <FlashRepayButton className="o">Flash repay: close positions and repay</FlashRepayButton>
            </span>
          </div>
        )}

        {showPrev && (
          <PrevBox flush>
            <PrevRow label="Outstanding Debt" b={usd(b.debt)} a={usd(a.debt)} tone="up" />
            {src === "margin" && <PrevRow label="Margin Collateral" b={usd(b.holdings)} a={usd(a.holdings)} tone="dn" tip={TIPS.value} />}
            <PrevRow label="Health Factor" b={hfFmt(b.hf)} a={hfFmt(a.hf)} tone={toneHf(b.hf, a.hf)} tip={TIPS.hf} />
            <PrevRow
              label="Liquidation Buffer"
              b={usd(liqBuffer(b))}
              a={noDebt(a) ? "N/A, no debt" : usd(liqBuffer(a))}
              tone={noDebt(a) || liqBuffer(a) >= liqBuffer(b) ? "up" : "dn"}
              tip={TIPS.buffer}
            />
          </PrevBox>
        )}

        <section>
          <button
            type="button"
            className="mg-btn"
            disabled={!(amt > 0) || mutation.isPending || !m.hasAccount || !(debt > 0) || short}
            onClick={() => void pay()}
          >
            {mutation.isPending ? "Processing..." : short ? "Insufficient Balance" : "Pay Now"}
          </button>
          {m.connected && <FlashRepayButton label="Flash repay all loans" className="mg-fbtn w" disabled={!flashable} />}
        </section>
      </div>
    </div>
  );
}
