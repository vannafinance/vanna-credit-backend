"use client";

/**
 * Deposit / Withdraw column of the Basis and Perena vault pages — the design's `dnAside` look,
 * driving the REAL vault flow ({@link useVaultAction}, lib/farm/use-vault-action.ts):
 *
 * - deposits are USDC only (from the margin account; SOL Basis from the wallet, two approvals);
 * - "Prepare & preview" simulates the exact transaction: shares / USDC out, minimum received
 *   (Basis), the health factor after, and the Junior 1% instant-exit fee;
 * - "Confirm transaction" sends that prepared transaction; SOL Basis shares stranded in the wallet
 *   can be moved into the margin account with the recovery button.
 *
 * Net APY uses the vault's recorded 7-day APY (0 until enough history exists) minus the Vanna USDC
 * borrow APY on the part of the deposit covered by the margin account's USDC debt.
 */
import { useMemo, useState } from "react";
import type { LiveVault } from "@/lib/solana/vault-state";
import { useVaultAction } from "@/lib/farm/use-vault-action";
import { useVaultAccount } from "@/lib/farm/use-vaults";
import { usePoolData } from "@/hooks/use-earn";
import { fromRaw } from "@/lib/solana/math";
import { explorerUrl } from "@/lib/solana/config";
import { Icon } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { hfFmt, nf, pct, usd } from "@/components/v3/format";
import { hfZone } from "@/lib/account-model";
import { TabsBox } from "./fm-ui";

export interface VaultAccountInputs {
  /** Vanna USDC pool borrow APY, % (null when unavailable). */
  usdcBorrowApy: number | null;
  /** USDC the margin account owes. */
  usdcDebt: number;
  /** On-chain USDC price, USD. */
  usdcPrice: number;
}

/** The live margin-account and pool figures the panel's Net APY works from. */
export function useVaultAccountInputs(): VaultAccountInputs {
  const { margin } = useVaultAccount();
  const { pools } = usePoolData();
  return useMemo(() => {
    const pool = pools.USDC;
    return {
      usdcBorrowApy: pool ? pool.borrowApr * 100 : null,
      usdcDebt: margin?.debts.filter((d) => d.symbol === "USDC").reduce((s, d) => s + d.debt, 0) ?? 0,
      // USDC's on-chain price when the snapshot carries it; USDC otherwise counts at its $1 peg.
      usdcPrice: margin?.prices?.USDC?.usd ?? 1,
    };
  }, [margin, pools]);
}

