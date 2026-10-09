"use client";

/**
 * Supply / Withdraw column of a Kamino vault page (the design's `kamAside`), wired exactly like the
 * previous Farm form:
 *
 * - Supply: the asset already sitting in the MARGIN ACCOUNT (deposited, borrowed or swapped in) is
 *   supplied to Kamino via `margin_execute` (`useFarmDeposit` → `farmDeposit`, lib/solana/exec.ts).
 *   The cTokens stay in the margin account as collateral.
 * - Withdraw: redeems a %-of-position of the cTokens back into the margin account
 *   (`useFarmWithdraw` → `farmWithdraw`); 100% redeems exactly every cToken held.
 *
 * Tx progress (showTxStep / success / error) comes from those hooks. The health-factor preview is
 * program-exact (`useV3Account` model): the cTokens replace the supplied asset at the same value.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getConnection } from "@/lib/solana/connection";
import { KLEND_PROGRAM_ID, readReserveRate, receiptForUnderlying } from "@/lib/solana/kamino";
import { receiptPreview } from "@/lib/farm/receipt-preview";
import { BeforeAfter, Icon } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { hfFmt, nf, pct, tokFmt, usd } from "@/components/v3/format";
import { accountNumbers, hfZone, LIQ_HF, SAFE_HF, WARN_HF, type ModelState } from "@/lib/account-model";
import { useV3Account } from "@/hooks/use-v3-account";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, refreshMarginAccount } from "@/store/margin-account-info-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useFarmDeposit, useFarmWithdraw } from "@/lib/farm/use-farm";
import type { FarmPoolConfig } from "@/lib/farm/pools";
import type { FarmPosition } from "@/lib/solana/farm";
import { NETWORK_LABEL } from "@/lib/solana/config";
import { describeError } from "@/lib/solana/errors";
import { findToken } from "@/lib/solana/tokens";
import { toTokenAmountString } from "@/lib/margin/amounts";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { TabsBox } from "./fm-ui";

/** Floor a UI amount to the token's decimals for a %-of-balance fill (never rounds up). */
function percentOf(balance: number, p: number, symbol: string): string {
  const decimals = findToken(symbol)?.decimals ?? 6;
  const factor = 10 ** Math.min(decimals, 6);
  return (Math.floor(((balance * p) / 100) * factor) / factor).toString();
}

/** Model state after moving `usdMoved` of `symbol` into its Kamino receipt (or back when negative). */
function afterMove(s: ModelState, symbol: string, receipt: string, usdMoved: number): ModelState {
  const collateral = s.collateral.map((c) => ({ ...c }));
  const add = (sym: string, v: number) => {
    const row = collateral.find((c) => c.symbol === sym);
    if (row) row.usd = Math.max(0, row.usd + v);
    else if (v > 0) collateral.push({ symbol: sym, usd: v });
  };
  add(symbol, -usdMoved);
  add(receipt, usdMoved);
  return { ...s, collateral };
}

/** "Health factor would …" note, as the design's hfNote (block below SAFE_HF, warn below WARN_HF). */
function HfNote({ h0, h1 }: { h0: number; h1: number }) {
  const lower = h1 < h0 - 1e-9;
  if (lower && h1 < SAFE_HF)
    return (
      <p className="fm-warnn dg">
        Health factor would fall from {hfFmt(h0)} to {hfFmt(h1)}, below the {nf(SAFE_HF, 2)} safety floor (liquidation at {nf(LIQ_HF, 2)}).
      </p>
    );
  if (lower && h1 < WARN_HF)
    return (
      <p className="fm-warnn">
        Health factor would be {hfFmt(h1)}, close to the {nf(SAFE_HF, 2)} safety floor (liquidation at {nf(LIQ_HF, 2)}).
      </p>
    );
  return null;
}

