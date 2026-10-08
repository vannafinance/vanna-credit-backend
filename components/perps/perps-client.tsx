"use client";

import dynamic from "next/dynamic";

// Client-only: the terminal reads the wallet, polls Solana and streams Phoenix's live market data.
const PerpsTerminal = dynamic(() => import("./terminal/perps-terminal"), { ssr: false });

export default function PerpsClient({ marketKey }: { marketKey: string }) {
  return <PerpsTerminal marketKey={marketKey} />;
}
