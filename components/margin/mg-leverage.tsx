"use client";

/**
 * "Leverage your Assets" tab (V3 design): deposit one or more collaterals from the wallet (WB) or
 * size against collateral already in the margin account (MB, single row, borrow-only), borrow one
 * asset or two (dual borrow), pick the leverage, preview the account before → after, submit.
 *
 * Submission is unchanged from the previous screen: every deposit row and every borrow go out in
 * ONE transaction (`useDepositAndBorrow` → `depositAndBorrow({ deposits, borrows })`); MB sends the
 * borrows only; without a margin account the CTA opens the create-account agreement.
 *
 * Limits come from the program-exact account model (./mg-sim): the safe borrow limit is the largest
 * borrow that keeps HF ≥ 1.15 after the deposit, the slider max = 1 + limit / deposit (floored to
 * 2 dp, capped at 20x; 7.66x for a fresh account before anything is entered), and Max = deposit ×
 * (leverage − 1). Borrowed tokens land in the vault and count as collateral.
 */
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Info } from "@/components/v3/ui";
import { Icon } from "@/components/v3/icons";
import { hfFmt, levFmt, nf, usd } from "@/components/v3/format";
import { SAFE_HF, WARN_HF, healthFactor } from "@/lib/account-model";
import { CollateralDropdownOptions, BorrowDropdownOptions } from "@/lib/constants";
import { validateAmountChange, floorAmountToInput } from "@/lib/utils/sanitize-amount";
import { FRESH_ACCOUNT_MAX_LEVERAGE, LEVERAGE_SLIDER_CAP, floorTo, spendableWalletAmount, splitBorrowUsd, toTokenAmountString } from "@/lib/margin/amounts";
import { refreshMarginAccount } from "@/store/margin-account-info-store";
import { useDepositAndBorrow } from "@/hooks/use-margin";
import { accountNumbers, liqBuffer, maxBorrowUsd, withBorrows, withDeposits, type Move } from "./mg-sim";
import { LevSlider, MI, PctChips, PrevBox, PrevRow, RatioBtn, TIPS, TokenDropdown, toneHf, usePop } from "./mg-ui";
import { CreateAccountModal } from "./mg-create-account";
import type { MarginScreen } from "./use-margin-screen";

/** Tolerance for comparing typed amounts against balances (float noise). */
const EPS = 1e-9;

interface Row {
  id: string;
  sym: string;
  amt: string;
  src: "wb" | "mb";
  pct: number;
}
let seq = 0;
const newRow = (): Row => ({ id: `r${++seq}`, sym: CollateralDropdownOptions[0], amt: "", src: "wb", pct: 0 });
const num = (s: string) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

