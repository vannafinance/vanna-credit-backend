import type { Metadata } from "next";
import "@/components/analytics/analytics.css";
import { AnalyticsShell } from "@/components/analytics/shell";

export const metadata: Metadata = {
  title: "Risk Analytics",
  description: "Live risk analytics for Vanna on Solana: accounts, health, collateral, lending pools and prices, read from the chain.",
};

/** `v3` carries the site's design tokens (light + `html.dark`); the analytics shell sits inside it. */
export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="v3">
      <AnalyticsShell>{children}</AnalyticsShell>
    </div>
  );
}
