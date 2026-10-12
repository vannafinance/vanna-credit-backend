"use client";
import { netYield } from "@/lib/farm/yield";

/**
 * Deposit / Withdraw column of the Basis and Perena vault pages — the design's `dnAside` look,
 * driving the REAL vault flow ({@link useVaultAction}, lib/farm/use-vault-action.ts):
 *
 * - deposits are USDC only, from the margin account. SOL Basis routes that USDC through the wallet
 *   and returns the vbSOL to the margin in the same single-approval transaction; because the USDC
 *   leaves the margin first, its health factor at that point is previewed (estimate) and checked
 *   on-chain;
 * - one Deposit / Withdraw click simulates the exact transaction (minimum received for Basis, the
 *   Junior 1% instant-exit fee included) and, if it passes, sends it — no separate preview step; a
 *   failed simulation stops before the wallet is asked to sign;
 * - SOL Basis shares left in the wallet (minted above the deposit's minimum) can be moved into the
 *   margin account with the recovery button.
 *
 * Net APY uses the vault APY the page passes in (Basis: the realized 7-day APY, or until 7 days of
 * history exist the Phoenix-funding estimate, labelled "Est."; Perena: its published APY; otherwise the
 * recorded 7-day APY, 0 until enough history exists) minus the Vanna USDC borrow APY on the part of
 * the deposit covered by the margin account's USDC debt.
 */
import { useMemo, useState } from "react";
import type { LiveVault } from "@/lib/solana/vault-state";
import { useVaultAction } from "@/lib/farm/use-vault-action";
import { useVaultAccount } from "@/lib/farm/use-vaults";
import { usePoolData } from "@/hooks/use-earn";
import { projectHealthFactor } from "@/lib/solana/margin";
import { LIQUIDATION_HEALTH_FACTOR, NETWORK_LABEL } from "@/lib/solana/config";
import { fromRaw } from "@/lib/solana/math";
import { explorerUrl } from "@/lib/solana/config";
import { Icon } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { nf, pct, usd } from "@/components/v3/format";
import { TabsBox } from "./fm-ui";

export interface VaultAccountInputs {
  /** Vanna USDC pool borrow APY, % (null when unavailable). */
  usdcBorrowApy: number | null;
  /** USDC the margin account owes. */
  usdcDebt: number;
  /** On-chain USDC price, USD. */
  usdcPrice: number;
  /** Margin account collateral, USD (for the SOL Basis health-factor estimate). */
  collateralUsd: number;
  /** Margin account debt, USD. */
  debtUsd: number;
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
      collateralUsd: margin?.totalCollateralUsd ?? 0,
      debtUsd: margin?.totalDebtUsd ?? 0,
    };
  }, [margin, pools]);
}

