"use client";

import { Suspense } from "react";
import { MarginPageContent } from "@/components/margin/margin-page-content";

/**
 * Home = the margin page (same UX as /margin): carousel, account stats, the
 * Leverage / Repay / Transfer panel, Margin Account Info and the positions table.
 * Home scrolls the whole document (no fixed-height inner scroller).
 */
export default function Home() {
  return (
    <Suspense fallback={null}>
      <MarginPageContent basePath="/" mainClassName="w-full px-4 sm:px-10 lg:px-30 pb-8 lg:pb-0" />
    </Suspense>
  );
}
