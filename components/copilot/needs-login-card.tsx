"use client";

import { Loader2 } from "lucide-react";

export interface NeedsLoginCardProps {
  /** A wallet is connected in the browser; signing in asks it to sign one message. */
  walletConnected: boolean;
  /** A remembered wallet is still reconnecting after the page loaded: wait for it rather than offer "Connect wallet". */
  walletConnecting?: boolean;
  walletName?: string | null;
  busy: boolean;
  error?: string | null;
  onSignIn: () => void;
  onConnect: () => void;
}

/**
 * No valid session. Sign-In-With-Solana proves the wallet is yours with one free message
 * signature: no transaction, no fee, and nothing is sent on chain.
 */
export function NeedsLoginCard({ walletConnected, walletConnecting, walletName, busy, error, onSignIn, onConnect }: NeedsLoginCardProps) {
  return (
    <section aria-label="Sign in" className="rounded-xl border border-violet-100 bg-surface p-4 sm:p-5">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-violet-500">Sign in required</p>
      <p className="mt-2 text-[15px] leading-6 text-vgray-900">
        Sign in with your Solana wallet to use the Copilot.
      </p>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-5 text-vgray-500">
        You sign one message to prove the wallet is yours. It is not a transaction, costs nothing and moves no funds.
        The Copilot only ever builds transactions for this wallet, and every transaction still asks your wallet to sign.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-imperial-600">{error}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {walletConnected ? (
          <button
            type="button"
            onClick={onSignIn}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-r2 bg-gradient px-4 py-2.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {busy ? "Waiting for your wallet…" : `Sign in with ${walletName ?? "wallet"}`}
          </button>
        ) : walletConnecting ? (
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-2 rounded-r2 bg-gradient px-4 py-2.5 text-[13px] font-semibold text-white opacity-45 cursor-not-allowed"
          >
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            {`Connecting ${walletName ?? "wallet"}…`}
          </button>
        ) : (
          <button
            type="button"
            onClick={onConnect}
            className="rounded-r2 bg-gradient px-4 py-2.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
          >
            Connect wallet
          </button>
        )}
      </div>
    </section>
  );
}