export function KaminoAction({ pool, position }: { pool: FarmPoolConfig; position: FarmPosition | null }) {
  const [act, setAct] = useState<"deposit" | "withdraw">("deposit");
  return (
    <section className="fm-act k">
      <TabsBox
        items={[
          ["deposit", "Supply"],
          ["withdraw", "Withdraw"],
        ]}
        value={act}
        onChange={setAct}
      />
      {/* Keyed by vault so the form resets when switching vaults. */}
      {act === "deposit" ? <SupplyPanel key={pool.id} pool={pool} position={position} /> : <WithdrawPanel key={pool.id} pool={pool} position={position} />}
    </section>
  );
}

function SupplyPanel({ pool, position }: { pool: FarmPoolConfig; position: FarmPosition | null }) {
  const userAddress = useUserStore((s) => s.address);
  const hasMarginAccount = useMarginAccountInfoStore((s) => s.hasMarginAccount);
  const collateralBalances = useMarginAccountInfoStore((s) => s.collateralBalances);
  const isLoadingBalances = useMarginAccountInfoStore((s) => s.isLoadingBorrowedBalances);
  const account = useV3Account();
  const token = pool.symbol;
  const price = useTokenPrices([token])[token] ?? 0;
  const [value, setValue] = useState("");
  const [pctOn, setPctOn] = useState(0);
  const [txError, setTxError] = useState("");

  // The margin-vault balance is the only source of farm liquidity — make sure it's loaded.
  useEffect(() => {
    if (userAddress) void refreshMarginAccount(userAddress);
  }, [userAddress]);

  const available = hasMarginAccount ? parseFloat(collateralBalances[token]?.amount ?? "0") || 0 : 0;
  const amount = parseFloat(value) || 0;
  const receipt = receiptForUnderlying(token);
  const rateQuery = useQuery({
    queryKey: ["farm", "receipt-rate", pool.reserve],
    enabled: Boolean(receipt) && amount > 0,
    staleTime: 15_000,
    refetchInterval: amount > 0 ? 30_000 : false,
    queryFn: async () => {
      if (!receipt) throw new Error("Receipt not configured");
      const info = await getConnection().getAccountInfo(receipt.reserve, "confirmed");
      if (!info?.owner.equals(KLEND_PROGRAM_ID)) throw new Error("Reserve unavailable");
      const rate = readReserveRate(info.data, receipt.collateralMint);
      if (!rate.liquidityMint.equals(findToken(token)!.mint)) throw new Error("Reserve asset mismatch");
      return rate;
    },
  });
  const estimatedReceipts = receiptPreview(rateQuery.data, value);

  const deposit = useFarmDeposit();
  const isPending = deposit.isPending;
  const overBalance = amount > available + 1e-12;

  const hf = useMemo(() => {
    if (!account.state || !account.now) return null;
    const h1 = amount > 0 ? accountNumbers(afterMove(account.state, token, pool.receiptSymbol, amount * price)).hf : account.now.hf;
    return { h0: account.now.hf, h1 };
  }, [account.state, account.now, amount, price, token, pool.receiptSymbol]);
  const blocked = hf !== null && hf.h1 < SAFE_HF && hf.h1 < hf.h0 - 1e-9;

  const cta = !userAddress
    ? "Connect Wallet"
    : !hasMarginAccount
      ? "Margin Account Required"
      : isPending
        ? "Supplying..."
        : !(amount > 0)
          ? "Enter Amount"
          : overBalance
            ? `Insufficient ${token} in Margin Account`
            : blocked
              ? `Health factor would fall below ${nf(SAFE_HF, 2)}`
              : `Supply ${token} to Kamino`;
  const disabled = !userAddress || !hasMarginAccount || !(amount > 0) || overBalance || isPending || blocked;

  const submit = () => {
    setTxError("");
    deposit.mutate(
      { symbol: token, marginAmount: toTokenAmountString(amount, token) },
      {
        onSuccess: () => {
          setValue("");
          setPctOn(0);
          if (userAddress) void refreshMarginAccount(userAddress);
        },
        onError: (error) => setTxError(describeError(error, "Supply failed")),
      },
    );
  };

  const held = position?.underlying ?? 0;
  const apy = pool.supplyApy;
  return (
    <>
      <div className="fm-amt">
        <div className="fm-amt-t">
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={value}
            disabled={isPending}
            aria-label="Amount to supply"
            onChange={(e) => {
              const sanitized = validateAmountChange(e.target.value);
              if (sanitized === null) return;
              setValue(sanitized);
              setPctOn(0);
            }}
          />
          <span className="fm-tokp">
            <Icon sym={token} className="fm-ico20" />
            {token}
          </span>
        </div>
        <div className="fm-amt-u num">~ {usd(amount * price)}</div>
        <div className="fm-amt-f">
          <span className="fm-pcs">
            {[10, 25, 50, 100].map((p) => (
              <button
                key={p}
                type="button"
                disabled={isPending}
                className={pctOn === p ? "on" : ""}
                onClick={() => {
                  setPctOn(p);
                  setValue(percentOf(available, p, token));
                }}
              >
                {p}%
              </button>
            ))}
          </span>
          <button type="button" className="fm-maxl num" disabled={isPending} onClick={() => setValue(percentOf(available, 100, token))}>
            Margin: {isLoadingBalances ? "..." : available > 0 ? tokFmt(available, token, false) : "0"} {token}
          </button>
        </div>
      </div>

      {userAddress && !hasMarginAccount && <div className="fm-note">A margin account is required to farm. Create one on the Margin page.</div>}
      {userAddress && hasMarginAccount && available <= 0 && !isLoadingBalances && (
        <div className="fm-note">
          No {token} in your margin account. Deposit or borrow {token} on the Margin page first.
        </div>
      )}

      {userAddress && amount > 0 && (
        <>
          <div className="fm-pv num">
            <div className="kv">
              <span>Network</span>
              <span>
                <i className="fm-sq" />
                {NETWORK_LABEL}
              </span>
            </div>
            <div className="kv">
              <span>
                <Icon sym={token} className="fm-ico14" />
                Deposit ({token})
              </span>
              <span>
                <BeforeAfter a={tokFmt(held, token, false)} b={tokFmt(held + amount, token, false)} />
              </span>
            </div>
            <div className="kv">
              <span>Est. receipt received <Info text="Estimated from the reserve's current exchange rate, rounded down to receipt-token precision. The final amount may change slightly when the transaction executes." /></span>
              <span aria-live="polite">{rateQuery.isFetching && !rateQuery.data ? "Loading…" : estimatedReceipts !== null ? `≈ ${estimatedReceipts} ${pool.receiptSymbol}` : "Unavailable"}</span>
            </div>
            <div className="kv">
              <span>APY</span>
              <span>{pct((apy ?? 0) * 100)}</span>
            </div>
            <div className="kv">
              <span>Projected monthly earnings</span>
              <span className="pos">{usd(apy === null || !price ? 0 : (amount * price * apy) / 12)}</span>
            </div>
            {hf && (
              <div className="kv">
                <span>
                  Net Health Factor <Info text="Your margin account's health factor before and after. The Kamino receipt replaces the supplied asset at the same value, so it barely moves." />
                </span>
                <span>
                  <BeforeAfter a={hfFmt(hf.h0)} b={hfFmt(hf.h1)} za={hfZone(hf.h0)} zb={hfZone(hf.h1)} />
                </span>
              </div>
            )}
          </div>
          {hf && <HfNote h0={hf.h0} h1={hf.h1} />}
        </>
      )}
      {txError && <p className="fm-warnn dg">{txError}</p>}
      <button type="button" className="fm-cta" disabled={disabled} onClick={submit}>
        {cta}
      </button>
    </>
  );
}

