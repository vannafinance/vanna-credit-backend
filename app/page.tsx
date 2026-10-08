"use client";

import { Suspense } from "react";
import { MarginPageContent } from "@/components/margin/margin-page-content";

/**
 * Home = the margin page (same UX as /margin): carousel, account stats, the
 * Leverage / Repay / Transfer panel, Margin Account Info and the positions table.
 * Both routes scroll the whole document (V3 layout, no fixed-height inner scroller).
 */
export default function Home() {
  return (
    <Suspense fallback={null}>
      <MarginPageContent basePath="/" />
    </Suspense>
  );
}
