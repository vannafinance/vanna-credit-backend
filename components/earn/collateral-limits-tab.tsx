'use client';

/**
 * "Collateral & Limits" tab: for every registry pool, supply / borrow usage
 * against the reserve's on-chain caps (progress bars in the shared
 * {@link Table}), plus the asset's on-chain collateral parameters from its
 * AssetConfig (collateral / borrow enablement, max collateral per margin
 * account, liquidation bonus) and the protocol's account-wide liquidation rule.
 */
import { useMemo } from "react";
import { Table } from "./table";
import { useTheme } from "@/contexts/theme-context";
import { usePoolDetails } from "@/hooks/use-earn";
import { LIQUIDATION_HEALTH_FACTOR } from "@/lib/solana/config";
import { TOKENS, tokenIcon } from "@/lib/solana/tokens";
import { fromRaw } from "@/lib/solana/math";
import { fmtCompact } from "./earn-utils";

const supplyHeadings = [
  { label: "Assets", id: "assets" },
  { label: "Supply Cap Usage", id: "limits-usage" },
];

const borrowHeadings = [
  { label: "Assets", id: "assets" },
  { label: "Borrow Cap Usage", id: "limits-usage" },
];

const paramHeadings = [
  { label: "Asset", id: "asset" },
  { label: "Collateral", id: "collateral-enabled" },
  { label: "Borrowing", id: "borrow-enabled" },
  { label: "Max per Margin Account", id: "max-collateral" },
  { label: "Liquidation Bonus", id: "liq-bonus" },
];

/**
 * Builds per-asset cap-usage rows (usage / cap, clamped to 100%; "Uncapped" when the reserve's
 * cap is 0) and the collateral-parameter table. Shows a loading placeholder while pool data
 * resolves.
 */
export const CollateralLimitsTab = () => {
  const { isDark } = useTheme();
  const { details, isLoading } = usePoolDetails();

  const usageRow = (symbol: string, used: number, cap: number | null, initialised: boolean) => ({
    cell: [
      {
        icon: tokenIcon(symbol),
        title: symbol,
        description: initialised ? `v${symbol} Pool` : "Not initialised",
      },
      cap === null
        ? { percentage: 0, value: `${fmtCompact(used, 2)} ${symbol} · Uncapped` }
        : {
            percentage: cap > 0 ? Math.min((used / cap) * 100, 100) : 0,
            value: `${fmtCompact(used, 2)} of ${fmtCompact(cap, 2)} ${symbol}`,
          },
    ],
  });

  const supplyBody = useMemo(() => ({
    rows: TOKENS.map((t) => {
      const p = details[t.symbol];
      return usageRow(t.symbol, p?.totalSupplied ?? 0, p?.supplyCapUi ?? null, Boolean(p?.reserve));
    }),
  }), [details]); // eslint-disable-line react-hooks/exhaustive-deps

  const borrowBody = useMemo(() => ({
    rows: TOKENS.map((t) => {
      const p = details[t.symbol];
      return usageRow(t.symbol, p?.totalBorrowed ?? 0, p?.borrowCapUi ?? null, Boolean(p?.reserve));
    }),
  }), [details]); // eslint-disable-line react-hooks/exhaustive-deps

  const paramsBody = useMemo(() => ({
    rows: TOKENS.map((t) => {
      const a = details[t.symbol]?.asset;
      return {
        cell: [
          { icon: tokenIcon(t.symbol), title: t.symbol },
          { title: a ? (a.collateralEnabled ? "Enabled" : "Disabled") : "—" },
          { title: a ? (a.borrowEnabled ? "Enabled" : "Disabled") : "—" },
          {
            title: !a ? "—" : a.maxCollateralPerMargin === 0n
              ? "Uncapped"
              : `${fmtCompact(Number(fromRaw(a.maxCollateralPerMargin, t.decimals)), 2)} ${t.symbol}`,
          },
          { title: a ? `${(a.liquidationBonusBps / 100).toFixed(2)}%` : "—" },
        ],
      };
    }),
  }), [details]);

  if (isLoading) {
    return (
      <section className="w-full h-fit" aria-label="Collateral Limits Overview">
        <div className={`w-full h-[200px] border-[1px] rounded-[8px] flex items-center justify-center ${
          isDark ? "bg-[#222222]" : "bg-[#F7F7F7]"
        }`}>
          <p className={`text-[14px] font-medium ${isDark ? "text-[#919191]" : "text-[#76737B]"}`}>
            Loading collateral and limits...
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="w-full h-fit flex flex-col gap-4" aria-label="Collateral Limits Overview">
      <article aria-label="Account-wide Liquidation Rule" className={`w-full rounded-[16px] border px-5 py-4 flex flex-col gap-1 ${
        isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"
      }`}>
        <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
          Account-wide health factor
        </span>
        <span className={`text-[12px] font-medium ${isDark ? "text-[#919191]" : "text-[#5C5B5B]"}`}>
          A margin account&apos;s health factor is Σ collateral value ÷ Σ debt value across all assets.
          It becomes liquidatable at HF ≤ {LIQUIDATION_HEALTH_FACTOR.toFixed(2)}; borrowed tokens stay in the
          margin account and count as collateral. Liquidators receive the seized asset&apos;s liquidation bonus.
        </span>
      </article>
      <article aria-label="Collateral Parameters">
        <Table
          heading={{ heading: "Collateral Parameters" }}
          tableHeadings={paramHeadings}
          tableBody={paramsBody}
        />
      </article>
      <article aria-label="Supply Cap Usage">
        <Table
          heading={{}}
          tableHeadings={supplyHeadings}
          tableBody={supplyBody}
          showProgressBar={true}
        />
      </article>
      <article aria-label="Borrow Cap Usage">
        <Table
          heading={{}}
          tableHeadings={borrowHeadings}
          tableBody={borrowBody}
          showProgressBar={true}
        />
      </article>
    </section>
  );
};
