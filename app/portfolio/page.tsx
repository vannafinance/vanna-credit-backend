"use client";

import { PortfolioV3 } from "@/components/portfolio/portfolio-v3";

/**
 * Portfolio route: the V3 design page (components/portfolio/portfolio-v3.tsx). Wallet balances
 * come from the root MarginAccountHydrator's shared account snapshot, on any page.
 */
export default function PortfolioPage() {
  return (
    <div className="v3 page">
      <PortfolioV3 />
    </div>
  );
}
