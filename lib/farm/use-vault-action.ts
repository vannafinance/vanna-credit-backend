"use client";

/**
 * Deposit / withdraw state machine for the Basis and Perena vault pages (extracted from the former
 * live-vault-page.tsx, behaviour unchanged):
 *
 * - "Prepare & preview" runs `prepareVaultAction` — it may first ask the wallet to prepare the
 *   account (no funds move), then simulates the real transaction and returns shares / USDC change,
 *   minimum out (Basis) and the health factor after.
 * - "Confirm transaction" submits exactly that prepared transaction (`submitVaultAction`). A preview is
 *   only usable for the same wallet, vault and direction; editing the amount discards it, and a newer
 *   preview request supersedes an older in-flight one.
 * - SOL Basis deposits are wallet-funded: step 1 deposits wallet USDC into the vault, step 2 moves the
 *   received vbSOL into the margin account. Shares stranded in the wallet (step 2 not done) can be
 *   moved with {@link VaultAction.move} (the recovery button).
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
import { getToken } from "@/lib/solana/tokens";
import { fromRaw } from "@/lib/solana/math";
import { showTxStep, showTxSuccess, showTxError, onTxStatus } from "@/lib/tx-progress";
import { useVaultAccount } from "./use-vaults";

export type VaultCall = "deposit" | "withdraw";

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
  /** True for SOL Basis deposits (wallet USDC, two approvals). */
  walletDeposit: boolean;
  /** Spendable raw units (6 dp): margin USDC, wallet USDC (SOL Basis deposit) or margin receipt shares. */
  balance: bigint;
  /** vbSOL sitting in the wallet (SOL Basis step 2 not done). */
  walletShares: bigint;
  preview: PreparedVaultAction | null;
  busy: boolean;
  error: string;
  signature: string;
  quote: () => Promise<void>;
  confirm: () => Promise<void>;
  move: () => Promise<void>;
}

export function useVaultAction(id: string): VaultAction {
  const def = VAULTS.find((v) => v.id === id);
  const { address, margin } = useVaultAccount();
  const qc = useQueryClient();
  const [call, setCallState] = useState<VaultCall>("deposit");
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
    queryFn: async () => {
      const c = getConnection(),
        owner = new PublicKey(address!);
      const data = await c.getMultipleAccountsInfo([
        marginVault(owner, new PublicKey(def!.mint), TOKEN_PROGRAM_ID),
        marginVault(owner, getToken("USDC").mint, TOKEN_PROGRAM_ID),
      ]);
      return data.map((a) => (a && a.data.length >= 165 ? a.data.readBigUInt64LE(64) : 0n));
    },
  });
  const holding = def ? margin?.collateral.find((c) => c.mint === def.mint) : undefined;
  const walletDeposit = id === "basis-sol" && call === "deposit";
  const balance =
    call === "withdraw"
      ? BigInt(holding?.amountRaw ?? "0")
      : walletDeposit
        ? (wallet.data?.[1] ?? 0n)
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
    showTxStep(walletDeposit ? "Step 1/2: Deposit wallet USDC into SOL Basis" : "Confirm vault transaction");
    try {
      const sig = await submitVaultAction(usable, undefined, onTxStatus);
      setSignature(sig);
      setAmountState("");
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
    walletDeposit,
    balance,
    walletShares: wallet.data?.[0] ?? 0n,
    preview: usable,
    busy,
    error,
    signature,
    quote,
    confirm,
    move,
  };
}
