"use client";

import { AccountStatsGhost } from "@/components/earn/account-stats-ghost";
import { Form } from "@/components/earn/form";
import { Details } from "@/components/earn/details-tab";
import { YourPositions } from "@/components/earn/your-positions";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import Image from "next/image";
import { useState, use, useMemo, useEffect, memo } from "react";
import { ActivityTab } from "@/components/earn/acitivity-tab";
import { AnalyticsTab } from "@/components/earn/analytics-tab";
import { CollateralLimitsTab } from "@/components/earn/collateral-limits-tab";
import { useEarnVaultStore } from "@/store/earn-vault-store";
import { useRouter } from "next/navigation";
import { useTheme } from "@/contexts/theme-context";
import { setSelectedPool, useSelectedPoolStore } from "@/store/selected-pool-store";
import { usePoolData } from "@/hooks/use-earn";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { findToken, TOKEN_SYMBOLS, tokenIcon } from "@/lib/solana/tokens";

const fmt = (n: number, decimals = 4) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(2)}K`
  : n.toFixed(decimals);

/** Header stat tiles for one pool — live Reserve state (GET /api/pools) × oracle price. */
const EarnHeaderStats = memo(function EarnHeaderStats({ symbol }: { symbol: string }) {
  const { pools } = usePoolData();
  const tokenPrices = useTokenPrices([symbol]);

  const items = useMemo(() => {
    const pool = pools[symbol];
    const price = tokenPrices[symbol] ?? 0;
    // No oracle price → "—" rather than a made-up $ figure.
    const usd = (n: number) => (price > 0 ? `$${fmt(n * price, 2)}` : "—");
    if (!pool?.initialised) {
      return [
        { id: "1", name: "Total Supply", amount: "—" },
        { id: "2", name: "Available Liquidity", amount: "—" },
        { id: "3", name: "Utilization Rate", amount: "—" },
        { id: "4", name: "Supply APY", amount: "—" },
      ];
    }
    return [
      { id: "1", name: "Total Supply", amount: usd(pool.totalSupplied), amountInToken: `${fmt(pool.totalSupplied)} ${symbol}` },
      { id: "2", name: "Available Liquidity", amount: usd(pool.availableLiquidity), amountInToken: `${fmt(pool.availableLiquidity)} ${symbol}` },
      { id: "3", name: "Utilization Rate", amount: `${(pool.utilization * 100).toFixed(2)}%` },
      { id: "4", name: "Supply APY", amount: `${(pool.supplyApr * 100).toFixed(2)}%` },
    ];
  }, [pools, symbol, tokenPrices]);

  return <AccountStatsGhost items={items} />;
});

// "Margin Managers" (a Stellar tiered-lending concept) has no Solana equivalent and was
// dropped; its real on-chain counterparts (collateral / borrow enablement, per-margin caps,
// liquidation threshold & bonus) live under "Collateral and Limits".
const tabs = [
  { id: "your-positions", label: "Your Positions", shortLabel: "Positions" },
  { id: "details", label: "Details" },
  { id: "activity", label: "Activity" },
  { id: "collateral-limits", label: "Collateral and Limits", shortLabel: "Collateral" },
  { id: "analytics", label: "Analytics" },
];

export default function EarnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { isDark } = useTheme();
  const router = useRouter();
  const selectedVault = useEarnVaultStore((state) => state.selectedVault);
  const [activeTab, setActiveTab] = useState<string>("details");

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
  };

  // Deep-link into the "Your Positions" tab (e.g. from Portfolio's Lender
  // "Current Positions" row) via /earn/{id}?tab=your-positions. Read directly
  // off the URL rather than next/navigation's useSearchParams so this doesn't
  // force a Suspense boundary on an otherwise fully client-rendered page.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab === "your-positions") queueMicrotask(() => setActiveTab("your-positions"));
  }, []);

  const handleBackToPools = () => {
    router.push("/earn");
  };

  // id = registry symbol, case-insensitive ("sol", "jitosol", "wSOL" all resolve).
  const token = findToken(decodeURIComponent(id));
  const symbol = token?.symbol ?? null;

  useEffect(() => {
    if (!symbol) return;
    const current = useSelectedPoolStore.getState();
    if (current.selectedAsset === symbol) return;
    setSelectedPool(symbol, { id: symbol, chain: symbol, title: symbol, tag: "Active" });
  }, [symbol]);

  const { pools } = usePoolData();
  const pool = symbol ? pools[symbol] : undefined;
  // Tabs / forms read the selected pool from the store; render them only once the store has
  // caught up with the route so they never flash the previously viewed pool's figures.
  const storeSymbol = useSelectedPoolStore((state) => state.selectedAsset);
  const storeReady = storeSymbol === symbol;

  // Get vault data - either from store or use the registry symbol as fallback. The status tag
  // is the Reserve's on-chain status (Active / Supply only / Repay only / Frozen).
  const vaultData = useMemo(() => {
    if (selectedVault && symbol && selectedVault.id === symbol) {
      return { ...selectedVault, tag: pool?.status ?? selectedVault.tag };
    }
    return {
      id: symbol ?? id,
      chain: symbol ?? id,
      title: symbol ?? id,
      tag: pool ? (pool.initialised ? pool.status : "Not initialised") : "Active",
    };
  }, [selectedVault, symbol, id, pool]);

  if (!token || !symbol) {
    return (
      <main className="flex flex-col gap-4 pt-10 px-4 sm:px-10 lg:px-30 items-start">
        <h1 className={`text-[20px] sm:text-[25px] font-bold ${isDark ? "text-white" : "text-[#181822]"}`}>Pool not found</h1>
        <p className={`text-[14px] font-medium ${isDark ? "text-[#A7A7A7]" : "text-[#5A5555]"}`}>
          There is no Vanna lending pool for &quot;{decodeURIComponent(id)}&quot;. Supported pools: {TOKEN_SYMBOLS.join(", ")}.
        </p>
        <button
          type="button"
          onClick={handleBackToPools}
          className="text-[15px] font-medium text-[#703AE6] hover:underline cursor-pointer"
        >
          Back to pools
        </button>
      </main>
    );
  }

  const iconPath = tokenIcon(symbol);

  return (
    <main className="flex flex-col gap-5">
      <header className="pt-4 sm:pt-5 px-4 sm:px-10 lg:px-30 w-full h-fit">
        <div className="w-full h-fit flex flex-col gap-3">
          <nav aria-label="Breadcrumb">
            <button
              type="button"
              onClick={handleBackToPools}
              className={`w-fit h-fit flex gap-[10px] items-center cursor-pointer text-[15px] font-medium hover:text-[#703AE6] transition-colors ${
                isDark ? "text-white" : "text-[#5A5555]"
              }`}
            >
              <svg width="8" height="14" viewBox="0 0 9 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 1L1 8L8 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back to pools
            </button>
          </nav>
          <div className="w-full h-fit flex gap-3 items-center">
            <Image
              src={iconPath}
              alt={`${vaultData.title}-icon`}
              width={34}
              height={34}
              className="w-7 h-7 sm:w-[34px] sm:h-[34px]"
            />
            <div className="w-fit h-fit flex gap-2 items-center flex-wrap">
              <h1 className={`w-fit h-fit text-[20px] sm:text-[25px] font-bold ${isDark ? "text-white" : "text-[#181822]"}`}>
                {vaultData.title}
              </h1>
              <div className="w-fit h-fit flex gap-1.5 items-center">
                <span className="text-[11px] sm:text-[13px] font-semibold text-center w-fit h-fit rounded-[4px] py-[2px] px-[6px] bg-[#703AE6] text-white">
                  {vaultData.tag}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="px-4 sm:px-10 lg:px-30" aria-label="Vault Statistics">
        <EarnHeaderStats symbol={symbol} />
      </section>

      <section className="px-4 sm:px-10 lg:px-30 pt-1 pb-24 xl:pb-16 w-full h-fit" aria-label="Vault Details and Actions">
        <div className="flex flex-col xl:flex-row gap-5 xl:gap-4 w-full h-fit">
          <article className="flex-1 min-w-0 h-full flex flex-col gap-3">
            <nav className="w-full overflow-x-auto no-scrollbar" aria-label="Vault Information Tabs">
              <AnimatedTabs
                tabs={tabs}
                activeTab={activeTab}
                onTabChange={handleTabChange}
                type="border"
                shortLabelBelow="2xl"
                containerClassName={`w-full rounded-xl border p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E5E7EB]"}`}
                tabClassName="!flex-1 !h-10 !px-2 !text-[12px] whitespace-nowrap"
              />
            </nav>
            {storeReady && activeTab === "your-positions" && <YourPositions />}
            {storeReady && activeTab === "details" && <Details />}
            {storeReady && activeTab === "activity" && <ActivityTab />}
            {storeReady && activeTab === "analytics" && <AnalyticsTab />}
            {storeReady && activeTab === "collateral-limits" && <CollateralLimitsTab />}
          </article>
          <aside className="w-full xl:w-[420px] shrink-0 flex flex-col gap-3 xl:sticky xl:top-4 xl:self-start" aria-label="Transaction Form">
            {storeReady && <Form />}

            {/* How it works */}
            <div className={`w-full rounded-2xl border p-4 flex flex-col gap-3 ${
              isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]"
            }`}>
              <p className={`text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                How it works
              </p>
              <div className="flex flex-col gap-3">
                {[
                  { step: "1", title: "Supply assets", desc: `Deposit ${vaultData.title} into the vault to provide liquidity` },
                  { step: "2", title: "Receive vault shares", desc: `Get v${vaultData.title} share tokens representing your share of the pool` },
                  { step: "3", title: "Earn yield", desc: "Borrowers pay interest which accrues to your position automatically" },
                  { step: "4", title: "Withdraw anytime", desc: "Redeem your vault shares for the underlying asset plus earned yield, up to the pool's available liquidity" },
                ].map((item) => (
                  <div key={item.step} className="flex gap-3 items-start">
                    <div className="w-6 h-6 rounded-full bg-[#703AE6]/10 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-[11px] font-bold text-[#703AE6]">{item.step}</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className={`text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>{item.title}</span>
                      <span className={`text-[12px] font-medium leading-relaxed ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>{item.desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