export function LeverageTab({ m, connectWallet }: { m: MarginScreen; connectWallet: () => void }) {
  const pop = usePop();
  // The first row's id is fixed so server and client render the same markup (the counter only
  // numbers rows added later, which happens in the browser).
  const [rows, setRows] = useState<Row[]>(() => [{ ...newRow(), id: "r0" }]);
  const [editId, setEditId] = useState<string | null>(() => rows[0].id);
  // The row as it was before editing started (Cancel restores it; null = a newly added row).
  const [backup, setBackup] = useState<Row | null>(null);
  const [dual, setDual] = useState(false);
  const [bTok, setBTok] = useState<[string, string]>([BorrowDropdownOptions[1] ?? BorrowDropdownOptions[0], BorrowDropdownOptions[0]]);
  // Typed borrow amounts; null = follow the leverage (auto-fill).
  const [bManual, setBManual] = useState<[string, string] | null>(null);
  const [lev, setLev] = useState(2);
  const [creating, setCreating] = useState(false);
  const mutation = useDepositAndBorrow();
  const busy = mutation.isPending;

  const { prices, model, now, hasAccount, address } = m;
  const px = (s: string) => prices[s] ?? 0;
  const mb = rows.length === 1 && rows[0].src === "mb";
  const rowBal = (r: Row) => (r.src === "mb" ? m.vault(r.sym) : m.wbal(r.sym));

  // Entering MB with nothing loaded yet → pull the margin balances so the row's Balance / % fill in.
  useEffect(() => {
    if (mb && address && !m.snap) refreshMarginAccount(address).catch(() => {});
  }, [mb, address, m.snap]);

  // ---- derived state (the design's levState) ----
  const st = useMemo(() => {
    const depUsd = rows.reduce((t, r) => t + num(r.amt) * px(r.sym), 0);
    const deps: Move[] = mb ? [] : rows.filter((r) => num(r.amt) > 0).map((r) => ({ symbol: r.sym, usd: num(r.amt) * px(r.sym) }));
    const n = dual ? 2 : 1;
    const syms = bTok.slice(0, n);
    const accMax = depUsd > 0 ? maxBorrowUsd(model, deps, syms) : Infinity;
    const max = depUsd > 0 ? Math.max(1, Math.min(LEVERAGE_SLIDER_CAP, floorTo(1 + accMax / depUsd, 2) || 1)) : FRESH_ACCOUNT_MAX_LEVERAGE;
    const levE = Math.max(1, Math.min(lev, max));
    const maxUsd = Math.max(0, depUsd * (levE - 1));
    const auto = splitBorrowUsd(maxUsd, syms, prices).map((x) => x.amount);
    const shown = syms.map((_, i) => (bManual ? bManual[i] : auto[i]) ?? "");
    const items = syms.map((sym, i) => ({ sym, amt: num(shown[i]), usd: num(shown[i]) * px(sym) }));
    const totalUsd = items.reduce((t, x) => t + x.usd, 0);
    const dup = n === 2 && bTok[0] === bTok[1];
    let error: string | null = null;
    let exceeds = false;
    let safeErr = false;
    if (totalUsd > 0 && depUsd <= 0) error = "Add collateral before borrowing.";
    else if (dup) error = "Pick two different assets to borrow.";
    // 1-cent tolerance: the auto-fill targets exactly Max and USD rounding can land a hair above it.
    else if (totalUsd > maxUsd + 0.01) {
      error = `Total borrow ${usd(totalUsd)} exceeds your limit of ${usd(maxUsd)}. Lower an amount or raise leverage.`;
      exceeds = true;
    } else if (totalUsd > accMax + 0.01) {
      error = `Total borrow ${usd(totalUsd)} exceeds your account's safe borrow limit of ${usd(accMax)} (Health Factor must stay above ${nf(SAFE_HF, 2)}).`;
      exceeds = true;
      safeErr = true;
    }
    const borrows = levE > 1 ? items.filter((x) => x.amt > 0) : [];
    const after = withBorrows(withDeposits(model, deps), borrows.map((b) => ({ symbol: b.sym, usd: b.usd })));
    const afterN = accountNumbers(after);
    return { depUsd, deps, n, syms, accMax, max, levE, maxUsd, shown, items, totalUsd, dup, error, exceeds, safeErr, borrows, afterN, afterHf: healthFactor(after) };
    // px reads `prices`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, mb, dual, bTok, bManual, lev, model, prices]);

  // Keep the chosen leverage inside the (input-dependent) safe max.
  useEffect(() => {
    if (lev > st.max) setLev(st.max);
  }, [lev, st.max]);

  // ---- handlers ----
  const auto = () => setBManual(null); // a driving input changed → borrow follows the leverage again
  const patch = (id: string, p: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
    auto();
  };
  const setSrc = (id: string, src: Row["src"]) => {
    // MB is single-collateral: it clears every other row; WB drops any MB row.
    setRows((rs) => (src === "mb" ? rs.filter((r) => r.id === id) : rs.filter((r) => r.id === id || r.src !== "mb")).map((r) => (r.id === id ? { ...r, src, pct: 0 } : r)));
    setEditId(id);
    auto();
  };
  const pickPct = (r: Row, p: number) => {
    const bal = r.src === "wb" ? spendableWalletAmount(r.sym, m.wbal(r.sym)) : m.vault(r.sym);
    patch(r.id, { pct: p, amt: floorAmountToInput((bal * p) / 100) });
  };
  const onAmt = (r: Row, raw: string) => {
    const v = validateAmountChange(raw);
    if (v !== null) patch(r.id, { amt: v, pct: 0 });
  };
  const startEdit = (r: Row) => {
    if (editId) return;
    setBackup({ ...r });
    setEditId(r.id);
  };
  const cancel = () => {
    if (!editId) return;
    const i = rows.findIndex((r) => r.id === editId);
    if (backup && backup.id === editId) setRows((rs) => rs.map((r) => (r.id === editId ? backup : r)));
    else if (i > 0 && !(num(rows[i].amt) > 0)) setRows((rs) => rs.filter((r) => r.id !== editId)); // an empty added row goes away
    setBackup(null);
    setEditId(null);
    auto();
  };
  const save = () => {
    setBackup(null);
    setEditId(null);
  };
  const addRow = () => {
    if (editId || mb) return;
    const r = newRow();
    setRows((rs) => [...rs, r]);
    setBackup(null);
    setEditId(r.id);
  };
  const delRow = (id: string) => {
    if (editId) return;
    setRows((rs) => (rs[0]?.id === id ? rs : rs.filter((r) => r.id !== id)));
    auto();
  };
  const changeLev = (v: number) => {
    setLev(Math.round(Math.max(1, Math.min(st.max, v)) * 100) / 100);
    auto();
  };
  const onBorAmt = (i: number, raw: string) => {
    if (raw !== "" && !/^\d*\.?\d*$/.test(raw)) return; // numeric only
    const next: [string, string] = [st.shown[0] ?? "", st.shown[1] ?? ""];
    next[i] = raw;
    setBManual(next);
  };
  const reset = () => {
    const r = newRow();
    setRows([r]);
    setEditId(r.id);
    setBackup(null);
    setLev(2);
    setBManual(null);
  };

  /** Same checks and submission as the previous Leverage tab. */
  const submit = async () => {
    if (!address) return connectWallet();
    if (editId !== null && hasAccount) {
      toast.error("Please save or cancel your collateral edit before proceeding.");
      return;
    }
    if (!hasAccount) {
      setCreating(true);
      return;
    }
    const borrowRequest = st.borrows.map((b) => ({ symbol: b.sym, amount: toTokenAmountString(b.amt, b.sym) })).filter((b) => Number(b.amount) > 0);
    const borrowUsd = borrowRequest.reduce((t, b) => t + Number(b.amount) * px(b.symbol), 0);
    // Pre-validate against the account-wide rule at the safety buffer (the program enforces > 1.10).
    if (borrowRequest.length > 0) {
      if (st.accMax <= 0) {
        toast.error("You've reached the safe borrow limit for your current collateral. Add more collateral or repay part of your loan to borrow more.");
        return;
      }
      if (borrowUsd > st.accMax + 0.01) {
        toast.error(`Borrow ${usd(borrowUsd)} is above your safe limit of ${usd(st.accMax)}. Lower the leverage to ${st.max.toFixed(2)}x or less.`);
        return;
      }
    }
    if (mb) {
      const r = rows[0];
      if (!(num(r.amt) > 0) || st.depUsd <= 0) {
        toast.error("Enter how much of your margin-account collateral to borrow against.");
        return;
      }
      // The MB amount sizes the borrow; it can't claim more than the account holds.
      const real = m.vault(r.sym);
      if (num(r.amt) > real + EPS) {
        toast.error(`You only have ${real.toFixed(4)} ${r.sym} in your margin account. Reduce the amount or use the 100% chip.`);
        return;
      }
      if (st.levE <= 1 || borrowRequest.length === 0) {
        toast.error("Please set leverage greater than 1x to borrow.");
        return;
      }
      try {
        await mutation.mutateAsync({ borrows: borrowRequest });
        reset();
      } catch {
        // The progress modal already shows the decoded error (useDepositAndBorrow).
      }
      return;
    }
    const deposits = rows.map((r) => ({ symbol: r.sym, amount: toTokenAmountString(num(r.amt), r.sym) })).filter((d) => Number(d.amount) > 0);
    if (deposits.length === 0) {
      toast.error("Please enter a deposit amount greater than 0");
      return;
    }
    // Wallet balance per asset (SOL keeps the 0.05 SOL fee reserve); same-asset rows are summed.
    const per = new Map<string, number>();
    for (const d of deposits) per.set(d.symbol, (per.get(d.symbol) ?? 0) + Number(d.amount));
    for (const [s, v] of per) {
      const av = spendableWalletAmount(s, m.wbal(s));
      if (v > av + EPS) {
        toast.error(
          av <= EPS
            ? `You have no spendable ${s} in your wallet. Use the Faucet to get ${s} first, then retry.`
            : `Insufficient ${s} wallet balance. Available: ${av.toFixed(4)} ${s}${s === "SOL" ? " (0.05 SOL is kept for fees)" : ""}.`,
        );
        return;
      }
    }
    try {
      await mutation.mutateAsync({ deposits, borrows: borrowRequest });
      reset();
    } catch {
      // The progress modal already shows the decoded error (useDepositAndBorrow).
    }
  };

  // ---- preview ----
  const dep = mb ? 0 : st.depUsd;
  const bor = st.levE > 1 ? st.totalUsd : 0;
  const showPrev = dep > 0 || bor > 0;
  const b = now;
  const a = st.afterN;
  const label = busy
    ? "Processing..."
    : !address
      ? "Login"
      : editId !== null && hasAccount
        ? "Save Collateral to Continue"
        : !hasAccount
          ? "Create your Margin Account"
          : st.safeErr && st.levE > 1
            ? `Health factor would fall below ${nf(SAFE_HF, 2)}`
            : mb
              ? "Borrow"
              : st.levE <= 1
                ? "Deposit"
                : "Deposit & Borrow";
  const disabled = busy || (editId !== null && hasAccount) || (hasAccount && st.levE > 1 && !!st.error);
  const warn = !disabled && hasAccount && bor > 0 && st.afterHf >= SAFE_HF && st.afterHf < WARN_HF;

  return (
    <div className="mg-lev">
      <div className="mg-dep">
        <h2 className="mg-h2">Deposit</h2>
        <ul className={`mg-rows ${rows.length > 2 ? "scroll" : ""}`} role="list">
          {rows.map((r, i) => {
            const bal = rowBal(r);
            const v = num(r.amt) * px(r.sym);
            return (
              <li key={r.id}>
                {editId === r.id ? (
                  <article className="mg-cc">
                    <div className="mg-r">
                      <span className="mg-lbl">Deposit</span>
                      <PctChips value={r.pct} label="Deposit percentage" onPick={(p) => pickPct(r, p)} />
                    </div>
                    <div className="mg-r">
                      <TokenDropdown id={`dep:${r.id}`} sym={r.sym} list={CollateralDropdownOptions} pop={pop} onPick={(s) => patch(r.id, { sym: s, amt: "", pct: 0 })} />
                      <input className="mg-amt num" inputMode="decimal" autoComplete="off" placeholder="0" value={r.amt} aria-label="Collateral amount" onChange={(e) => onAmt(r, e.target.value)} />
                    </div>
                    <div className="mg-r end">
                      <span className="mg-sub num">~ {usd(v)} USD</span>
                    </div>
                    <div className="mg-r start">
                      <span className="mg-seg" role="group" aria-label="Source">
                        {(["wb", "mb"] as const).map((s) => (
                          <button
                            key={s}
                            type="button"
                            className={r.src === s ? "on" : ""}
                            aria-pressed={r.src === s}
                            aria-label={s === "wb" ? "Deposit from wallet balance" : "Use margin balance"}
                            onClick={() => setSrc(r.id, s)}
                          >
                            {s.toUpperCase()}
                          </button>
                        ))}
                      </span>
                      <Info text="WB deposits from your wallet balance; MB borrows against collateral that is already in your margin account." />
                    </div>
                    <div className="mg-r">
                      <div className="mg-bl">
                        <span className="mg-sub num">
                          Balance: {nf(bal, 2)} {r.sym}
                        </span>
                        <RatioBtn sym={r.sym} price={px(r.sym)} />
                      </div>
                      <div className="mg-acts">
                        <button type="button" className="mg-cancel" onClick={cancel}>
                          Cancel
                        </button>
                        <button type="button" className="mg-add" onClick={save}>
                          Add
                        </button>
                      </div>
                    </div>
                  </article>
                ) : (
                  <article className="mg-cc">
                    <div className="mg-r">
                      <span className="mg-lbl">Deposit</span>
                      <span className="mg-acts" style={{ gap: 6 }}>
                        <button type="button" className="mg-icb" disabled={!!editId} aria-label="Edit collateral" onClick={() => startEdit(r)}>
                          {MI.pen}
                        </button>
                        {i > 0 && (
                          <button type="button" className="mg-icb" disabled={!!editId} aria-label="Delete collateral" onClick={() => delRow(r.id)}>
                            {MI.dash}
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="mg-r">
                      <span className="mg-tok" style={{ cursor: "default" }}>
                        <Icon sym={r.sym} className="ico mg-ti" />
                        <span>{r.sym}</span>
                        <span className="mg-badge">{r.src.toUpperCase()}</span>
                      </span>
                      <span className="mg-amtv num">{nf(num(r.amt), 2)}</span>
                    </div>
                    <div className="mg-r">
                      <div className="mg-bl">
                        <span className="mg-sub num">
                          Balance: {nf(bal, 2)} {r.sym}
                        </span>
                        <RatioBtn sym={r.sym} price={px(r.sym)} />
                      </div>
                      <span className="mg-sub num">~ {usd(v)} USD</span>
                    </div>
                  </article>
                )}
              </li>
            );
          })}
        </ul>
        <button type="button" className="mg-addc" disabled={!!editId || mb} onClick={addRow}>
          {MI.plus11}Add Collateral
        </button>
      </div>

      <div className="mg-bor">
        <div className="mg-bh">
          <span className="mg-h3">Borrow</span>
          <span className="mg-sw">
            <span className={dual ? "" : "on"}>Single Borrow</span>
            <button
              type="button"
              className={`mg-tgl ${dual ? "on" : ""}`}
              role="switch"
              aria-checked={dual}
              aria-label="Toggle dual borrow"
              onClick={() => {
                setDual((d) => !d);
                auto();
              }}
            >
              <i />
            </button>
            <span className={dual ? "on" : ""}>Dual Borrow</span>
          </span>
        </div>
        <div className={`mg-bcards ${dual ? "dual" : ""}`}>
          {st.items.map((it, i) => {
            const err = (st.exceeds && it.usd > 0) || (st.dup && i === 1);
            return (
              <article key={i} className={`mg-cc ${err ? "err" : ""}`}>
                <div className="mg-r mg-r1h">
                  <span className="mg-lbl b">Borrow</span>
                  {/* Max Value only in single mode: in dual mode the amount is split 50/50 from leverage. */}
                  {!dual && (
                    <button type="button" className="mg-maxv" aria-label={`Borrow the maximum — set leverage to ${st.max.toFixed(2)}x`} onClick={() => changeLev(st.max)}>
                      Max Value
                    </button>
                  )}
                </div>
                <div className="mg-r">
                  <TokenDropdown
                    id={`bor:${i}`}
                    sym={bTok[i]}
                    list={BorrowDropdownOptions}
                    pop={pop}
                    b2
                    onPick={(s) => {
                      setBTok((t) => (i === 0 ? [s, t[1]] : [t[0], s]));
                      auto();
                    }}
                  />
                  <input
                    className="mg-amt num"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    value={st.shown[i] ?? ""}
                    aria-invalid={err}
                    aria-label="Borrow amount"
                    onChange={(e) => onBorAmt(i, e.target.value)}
                  />
                </div>
                <div className="mg-r">
                  <RatioBtn sym={bTok[i]} price={px(bTok[i])} />
                  <span className="mg-sub num">~ {usd(it.usd)}</span>
                </div>
              </article>
            );
          })}
        </div>
        <div>
          <div className="mg-tot">
            <b className={`num ${st.exceeds ? "err" : ""}`}>Total: {usd(st.totalUsd)}</b>
            <span className="num">Max: {usd(st.maxUsd)}</span>
          </div>
          {st.error && (
            <p className="mg-err" role="alert">
              {st.error}
            </p>
          )}
        </div>
        <div className="mg-levrow">
          <div className="mg-step">
            <button type="button" disabled={st.levE <= 1} aria-label="Decrease leverage" onClick={() => changeLev(Math.max(1, Math.ceil(st.levE) - 1))}>
              −
            </button>
            <span className="num">{Number.isInteger(st.levE) ? st.levE : st.levE.toFixed(2)}</span>
            <button type="button" disabled={st.levE >= st.max} aria-label="Increase leverage" onClick={() => changeLev(Math.floor(st.levE) + 1)}>
              +
            </button>
          </div>
          <div className="mg-slw">
            <LevSlider lev={st.levE} max={st.max} onChange={changeLev} />
          </div>
        </div>
      </div>

      {showPrev && (
        <PrevBox>
          <PrevRow label="Account leverage" b={levFmt(b.leverage)} a={levFmt(a.leverage)} tip={TIPS.lev} />
          {dep > 0 && <PrevRow label="You're depositing" b={usd(0)} a={usd(dep)} />}
          {bor > 0 && <PrevRow label="You're borrowing" b={usd(0)} a={usd(bor)} />}
          <PrevRow label="Margin Collateral" b={usd(b.holdings)} a={usd(a.holdings)} tone="up" tip={TIPS.value} />
          {bor > 0 && <PrevRow label="Outstanding Debt" b={usd(b.debt)} a={usd(a.debt)} tone="dn" />}
          <PrevRow label="Health Factor" b={hfFmt(b.hf)} a={hfFmt(a.hf)} tone={toneHf(b.hf, a.hf)} tip={TIPS.hf} />
          <PrevRow label="Liquidation Buffer" b={usd(liqBuffer(b))} a={usd(liqBuffer(a))} tone={liqBuffer(a) >= liqBuffer(b) ? "up" : "dn"} tip={TIPS.buffer} />
        </PrevBox>
      )}

      <div className="mg-cta">
        {warn && (
          <div className="mg-am mg-wn" role="status">
            <span>
              Health factor after this: {hfFmt(st.afterHf)}, close to the {nf(SAFE_HF, 2)} limit.
            </span>
          </div>
        )}
        <button type="button" className="mg-btn" disabled={disabled} onClick={() => void submit()}>
          {label}
        </button>
      </div>
      {creating && address && <CreateAccountModal address={address} onClose={() => setCreating(false)} />}
    </div>
  );
}
