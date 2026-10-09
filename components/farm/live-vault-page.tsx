"use client";
import "./live-vault.css";
import "./farm-v3.css";
import { useState, useRef } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import { useVaults, useVaultAccount } from "@/lib/farm/use-vaults";
import {
  prepareVaultAction,
  submitVaultAction,
  moveWalletSharesToMargin,
  type PreparedVaultAction,
} from "@/lib/solana/vault-actions";
import { getConnection } from "@/lib/solana/connection";
import { marginVault } from "@/lib/solana/pdas";
import { getToken } from "@/lib/solana/tokens";
import { fromRaw } from "@/lib/solana/math";
import { explorerUrl } from "@/lib/solana/config";
import { useMarginHistory } from "@/hooks/use-margin";
import {
  showTxStep,
  showTxSuccess,
  showTxError,
  onTxStatus,
} from "@/lib/tx-progress";
import { nf, usd, hfFmt } from "@/components/v3/format";
import { Icon } from "@/components/v3/icons";
import { TabsBox, Venue } from "./fm-ui";

export function LiveVaultPage({ id }: { id: string }) {
  const def = VAULTS.find((v) => v.id === id);
  const live = useVaults(id),
    { address, margin } = useVaultAccount(),
    qc = useQueryClient();
  const [call, setCall] = useState<"deposit" | "withdraw">("deposit"),
    [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<PreparedVaultAction | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [signature, setSignature] = useState("");
  const request = useRef(0);
  const history = useMarginHistory();
  const wallet = useQuery({
    queryKey: ["farm", "wallet-shares", address, id],
    enabled: !!address && !!def,
    staleTime: 5_000,
    queryFn: async () => {
      const c = getConnection(),
        owner = new PublicKey(address!);
      const data = await c.getMultipleAccountsInfo([
        marginVault(owner, new PublicKey(def!.mint), TOKEN_PROGRAM_ID),
        marginVault(owner, getToken("USDC").mint, TOKEN_PROGRAM_ID),
      ]);
      return data.map((a) =>
        a && a.data.length >= 165 ? a.data.readBigUInt64LE(64) : 0n,
      );
    },
  });
  if (!def)
    return (
      <div className="v3">
        <main className="page">
          <h1>Vault not found</h1>
          <Link href="/farm">Back to pools</Link>
        </main>
      </div>
    );
  const state = live.data?.find((v) => v.id === id),
    holding = margin?.collateral.find((c) => c.mint === def.mint);
  const walletDeposit = id === "basis-sol" && call === "deposit";
  const balance =
    call === "withdraw"
      ? BigInt(holding?.amountRaw ?? "0")
      : walletDeposit
        ? (wallet.data?.[1] ?? 0n)
        : BigInt(
            margin?.collateral.find((c) => c.symbol === "USDC")?.amountRaw ??
              "0",
          );
  const usable =
    preview &&
    preview.owner === address &&
    preview.definition.id === id &&
    preview.call === call
      ? preview
      : null;
  const reset = () => {
    request.current++;
    setPreview(null);
    setError("");
  };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["farm"] });
    void qc.invalidateQueries({ queryKey: ["margin"] });
  };
  const quote = async () => {
    const current = ++request.current;
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const p = await prepareVaultAction(id, call, amount);
      if (current === request.current) setPreview(p);
    } catch (e) {
      if (current === request.current)
        setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!usable) return;
    setBusy(true);
    setError("");
    showTxStep(
      walletDeposit
        ? "Step 1/2: Deposit wallet USDC into SOL Basis"
        : "Confirm vault transaction",
    );
    try {
      const sig = await submitVaultAction(usable, undefined, onTxStatus);
      setSignature(sig);
      setAmount("");
      setPreview(null);
      showTxSuccess("Vault transaction confirmed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Transaction failed";
      setError(msg);
      showTxError(msg);
      setPreview(null);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const move = async () => {
    setBusy(true);
    showTxStep("Move vault shares to margin");
    try {
      setSignature(
        await moveWalletSharesToMargin(def, undefined, undefined, onTxStatus),
      );
      showTxSuccess("Shares added to margin");
    } catch (e) {
      showTxError(e instanceof Error ? e.message : "Deposit failed");
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const rows = history.rows.filter((r) => r.vaultId === id);
  return (
    <div className="v3">
      <main className="page lv-page">
        <Link
          className="fm-link"
          href={def.kind === "basis" ? "/farm?category=delta-neutral" : "/farm"}
        >
          ‹ Back to pools
        </Link>
        <header className="lv-title">
          <Icon sym={def.asset} className="fm-ico24" />
          <h1>{def.name}</h1>
          <span className="fm-tag">Vault</span>
          <Venue name={def.kind === "basis" ? "Jupiter · Phoenix" : "Perena"} />
        </header>
        <div className="lv-stats">
          {[
            [
              "Total value locked",
              usd(state?.navUsd ?? 0),
            ],
            [
              "Share price",
              usd(state?.sharePriceUsd ?? 0, 6),
            ],
            [
              "Vault APY (7D)",
              `${nf(state?.apy7 ?? 0, 2)}%`,
            ],
            ["Your position", usd(holding?.usd ?? 0)],
          ].map(([label, value]) => (
            <article key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </article>
          ))}
        </div>
        <div className="lv-layout">
          <section className="lv-main">
            <div className="lv-section">
              <h2>{def.kind === "basis" ? "Strategy" : "About this vault"}</h2>
              <p>
                {def.kind === "basis"
                  ? `The vault holds ${def.asset} against a Phoenix short. Funding can be positive or negative. Deposits and withdrawals settle in USDC.`
                  : def.id === "perena-junior"
                    ? "USD* Junior takes the junior tranche risk. Instant withdrawals currently include a 1% exit fee."
                    : "Deposit USDC into Perena and receive USD* shares. Your receipt stays in your Vanna margin account."}
              </p>
              <dl className="lv-details">
                <div>
                  <dt>Deposit asset</dt>
                  <dd>USDC</dd>
                </div>
                <div>
                  <dt>Receipt</dt>
                  <dd>{def.symbol}</dd>
                </div>
                <div>
                  <dt>Vault fee</dt>
                  <dd>
                    {def.kind === "basis"
                      ? "None"
                      : "Reflected in the transaction preview"}
                  </dd>
                </div>
                {state?.updatedAt && (
                  <div>
                    <dt>Fork NAV updated</dt>
                    <dd>{new Date(state.updatedAt * 1000).toLocaleString()}</dd>
                  </div>
                )}
                {state?.netDeltaPct != null && (
                  <div>
                    <dt>Net delta</dt>
                    <dd>{nf(state.netDeltaPct, 3)}%</dd>
                  </div>
                )}
              </dl>
              <p className="lv-note">
                APY appears when enough recorded share-price
                history is available.
              </p>
            </div>
            {def.kind === "basis" && (
              <section className="lv-section">
                <h2>Vault positions</h2>
                <div className="lv-table-wrap">
                  <table className="lv-table">
                    <thead>
                      <tr>
                        <th>Position</th>
                        <th>Amount / value</th>
                        <th>Held at</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>{def.asset} collateral</td>
                        <td>
                          {`${nf(state?.assetUnits ?? 0, 6)} ${def.asset}`}
                        </td>
                        <td>
                          {id === "basis-sol"
                            ? "Phoenix"
                            : "Vault token account"}
                        </td>
                      </tr>
                      <tr>
                        <td>{def.asset}-PERP short</td>
                        <td>
                          {usd(state?.shortUsd ?? 0)}
                        </td>
                        <td>Phoenix</td>
                      </tr>
                      <tr>
                        <td>Phoenix equity</td>
                        <td>
                          {usd(state?.phoenixEquityUsd ?? 0)}
                        </td>
                        <td>Phoenix</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            <section className="lv-section">
              <h2>Your position</h2>
              <div className="lv-table-wrap">
                <table className="lv-table">
                  <thead>
                    <tr>
                      <th>Receipt</th>
                      <th>Margin balance</th>
                      <th>Collateral value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{def.symbol}</td>
                      <td>{nf(holding?.amount ?? 0, 6)}</td>
                      <td>{usd(holding?.usd ?? 0)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
            <section className="lv-section">
              <h2>Position history</h2>
              <div className="lv-table-wrap">
                <table className="lv-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Action</th>
                      <th>USDC</th>
                      <th>Shares</th>
                      <th>Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.signature}-${i}`}>
                        <td>{new Date(r.timestamp).toLocaleString()}</td>
                        <td>
                          {r.type === "farm-deposit" ? "Deposit" : "Withdraw"}
                        </td>
                        <td>{r.amount}</td>
                        <td>{r.receiptAmount ?? "0"}</td>
                        <td>
                          <a
                            className="fm-link"
                            href={explorerUrl("tx", r.signature)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View ↗
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!rows.length && (
                  <p className="lv-note">
                    {address
                      ? "No vault transactions found"
                      : "Connect your wallet to view history"}
                  </p>
                )}
              </div>
            </section>
          </section>
          <aside className="lv-action">
            <TabsBox
              items={[
                ["deposit", "Deposit"],
                ["withdraw", "Withdraw"],
              ]}
              value={call}
              onChange={(v) => {
                reset();
                setCall(v);
                setAmount("");
              }}
            />
            <div className="lv-input">
              <label htmlFor="vault-amount">
                {call === "deposit" ? "You deposit" : "Shares to withdraw"}
              </label>
              <div>
                <input
                  id="vault-amount"
                  inputMode="decimal"
                  placeholder="0"
                  value={amount}
                  disabled={busy}
                  onChange={(e) => {
                    if (/^\d*\.?\d{0,6}$/.test(e.target.value)) {
                      reset();
                      setAmount(e.target.value);
                    }
                  }}
                />
                <strong>{call === "deposit" ? "USDC" : def.symbol}</strong>
              </div>
              <span>
                {walletDeposit ? "Wallet" : "Margin"}: {fromRaw(balance, 6)}
              </span>
              <div className="lv-percent">
                {[10, 25, 50, 100].map((n) => (
                  <button
                    key={n}
                    disabled={busy}
                    onClick={() => {
                      reset();
                      setAmount(fromRaw((balance * BigInt(n)) / 100n, 6));
                    }}
                  >
                    {n}%
                  </button>
                ))}
              </div>
            </div>
            <p className="lv-note">
              First use may require a wallet approval to prepare your account
              before previewing. This setup does not deposit or withdraw funds.
            </p>
            {walletDeposit && (
              <p className="lv-note">
                SOL Basis uses wallet USDC. After the vault deposit, a second
                approval moves the received shares into your margin account.
              </p>
            )}
            {state?.stale && (
              <p className="lv-error">
                Perena NAV is stale on the fork. Preview refreshes the fork
                timestamp before simulation.
              </p>
            )}
            {!state?.registered && (
              <p className="lv-note">Vault registration is being checked.</p>
            )}
            {state?.error && <p className="lv-error">{state.error}</p>}
            {usable && (
              <dl className="lv-details lv-preview">
                <div>
                  <dt>You receive (simulated)</dt>
                  <dd>
                    {call === "deposit"
                      ? `${fromRaw(usable.shareChange, 6)} ${def.symbol}`
                      : `${fromRaw(usable.usdcChange, 6)} USDC`}
                  </dd>
                </div>
                {call === "withdraw" && (
                  <div>
                    <dt>Shares burned</dt>
                    <dd>{fromRaw(-usable.shareChange, 6)}</dd>
                  </div>
                )}
                <div>
                  <dt>Health factor after</dt>
                  <dd>
                    {walletDeposit
                      ? "After shares move to margin"
                      : hfFmt(usable.healthFactor)}
                  </dd>
                </div>
                {def.kind === "basis" && (
                  <div>
                    <dt>Minimum received</dt>
                    <dd>
                      {fromRaw(usable.minimumOut, 6)}{" "}
                      {call === "deposit" ? def.symbol : "USDC"}
                    </dd>
                  </div>
                )}
                {def.id === "perena-junior" && call === "withdraw" && (
                  <div>
                    <dt>Exit fee</dt>
                    <dd>1% included above</dd>
                  </div>
                )}
              </dl>
            )}
            {def.kind === "perena" && usable && (
              <p className="lv-note">
                Perena has no minimum-output parameter. The amount above is the
                simulated result.
              </p>
            )}
            {error && (
              <p className="lv-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="lv-button"
              disabled={
                busy ||
                !address ||
                !state?.registered ||
                !amount ||
                Number(amount) <= 0
              }
              onClick={usable ? confirm : quote}
            >
              {busy
                ? "Preparing transaction…"
                : !address
                  ? "Connect wallet"
                  : usable
                    ? "Confirm transaction"
                    : "Prepare & preview"}
            </button>
            {usable && (
              <button className="lv-refresh" disabled={busy} onClick={quote}>
                Refresh preview
              </button>
            )}
            {id === "basis-sol" && (wallet.data?.[0] ?? 0n) > 0n && (
              <button className="lv-refresh" disabled={busy} onClick={move}>
                Move {fromRaw(wallet.data![0], 6)} vbSOL to margin
              </button>
            )}
            {signature && (
              <a
                className="fm-link lv-note"
                href={explorerUrl("tx", signature)}
                target="_blank"
                rel="noreferrer"
              >
                Transaction confirmed ↗
              </a>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
