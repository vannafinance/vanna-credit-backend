"use client";

import Link from "next/link";
import { useTheme } from "@/contexts/theme-context";
import type { PerpsAccount } from "@/lib/solana/perps-types";
import { fmtUsd, healthFactorDisplay } from "./perps-format";

interface PerpsAccountPanelProps {
  account: PerpsAccount | undefined;
  walletConnected: boolean;
  isLoading: boolean;
}

/**
 * Right-hand column next to the chart (the old trades list): the margin account as the perps
 * venue sees it — USDC available for new orders, value held on GMTrade, health factor and totals.
 */
export function PerpsAccountPanel({ account, walletConnected, isLoading }: PerpsAccountPanelProps) {
  const { isDark } = useTheme();
  const muted = isDark ? "text-[#919191]" : "text-[#5C5B5B]";
  const primary = isDark ? "text-[#FFFFFF]" : "text-[#111111]";
  const hf = healthFactorDisplay(account?.healthFactor ?? null);

  const rows: { label: string; value: string; color?: string }[] = account
    ? [
        { label: "Margin USDC available", value: `${fmtUsd(account.marginUsdc)} USDC` },
        { label: "Perps value", value: `$${fmtUsd(account.venueValueUsd)}` },
        { label: "Unsettled idle USDC", value: `${fmtUsd(account.idleUsdc)} USDC` },
        { label: "Health factor", value: hf.label, color: hf.color },
        { label: "Total collateral", value: `$${fmtUsd(account.totalCollateralUsd)}` },
        { label: "Total debt", value: `$${fmtUsd(account.totalDebtUsd)}` },
      ]
    : [];

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className={`text-[13px] leading-5 font-semibold px-1 pt-1 ${primary}`}>Account</div>

      {!walletConnected ? (
        <p className={`text-[12px] leading-[18px] px-1 ${muted}`}>Connect a wallet to see your margin account.</p>
      ) : isLoading && !account ? (
        <div className="flex flex-col gap-2 px-1">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className={`h-4 rounded animate-pulse ${isDark ? "bg-[#333333]" : "bg-[#E2E2E2]"}`} />
          ))}
        </div>
      ) : account && !account.hasMargin ? (
        <p className={`text-[12px] leading-[18px] px-1 ${muted}`}>
          No margin account yet. Create one on the Margin page to trade perps.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.label} className="flex justify-between gap-2 px-1 text-[11px] leading-4 font-medium">
              <span className={muted}>{row.label}</span>
              <span className={`text-right font-semibold ${row.color ?? primary}`}>{row.value}</span>
            </div>
          ))}
        </div>
      )}

      <div className={`mt-auto pt-3 border-t ${isDark ? "border-[#333333]" : "border-[#E2E2E2]"}`}>
        <Link
          href="/"
          className="block px-1 text-[12px] leading-[18px] font-semibold text-[#703AE6] hover:underline"
        >
          Deposit / Borrow USDC on the Margin page →
        </Link>
        <p className={`px-1 mt-1 text-[10px] leading-[15px] ${muted}`}>
          Perps collateral comes from your margin account&apos;s USDC. Liquidation happens at a health factor of 1.10.
        </p>
      </div>
    </div>
  );
}
