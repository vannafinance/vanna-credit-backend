"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useTheme } from "@/contexts/theme-context";

// The Stellar page also had an orderbook mode (TradingView chart, order book, pair search,
// protocol dropdown) that has no Solana counterpart; only the swap view is ported.
const SpotSwapView = dynamic(
  () => import("@/components/spot/spot-nonorderbook").then((mod) => mod.SpotSwapView),
  { ssr: false }
);

const Spot = () => {
  const { isDark } = useTheme();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <main
      className={`w-full min-h-screen ${isDark ? "bg-[#111111]" : "bg-[#FFFFFF]"}`}
    >
      {/* Swap View */}
      <SpotSwapView />
    </main>
  );
};

export default Spot;