export function VaultActionPanel({ id, state, account }: { id: string; state: LiveVault | null; account: VaultAccountInputs }) {
  const a = useVaultAction(id);
  const [pctOn, setPctOn] = useState(0);
  const def = a.def;
  if (!def) return null;
  const deposit = a.call === "deposit";
  const units = Number(a.amount) || 0;
  const unit = deposit ? "USDC" : def.symbol;
  const usdIn = deposit ? units * account.usdcPrice : units * (state?.sharePriceUsd ?? 0);
  const apy7 = state?.apy7 ?? 0;
  const borrow = account.usdcBorrowApy;
  const borrowedShare = !units || a.walletDeposit ? 0 : Math.min(units, account.usdcDebt) / units;
  const netApy = apy7 - (borrow ?? 0) * borrowedShare;
  const perYear = (usdIn * netApy) / 100;
  const formula = !units
    ? ""
    : borrowedShare > 0 && borrow !== null
      ? `${pct(apy7, 1)} vault − ${pct(borrow, 1)} USDC borrow${borrowedShare < 0.999 ? ` on ${nf(borrowedShare * 100, 0)}% of it` : ""}`
      : `${pct(apy7, 1)} vault · own USDC, no borrow cost`;
  const p = a.preview;
  const overMax = deposit && def.kind === "basis" && state?.maxDepositUsd != null && units > state.maxDepositUsd;
  const closed = deposit && def.kind === "basis" && state?.available && (state.paused || !state.depositsOpen);

  return (
    <section className="fm-act">
      <TabsBox
        items={[
          ["deposit", "Deposit"],
          ["withdraw", "Withdraw"],
        ]}
        value={a.call}
        onChange={(c) => {
          a.setCall(c);
          setPctOn(0);
        }}
      />
      <div className="fm-amt">
        <div className="fm-amt-t">
          <input
            id="vault-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            aria-label={deposit ? "USDC to deposit" : "Shares to withdraw"}
            value={a.amount}
            disabled={a.busy}
            onChange={(e) => {
              a.setAmount(e.target.value);
              setPctOn(0);
            }}
          />
          <span className="fm-tokp">
            <Icon sym={deposit ? "USDC" : def.asset} className="fm-ico20" />
            {unit}
          </span>
        </div>
        <div className="fm-amt-u num">~ {usd(usdIn)}</div>
        <div className="fm-amt-f">
          <span className="fm-pcs">
            {[10, 25, 50, 100].map((n) => (
              <button
                key={n}
                type="button"
                disabled={a.busy}
                className={pctOn === n ? "on" : ""}
                onClick={() => {
                  a.fillPercent(n);
                  setPctOn(n);
                }}
              >
                {n}%
              </button>
            ))}
          </span>
          <button
            type="button"
            className="fm-maxl num"
            disabled={a.busy}
            onClick={() => {
              a.fillPercent(100);
              setPctOn(100);
            }}
          >
            {a.walletDeposit ? "Wallet" : "Margin"}: {fromRaw(a.balance, 6)} {unit}
          </button>
        </div>
      </div>

      {deposit && (
        <div>
          <div className="fm-net num">
            <div>
              <div className="lbl">
                Net APY <Info text="The vault's recorded 7-day APY (0.00% until 7 days of share-price history exist), minus the Vanna USDC borrow APY on the part of this deposit covered by your USDC debt." />
              </div>
              <div className={`big ${units && netApy < 0 ? "n" : ""}`}>{pct(units ? netApy : 0, 1)}</div>
              <div className="f">{formula}</div>
            </div>
            <div className="r">
              <div className="lbl">Est. earnings</div>
              <div className="big">{usd(units ? perYear / 12 : 0)}</div>
              <div className="f">{units ? `per month · ${usd(perYear, 0)} a year` : ""}</div>
            </div>
          </div>
          <div className="fm-kvs num">
            <div className="kv">
              <span>USDC borrow APY</span>
              <span>{pct(borrow ?? 0, 2)}</span>
            </div>
            {def.kind === "basis" && (
              <div className="kv">
                <span>Max deposit</span>
                <span>{state?.maxDepositUsd != null ? `${nf(state.maxDepositUsd, 0)} USDC` : "No limit"}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <p className="fm-note">First use may require a wallet approval to prepare your account before previewing. This setup does not deposit or withdraw funds.</p>
      {a.walletDeposit && (
        <p className="fm-note">SOL Basis uses wallet USDC. After the vault deposit, a second approval moves the received shares into your margin account.</p>
      )}
      {def.id === "perena-junior" && !deposit && <p className="fm-note">USD* Junior instant withdrawals include a 1% exit fee.</p>}
      {state?.stale && <p className="fm-warnn">Perena NAV is stale on the fork. Preview refreshes the fork timestamp before simulation.</p>}
      {!state?.registered && <p className="fm-note">Vault registration is being checked.</p>}
      {closed && <p className="fm-warnn">Vault deposits are paused.</p>}
      {overMax && <p className="fm-warnn">Maximum deposit is {nf(state!.maxDepositUsd!, 0)} USDC.</p>}
      {state?.error && <p className="fm-warnn dg">{state.error}</p>}

      {p && (
        <div className="fm-pv num">
          <div className="kv">
            <span>You receive (simulated)</span>
            <span>{deposit ? `${fromRaw(p.shareChange, 6)} ${def.symbol}` : `${fromRaw(p.usdcChange, 6)} USDC`}</span>
          </div>
          {!deposit && (
            <div className="kv">
              <span>Shares burned</span>
              <span>{fromRaw(-p.shareChange, 6)}</span>
            </div>
          )}
          <div className="kv">
            <span>
              Health factor after <Info text="From simulating the exact transaction against your margin account." />
            </span>
            <span className={a.walletDeposit || p.healthFactor === null ? "" : hfZone(p.healthFactor)}>
              {a.walletDeposit ? "After shares move to margin" : hfFmt(p.healthFactor)}
            </span>
          </div>
          {def.kind === "basis" && (
            <div className="kv">
              <span>Minimum received</span>
              <span>
                {fromRaw(p.minimumOut, 6)} {deposit ? def.symbol : "USDC"}
              </span>
            </div>
          )}
          {def.id === "perena-junior" && !deposit && (
            <div className="kv">
              <span>Exit fee</span>
              <span>1% included above</span>
            </div>
          )}
        </div>
      )}
      {def.kind === "perena" && p && <p className="fm-note">Perena has no minimum-output parameter. The amount above is the simulated result.</p>}
      {a.error && (
        <p className="fm-warnn dg" role="alert">
          {a.error}
        </p>
      )}
      <button
        type="button"
        className="fm-cta"
        disabled={a.busy || !a.address || !state?.registered || !a.amount || Number(a.amount) <= 0}
        onClick={p ? a.confirm : a.quote}
      >
        {a.busy ? "Preparing transaction…" : !a.address ? "Connect wallet" : p ? "Confirm transaction" : "Prepare & preview"}
      </button>
      {p && (
        <button type="button" className="fm-cta2" disabled={a.busy} onClick={a.quote}>
          Refresh preview
        </button>
      )}
      {id === "basis-sol" && a.walletShares > 0n && (
        <button type="button" className="fm-cta2" disabled={a.busy} onClick={a.move}>
          Move {fromRaw(a.walletShares, 6)} vbSOL to margin
        </button>
      )}
      {a.signature && (
        <a className="fm-link fm-txlink" href={explorerUrl("tx", a.signature)} target="_blank" rel="noreferrer">
          Transaction confirmed ↗
        </a>
      )}
    </section>
  );
}
