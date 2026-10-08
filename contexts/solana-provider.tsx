"use client";

import { useEffect, useMemo } from "react";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { forkFetch } from "@/lib/solana/connection";
import { SOLANA_RPC_URL, SOLANA_WS_URL } from "@/lib/solana/config";
import { onWalletUnlockPrompt, setActiveSolanaWallet } from "@/lib/solana/wallet-bridge";
import { showTxStep } from "@/lib/tx-progress";
import { useTxProgressStore } from "@/store/tx-progress-store";
import "@solana/wallet-adapter-react-ui/styles.css";

/** Publishes wallet-adapter state to the lib-level signer bridge (lib/solana/wallet-bridge.ts). */
function WalletBridge({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  useEffect(() => {
    setActiveSolanaWallet(wallet);
    return () => setActiveSolanaWallet(null);
  }, [wallet]);
  // While a locked wallet waits for its password, replace "Confirm in your wallet" with an
  // explicit unlock instruction, then restore the step title the flow was showing.
  useEffect(() => {
    let previousTitle: string | null = null;
    onWalletUnlockPrompt((prompt) => {
      if (prompt) {
        previousTitle = useTxProgressStore.getState().message ?? null;
        showTxStep(prompt);
      } else if (previousTitle) {
        showTxStep(previousTitle);
        previousTitle = null;
      }
    });
    return () => onWalletUnlockPrompt(null);
  }, []);
  return children;
}

/**
 * Solana connection + wallet-adapter. `wallets = []` means Wallet Standard autodetect only
 * (Phantom, Backpack, Solflare all register themselves), no legacy adapters bundled.
 */
const connectionConfig = { commitment: "confirmed" as const, disableRetryOnRateLimit: true, wsEndpoint: SOLANA_WS_URL, fetch: forkFetch };

export function SolanaProvider({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={SOLANA_RPC_URL} config={connectionConfig}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <WalletBridge>{children}</WalletBridge>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