export function VaultActionPanel({
  id,
  state,
  account,
  apy7: apyOverride,
  apySource = "The vault's share-price return; deposit-event fallbacks are approximate and missing history has no APY estimate",
  apyEstimate = false,
  apyNote,
  initial,
}: {
  id: string;
  state: LiveVault | null;
  account: VaultAccountInputs;
  /** 7-day APY to project with, % (Perena: Perena's published APY); defaults to the recorded vault APY. */
  apy7?: number | null;
  /** Tooltip wording for where that APY comes from. */
  apySource?: string;
  /** True when that APY is an estimate (funding-based, or a low-TVL vault): Net APY is labelled "Est.". */
  apyEstimate?: boolean;
  /** Extra caveat shown under the Net APY (e.g. a low-TVL warning). */
  apyNote?: string;
  /** Open on deposit or withdraw (from `?action=`). */
  initial?: "deposit" | "withdraw";
}) {
  const a = useVaultAction(id, initial);
  const [pctOn, setPctOn] = useState(0);
  const def = a.def;
  if (!def) return null;
  const deposit = a.call === "deposit";
  const units = Number(a.amount) || 0;
  const unit = deposit ? "USDC" : def.symbol;
  const usdIn = deposit ? units * account.usdcPrice : units * (state?.sharePriceUsd ?? 0);
  const apy7 = (apyOverride !== undefined ? apyOverride : state?.apy7) ?? null;
  const borrow = account.usdcBorrowApy;
  const borrowedShare = !units ? 0 : Math.min(units, account.usdcDebt) / units;
  // SOL Basis: the USDC leaves the margin before the vbSOL comes back, so the lowest health factor
  // of the transaction is collateral minus this deposit over debt (estimate; the simulation decides).
  const routedHf = a.routedDeposit && units > 0 && account.debtUsd > 0 ? projectHealthFactor(account.collateralUsd - usdIn, account.debtUsd) : null;
  const routedHfLow = routedHf !== null && routedHf <= LIQUIDATION_HEALTH_FACTOR;
  const netApy = netYield(apy7, borrow, borrowedShare);
  const perYear = netApy === null ? null : (usdIn * netApy) / 100;
  const formula = netApy === null ? "0.00% until the vault has enough share-price history" : !units
    ? ""
    : borrowedShare > 0 && borrow !== null
      ? `${pct(apy7!, 1)} ${apyEstimate ? "est. vault" : "vault"} − ${pct(borrow, 1)} USDC borrow${borrowedShare < 0.999 ? ` on ${nf(borrowedShare * 100, 0)}% of it` : ""}`
      : `${pct(apy7!, 1)} ${apyEstimate ? "est. vault" : "vault"} · own USDC, no borrow cost`;
  const sharePx = state?.sharePriceUsd ?? 0;
  // No health-factor row: the receipt (deposit) or the USDC (withdraw) comes back into the margin
  // account at about the value that left it, so the settled HF does not move. The routed SOL Basis
  // dip above is only the mid-transaction low point, still warned about when it nears liquidation.
  void apyEstimate;
  void apyNote;
  void formula;
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
            <Icon sym={deposit ? "USDC" : def.kind === "perena" ? def.symbol : def.asset} className="fm-ico20" />
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
            Margin: {fromRaw(a.balance, 6)} {unit}
          </button>
        </div>
      </div>

      {/* Details after an amount is entered — the same box as the Kamino vault panel. */}
      {a.address && units > 0 && (
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
              <Icon sym={deposit ? "USDC" : def.kind === "perena" ? def.symbol : def.asset} className="fm-ico14" />
              {deposit ? "Deposit (USDC)" : `Withdraw (${def.symbol})`}
            </span>
            <span>{deposit ? `${nf(units, 2)} USDC` : `${nf(units, 6)} ${def.symbol}`}</span>
          </div>
          <div className="kv">
            <span>
              {deposit ? "Est. receipt received" : "Est. USDC received"}{" "}
              <Info text={deposit ? `Your USDC divided by the vault's current share price. The exact amount is set when the transaction executes.` : `Shares times the vault's current share price${def.id === "perena-junior" ? ", less Perena's 1% instant-exit fee" : ""}. The exact amount is set when the transaction executes.`} />
            </span>
            <span>{deposit ? `≈ ${nf(sharePx > 0 ? usdIn / sharePx : 0, 6)} ${def.symbol}` : `≈ ${nf(usdIn * (def.id === "perena-junior" ? 0.99 : 1), 2)} USDC`}</span>
          </div>
          <div className="kv">
            <span>Share price</span>
            <span>{usd(sharePx, 6)}</span>
          </div>
          {deposit && (
            <>
              <div className="kv">
                <span>
                  APY <Info text={`${apySource}${borrowedShare > 0 && borrow !== null ? `, minus the ${pct(borrow, 2)} USDC borrow APR on the part of this deposit covered by your USDC debt` : ""}.`} />
                </span>
                <span>{pct(netApy ?? 0, 2)}</span>
              </div>
              <div className="kv">
                <span>Projected monthly earnings</span>
                <span className={(perYear ?? 0) >= 0 ? "pos" : "n"}>{usd((perYear ?? 0) / 12)}</span>
              </div>
            </>
          )}
        </div>
      )}

      {routedHfLow && (
        <p className="fm-warnn dg">This would take your health factor to {nf(Math.max(routedHf!, 0), 2)} while the USDC is out of your margin account (must stay above 1.10). Deposit less or repay some USDC debt first.</p>
      )}
      {state?.stale && <p className="fm-warnn">Perena NAV is stale on the fork. The deposit refreshes the fork timestamp before it simulates.</p>}
      {!state?.registered && <p className="fm-note">Vault registration is being checked.</p>}
      {closed && <p className="fm-warnn">{state?.depositBlockedReason ?? "Vault deposits are paused."}</p>}
      {overMax && <p className="fm-warnn">Maximum deposit is {nf(state!.maxDepositUsd!, 0)} USDC.</p>}
      {state?.error && <p className="fm-warnn dg">{state.error}</p>}

      {a.error && (
        <p className="fm-warnn dg" role="alert">
          {a.error}
        </p>
      )}
      <button
        type="button"
        className="fm-cta"
        disabled={a.busy || !a.address || !state?.registered || !state?.available || !a.amount || Number(a.amount) <= 0 || overMax || Boolean(closed)}
        onClick={a.run}
      >
        {a.busy ? (deposit ? "Depositing…" : "Withdrawing…") : !a.address ? "Connect wallet" : overMax ? `Max ${nf(state!.maxDepositUsd!, 0)} USDC` : closed ? (state?.marketAfterHours ? "Market session closed" : "Deposits paused") : deposit ? "Deposit" : "Withdraw"}
      </button>
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
