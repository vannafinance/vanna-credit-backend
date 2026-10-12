"use client";

/**
 * Site-wide strip above the navbar: Vanna runs on a Solana mainnet fork, so the user's wallet has to
 * point at the fork RPC ({@link PUBLIC_RPC_URL}) for balances and signatures to match the app. Shows the
 * URL with a copy button and links to the wallet setup guide in the docs. Always shown (no dismissal
 * state is persisted: the app keeps nothing in browser storage).
 */
import { useState } from "react";
import { PUBLIC_RPC_URL } from "@/lib/solana/config";

/** Docs page that walks through adding a custom RPC in Phantom / Solflare / Backpack. */
export const RPC_SETUP_GUIDE_URL = "https://docs.solana.vanna.finance/guides/connect-wallet#add-the-vanna-rpc-to-your-wallet";

export function RpcBanner() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(PUBLIC_RPC_URL).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="rpc-banner" role="note">
      <span className="rpc-banner-t">Vanna runs on a Solana mainnet fork: add RPC</span>
      <button type="button" className="rpc-banner-url" onClick={copy} title="Copy RPC URL" aria-label={`Copy RPC URL ${PUBLIC_RPC_URL}`}>
        {PUBLIC_RPC_URL}
        <span className="rpc-banner-cp">{copied ? "Copied" : "Copy"}</span>
      </button>
      <span className="rpc-banner-t">to your wallet.</span>
      <a className="rpc-banner-a" href={RPC_SETUP_GUIDE_URL} target="_blank" rel="noopener noreferrer">
        Setup guide →
      </a>
    </div>
  );
}
