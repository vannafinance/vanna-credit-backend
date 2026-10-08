"use client";

/**
 * "Transfer Collateral" tab (V3 design): move a token between the wallet and the margin account.
 * MB = wallet → margin (`depositAndBorrow({ deposits, createIfMissing })`, creates the account in the
 * same transaction if needed); WB = margin → wallet (`user_withdraw_collateral`, health-checked
 * on-chain).
 *
 * Two caps, as before: the source balance (wallet SOL keeps the 0.05 SOL fee reserve) and, for a
 * withdrawal, the safe limit — the most that keeps HF ≥ 1.15 in the program-exact account model.
 * Max / 100% of a debt-free vault withdraws everything (`all: true`, to the last base unit).
 */
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Info } from "@/components/v3/ui";
import { Icon, IC } from "@/components/v3/icons";
import { hfFmt, nf, usd } from "@/components/v3/format";
import { FlashRepayButton } from "@/components/v3/flash-repay";
import { LIQ_HF, SAFE_HF, WARN_HF, healthFactor } from "@/lib/account-model";
import { CollateralDropdownOptions, DropdownOptions } from "@/lib/constants";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { floorTo, spendableWalletAmount, tokenDecimals, toTokenAmountString } from "@/lib/margin/amounts";
import { useDepositAndBorrow, useWithdrawCollateral } from "@/hooks/use-margin";
import { accountNumbers, liqBuffer, maxWithdrawUsd, noDebt, withDeposits, withWithdraw } from "./mg-sim";
import { PctChips, PrevBox, PrevRow, RatioBtn, TIPS, TokenDropdown, toneHf, usePop } from "./mg-ui";
import type { MarginScreen } from "./use-margin-screen";

const EPS = 1e-9;
const fmtA = (v: number, sym: string) => v.toLocaleString("en-US", { maximumFractionDigits: Math.min(6, tokenDecimals(sym)) });