function WithdrawPanel({ pool, position }: { pool: FarmPoolConfig; position: FarmPosition | null }) {
  const userAddress = useUserStore((s) => s.address);
  const account = useV3Account();
  // Entered as a percentage of the position (0–100).
  const [value, setValue] = useState("");
  const [pctOn, setPctOn] = useState(0);
  const [txError, setTxError] = useState("");

  const percent = parseFloat(value);
  const valid = Number.isFinite(percent) && percent > 0 && percent <= 100;
  const withdraw = useFarmWithdraw();
  const isPending = withdraw.isPending;

  const hf = useMemo(() => {
    if (!account.state || !account.now || !position) return null;
    const h1 = valid ? accountNumbers(afterMove(account.state, pool.symbol, pool.receiptSymbol, -(position.liquidityUsd * percent) / 100)).hf : account.now.hf;
    return { h0: account.now.hf, h1 };
  }, [account.state, account.now, position, valid, percent, pool.symbol, pool.receiptSymbol]);

  const submit = () => {
    if (!position) return;
    setTxError("");
    const all = percent >= 100;
    // Floor to the cToken's 6 decimals so a partial redeem never asks for more than is held.
    const receipts = Math.floor(((position.receipts * percent) / 100) * 1e6) / 1e6;
    withdraw.mutate(
      { symbol: pool.symbol, all, receipts: all ? undefined : receipts },
      {
        onSuccess: () => {
          setValue("");
          setPctOn(0);
          if (userAddress) void refreshMarginAccount(userAddress);
        },
        onError: (error) => setTxError(describeError(error, "Withdraw failed")),
      },
    );
  };

  const cta = !userAddress
    ? "Connect Wallet"
    : !position
      ? "No Position"
      : isPending
        ? "Withdrawing..."
        : !valid
          ? "Enter Percentage"
          : `Withdraw ${pool.symbol} to Margin Account`;
  const disabled = !userAddress || !position || !valid || isPending;
  const out = position && valid ? (position.underlying * percent) / 100 : 0;

  return (
    <>
      <div className="fm-wpos">
        <span>Your Vault Position</span>
        <b className="num">
          <Icon sym={pool.symbol} className="fm-ico16" />
          {`${tokFmt(position ? position.underlying : 0, pool.symbol)} · ${usd(position ? position.liquidityUsd : 0)}`}
        </b>
      </div>
      <div className="fm-wbox">
        <div className="fm-wi">
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={value}
            disabled={isPending}
            aria-label="Percentage of position to withdraw"
            onChange={(e) => {
              const sanitized = validateAmountChange(e.target.value);
              if (sanitized === null) return;
              setValue(sanitized);
              setPctOn(0);
            }}
          />
          <span>%</span>
        </div>
        <div className="fm-amt-u num">
          {Number.isFinite(percent) && percent > 100 ? (
            <span className="neg">Cannot remove more than 100%</span>
          ) : position && valid ? (
            `~ ${tokFmt(out, pool.symbol)} · ${usd((position.liquidityUsd * percent) / 100)}`
          ) : (
            `~ ${tokFmt(0, pool.symbol)} · ${usd(0)}`
          )}
        </div>
        <div className="fm-wpcs">
          {[25, 50, 75, 100].map((p) => (
            <button
              key={p}
              type="button"
              disabled={isPending}
              className={`p${p} ${pctOn === p ? "on" : ""}`}
              onClick={() => {
                setPctOn(p);
                setValue(String(p));
              }}
            >
              {p}%
            </button>
          ))}
        </div>
      </div>
      {userAddress && position && valid && (
        <div className="fm-pv num">
          <div className="kv">
            <span>You receive</span>
            <span>{tokFmt(out, pool.symbol)} to margin account</span>
          </div>
          {hf && (
            <div className="kv">
              <span>Net Health Factor</span>
              <span>
                <BeforeAfter a={hfFmt(hf.h0)} b={hfFmt(hf.h1)} za={hfZone(hf.h0)} zb={hfZone(hf.h1)} />
              </span>
            </div>
          )}
        </div>
      )}
      {txError && <p className="fm-warnn dg">{txError}</p>}
      <button type="button" className="fm-cta" disabled={disabled} onClick={submit}>
        {cta}
      </button>
    </>
  );
}

