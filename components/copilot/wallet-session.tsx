"use client";

import { useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { autoSignIn } from "@/lib/copilot/client/auto-signin";

/** Fired after the site signs the wallet in, so an open Copilot page reads the new session. */
export const COPILOT_SESSION_EVENT = "vanna:copilot-session";

/**
 * Proves the connected wallet to the Copilot as soon as it connects on the website (the Stellar app does the same for
 * Freighter, mounted once in the root layout), so the Copilot opens already signed in instead of asking again in the chat. It signs one message
 * (no fee), at most once per wallet per page load; when the wallet declines or the server is unreachable it stays
 * quiet and the sign-in card on /copilot remains the fallback.
 */
export function CopilotWalletSession() {
  const { connected, publicKey, signMessage } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;

  useEffect(() => {
    if (!wallet || !connected || !signMessage) return;
    let cancelled = false;
    const run = () => {
      void autoSignIn({ wallet, signMessage }).then((session) => {
        if (session && !cancelled) window.dispatchEvent(new Event(COPILOT_SESSION_EVENT));
      });
    };
    run();
    // A session that expired or was cleared while the wallet stayed connected is proved again when the tab comes back;
    // a wallet that declined is left alone (autoSignIn remembers), and a session that is still good costs one read.
    const onVisible = () => { if (document.visibilityState === "visible") run(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connected, wallet, signMessage]);

  return null;
}
