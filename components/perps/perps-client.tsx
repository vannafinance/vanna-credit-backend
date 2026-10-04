"use client";

import dynamic from "next/dynamic";

// Client-only: the page reads the wallet and polls Solana, and embeds the TradingView widget.
const PerpsPage = dynamic(() => import("./perps-page"), { ssr: false });

export default function PerpsClient({ marketKey }: { marketKey: string }) {
  return <PerpsPage marketKey={marketKey} />;
}