export function TransferTab({ m, flashable }: { m: MarginScreen; flashable: boolean }) {
  const pop = usePop();
  const [sym, setSym] = useState<string>(CollateralDropdownOptions[0]);
  const [dir, setDir] = useState<"MB" | "WB">("MB");
  const [input, setInput] = useState("");
  const [pct, setPct] = useState(0);
  // True when the WB amount came from Max / 100% on a debt-free account — sent as `all: true`.
  const [all, setAll] = useState(false);
  const dep = useDepositAndBorrow();
  const wd = useWithdrawCollateral();
  const pending = dep.isPending || wd.isPending;

  // Reset on wallet disconnect so the previous wallet's figures don't linger.
  useEffect(() => {
    if (!m.address) {
      setInput("");
      setPct(0);
      setAll(false);
    }
  }, [m.address]);

  const price = m.prices[sym] ?? 0;
  const wallet = m.wbal(sym);
  const vault = m.vault(sym);
  const hasDebt = !noDebt(m.now);
  const srcBal = dir === "MB" ? wallet : vault;
  const maxT = dir === "MB" ? spendableWalletAmount(sym, wallet) : vault;
  // Safe withdraw limit in tokens (HF stays ≥ 1.15), floored to the token's decimals, ≤ vault.
  const maxW =
    dir === "WB"
      ? !hasDebt
        ? vault
        : price > 0
          ? floorTo(Math.min(vault, maxWithdrawUsd(m.model, sym, vault * price) / price), tokenDecimals(sym))
          : 0
      : maxT;
  const amt = parseFloat(input) || 0;
  const over = amt > srcBal + EPS;
  const x = Math.min(amt, dir === "MB" ? wallet : vault) * price;
  const afterState = dir === "MB" ? withDeposits(m.model, [{ symbol: sym, usd: x }]) : withWithdraw(m.model, { symbol: sym, usd: x });
  const hfAfter = healthFactor(afterState);
  const wb = dir === "WB" && amt > 0 && hasDebt;
  const belowLiq = wb && hfAfter <= LIQ_HF;
  const belowSafe = wb && hfAfter < SAFE_HF;
  const warn = wb && hfAfter >= SAFE_HF && hfAfter < WARN_HF;

  const pick = (p: number) => {
    setPct(p);
    const base = dir === "WB" ? maxW : maxT;
    setAll(dir === "WB" && p === 100 && !hasDebt);
    setInput(toTokenAmountString((base * p) / 100, sym));
  };
  const max = () => {
    setAll(dir === "WB" && !hasDebt);
    setInput(toTokenAmountString(dir === "WB" ? maxW : maxT, sym));
  };
  const clear = () => {
    setInput("");
    setPct(0);
    setAll(false);
  };

  const go = async () => {
    if (!(amt > 0)) return void toast.error("Please enter a valid amount");
    if (over) return void toast.error("Insufficient balance for selected transfer mode");
    if (dir === "MB" && amt > maxT + EPS) return void toast.error(`You cannot transfer all your wallet ${sym}. Keep at least 0.05 SOL in your wallet for fees.`);
    if (dir === "WB" && amt > maxW + EPS) {
      const safe = `${toTokenAmountString(maxW, sym) || "0"} ${sym}`;
      toast.error(
        !hasDebt
          ? `Max transferable right now: ${safe}.`
          : maxW > 0
            ? `Unsafe withdrawal for current debt/health factor. Max you can transfer now: ${safe}.`
            : "Unsafe withdrawal for current debt/health factor. Repay some debt first.",
      );
      return;
    }
    try {
      if (dir === "MB") await dep.mutateAsync({ deposits: [{ symbol: sym, amount: toTokenAmountString(amt, sym) }], createIfMissing: true });
      else await wd.mutateAsync(all ? { symbol: sym, all: true } : { symbol: sym, amount: toTokenAmountString(amt, sym) });
      clear();
    } catch {
      // The progress modal already shows the decoded error; the entered amount is kept.
    }
  };

  const b = m.now;
  const a = accountNumbers(afterState);
  const nd = noDebt(b);

  return (
    <div className="mg-trn">
      <article className="mg-cc">
        <div className="mg-r">
          <span className="mg-lbl">Transfer</span>
          <PctChips value={pct} label="Transfer percentage" onPick={pick} />
        </div>
        <div className="mg-r">
          {/* MB deposits offer only depositable tokens; WB withdraws any token the margin holds. */}
          <TokenDropdown
            id="tr"
            sym={sym}
            list={dir === "MB" ? CollateralDropdownOptions : DropdownOptions}
            pop={pop}
            onPick={(s) => {
              setSym(s);
              clear();
            }}
          />
          <input
            className="mg-amt num"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={input}
            aria-label="Transfer amount"
            onChange={(e) => {
              const v = validateAmountChange(e.target.value);
              if (v === null) return;
              setAll(false);
              setPct(0);
              setInput(v);
            }}
          />
        </div>
        <div className="mg-r mg-trow">
          <div className="mg-bl">
            <span className="mg-sub">
              Transfer To: <b>{dir === "MB" ? "Margin Account" : "Wallet"}</b>
            </span>
            <button type="button" className="mg-maxc" onClick={max}>
              Max
            </button>
            <RatioBtn sym={sym} price={price} />
          </div>
          <span className="mg-srcb">
            <Icon sym={sym} className="ico mg-sbi" />
            <b className="num">
              {fmtA(maxT, sym)} {sym}
            </b>
            <span className="mg-usdr num">~ {nf(maxT * price, 2)} USD</span>
          </span>
        </div>
        <div className="mg-r start">
          <span className="mg-seg lg" role="group" aria-label="Direction">
            {(["WB", "MB"] as const).map((d) => (
              <button
                key={d}
                type="button"
                className={dir === d ? "on" : ""}
                aria-pressed={dir === d}
                aria-label={d === "WB" ? "Transfer to your wallet" : "Transfer to your margin account"}
                onClick={() => {
                  setDir(d);
                  if (d === "MB" && !CollateralDropdownOptions.includes(sym)) setSym(CollateralDropdownOptions[0]);
                  clear();
                }}
              >
                {d}
              </button>
            ))}
          </span>
          <Info text="WB moves the token from your margin account to your wallet; MB moves it from your wallet into your margin account." />
        </div>
      </article>

      {m.connected && amt > 0 && (
        <PrevBox flush>
          <PrevRow label="Margin Collateral" b={usd(b.holdings)} a={usd(a.holdings)} tone={dir === "MB" ? "up" : "dn"} tip={TIPS.value} />
          <PrevRow label="Health Factor" b={hfFmt(b.hf)} a={hfFmt(a.hf)} tone={nd ? "" : toneHf(b.hf, a.hf)} tip={TIPS.hf} />
          <PrevRow
            label="Liquidation Buffer"
            b={nd ? undefined : usd(liqBuffer(b))}
            a={nd ? "N/A, no debt" : usd(liqBuffer(a))}
            tone={nd ? "" : liqBuffer(a) >= liqBuffer(b) ? "up" : "dn"}
            tip={TIPS.buffer}
          />
        </PrevBox>
      )}

      <section>
        {belowLiq ? (
          <div className="mg-rd" role="alert">
            {IC.warn}
            <span>This withdrawal would drop your Health Factor to {hfFmt(hfAfter)} (at or below 1.10). Reduce the amount or repay some debt first.</span>
          </div>
        ) : (
          warn && (
            <div className="mg-am mg-wn" role="status">
              <span>
                Health factor after this: {hfFmt(hfAfter)}, close to the {nf(SAFE_HF, 2)} limit.
              </span>
            </div>
          )
        )}
        <button
          type="button"
          className="mg-btn"
          disabled={!(amt > 0) || pending || (!m.hasAccount && dir === "WB") || over || belowSafe || !m.connected}
          onClick={() => void go()}
        >
          {pending ? "Processing..." : belowSafe ? `Health factor would fall below ${nf(SAFE_HF, 2)}` : "Transfer"}
        </button>
        {m.connected && <FlashRepayButton transfer label="Flash transfer all to wallet" className="mg-fbtn w" disabled={!flashable} />}
      </section>
    </div>
  );
}
