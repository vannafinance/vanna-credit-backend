"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";

// The Stellar page also had an orderbook mode (TradingView chart, order book, pair search,
// protocol dropdown) that has no Solana counterpart; only the swap view is ported.
// V3 design: swap card + margin-account block + Positions | Position History (components/spot/v3).
const SpotPage = dynamic(() => import("@/components/spot/v3/SpotPage").then((mod) => mod.SpotPage), { ssr: false });

const Spot = () => {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return <SpotPage />;
};

export default Spot;
