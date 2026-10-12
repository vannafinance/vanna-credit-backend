"use client";

/**
 * Deposit / withdraw state machine for the Basis and Perena vault pages (extracted from the former
 * live-vault-page.tsx, behaviour unchanged):
 *
 * - One click ({@link VaultAction.run}, the page's Deposit / Withdraw button): `prepareVaultAction`
 *   (it may first ask the wallet to prepare the account — no funds move — then simulates the real
 *   transaction, which sets the minimum out for Basis) and, if the simulation passes, submits exactly
 *   that transaction (`submitVaultAction`) straight away. A failed simulation stops before any wallet
 *   approval; a newer request supersedes an older in-flight one.
 * - `quote` / `confirm` (the earlier two-step preview flow) are kept for callers that want a preview.
 * - Every deposit is paid from the margin account's USDC. SOL Basis cannot run through
 *   `margin_execute`, so its deposit is ONE transaction (one approval) that moves the USDC from the
 *   margin to the wallet (health-checked), deposits it into the vault and deposits the received
 *   vbSOL back into the margin. It is atomic: a failure moves nothing. vbSOL minted above the
 *   slippage minimum stays in the wallet; it is reported after the deposit and can be moved with
 *   {@link VaultAction.move} (the recovery button) or is swept by the next SOL Basis deposit.
 * - Withdrawals burn receipt shares held in the margin account.
 */
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { VAULTS, type VaultDefinition } from "@/lib/solana/vault-catalogue";
import {
  prepareVaultAction,
  submitVaultAction,
  moveWalletSharesToMargin,
  type PreparedVaultAction,
} from "@/lib/solana/vault-actions";
import { getConnection } from "@/lib/solana/connection";
import { marginVault } from "@/lib/solana/pdas";
import { fromRaw } from "@/lib/solana/math";
import { showTxStep, showTxSuccess, showTxError, onTxStatus } from "@/lib/tx-progress";
import { useVaultAccount } from "./use-vaults";

export type VaultCall = "deposit" | "withdraw";

/** Raw receipt shares in the wallet's associated token account (0 when it does not exist). */
async function walletReceipt(owner: string, mint: string): Promise<bigint> {
  const a = await getConnection().getAccountInfo(marginVault(new PublicKey(owner), new PublicKey(mint), TOKEN_PROGRAM_ID));
  return a && a.data.length >= 165 ? a.data.readBigUInt64LE(64) : 0n;
}

/**
 * Success text; after a SOL Basis deposit it also reports vbSOL left in the wallet (minted above the
 * minimum the transaction moved into the margin), which the recovery button can move.
 */
async function successText(p: PreparedVaultAction, text: string): Promise<string> {
  if (!p.walletRouted) return text;
  try {
    const left = await walletReceipt(p.owner, p.definition.mint);
    return left > 0n ? `${text}. ${fromRaw(left, 6)} ${p.definition.symbol} stayed in your wallet; use Move to margin.` : text;
  } catch {
    return text;
  }
}

export interface VaultAction {
  def: VaultDefinition | undefined;
  address: string | null;
  call: VaultCall;
  setCall: (c: VaultCall) => void;
  amount: string;
  /** Accepts only up to 6 decimals; any edit discards the current preview. */
  setAmount: (v: string) => void;
  /** Sets the amount to `pct`% of the spendable balance. */
  fillPercent: (pct: number) => void;
  /** True for SOL Basis deposits (margin USDC routed through the wallet in one transaction). */
  routedDeposit: boolean;
  /** Spendable raw units (6 dp): margin USDC (deposit) or margin receipt shares (withdraw). */
  balance: bigint;
  /** vbSOL sitting in the wallet (minted above a deposit's minimum, or left by an older deposit). */
  walletShares: bigint;
  preview: PreparedVaultAction | null;
  busy: boolean;
  error: string;
  signature: string;
  quote: () => Promise<void>;
  confirm: () => Promise<void>;
  /** Simulate and send in one go (one click). */
  run: () => Promise<void>;
  move: () => Promise<void>;
}

/** `initial` opens the form on deposit or withdraw (e.g. from `?action=withdraw`). */
export function useVaultAction(id: string, initial: VaultCall = "deposit"): VaultAction {
  const def = VAULTS.find((v) => v.id === id);
  const { address, margin } = useVaultAccount();
  const qc = useQueryClient();
  const [call, setCallState] = useState<VaultCall>(initial);
  const [amount, setAmountState] = useState("");
  const [preview, setPreview] = useState<PreparedVaultAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const request = useRef(0);
  const wallet = useQuery({
    queryKey: ["farm", "wallet-shares", address, id],
    enabled: !!address && !!def,
    staleTime: 5_000,
    queryFn: () => walletReceipt(address!, def!.mint),
  });
  const holding = def ? margin?.collateral.find((c) => c.mint === def.mint) : undefined;
  const routedDeposit = id === "basis-sol" && call === "deposit";
  const balance =
    call === "withdraw"
      ? BigInt(holding?.amountRaw ?? "0")
      : BigInt(margin?.collateral.find((c) => c.symbol === "USDC")?.amountRaw ?? "0");
  const usable = preview && preview.owner === address && preview.definition.id === id && preview.call === call ? preview : null;
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
      if (current === request.current) setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!usable) return;
    setBusy(true);
    setError("");
    showTxStep(routedDeposit ? "Deposit margin USDC into SOL Basis" : "Confirm vault transaction");
    try {
      const sig = await submitVaultAction(usable, undefined, onTxStatus);
      setSignature(sig);
      setAmountState("");
      setPreview(null);
      showTxSuccess(await successText(usable, "Vault transaction confirmed"));
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
  const run = async () => {
    const current = ++request.current;
    setBusy(true);
    setError("");
    setPreview(null);
    showTxStep(routedDeposit ? "Deposit margin USDC into SOL Basis" : call === "deposit" ? "Deposit into the vault" : "Withdraw from the vault");
    try {
      // Simulates first: a failing simulation throws here, before the wallet is asked to sign.
      const prepared = await prepareVaultAction(id, call, amount);
      if (current !== request.current) return;
      const sig = await submitVaultAction(prepared, undefined, onTxStatus);
      setSignature(sig);
      setAmountState("");
      showTxSuccess(await successText(prepared, call === "deposit" ? "Deposit confirmed" : "Withdrawal confirmed"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Transaction failed";
      if (current === request.current) setError(msg);
      showTxError(msg);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const move = async () => {
    if (!def) return;
    setBusy(true);
    showTxStep("Move vault shares to margin");
    try {
      setSignature(await moveWalletSharesToMargin(def, undefined, undefined, onTxStatus));
      showTxSuccess("Shares added to margin");
    } catch (e) {
      showTxError(e instanceof Error ? e.message : "Deposit failed");
    } finally {
      setBusy(false);
      refresh();
    }
  };
  return {
    def,
    address,
    call,
    setCall: (c) => {
      reset();
      setCallState(c);
      setAmountState("");
    },
    amount,
    setAmount: (v) => {
      if (/^\d*\.?\d{0,6}$/.test(v)) {
        reset();
        setAmountState(v);
      }
    },
    fillPercent: (pct) => {
      reset();
      setAmountState(fromRaw((balance * BigInt(pct)) / 100n, 6));
    },
    routedDeposit,
    balance,
    walletShares: wallet.data ?? 0n,
    preview: usable,
    busy,
    error,
    signature,
    quote,
    confirm,
    run,
    move,
  };
}
