"use client";

/**
 * Delta-neutral (basis) vault detail page — /farm/basis/:id. UI preview: vault figures are sample
 * data from lib/farm/basis-vaults.ts; the margin balances, debts, borrow APYs and health factor
 * the deposit panel works from are read live (account snapshot + Vanna pools).
 */
import { useMemo, useState } from "react";
import Image from "next/image";
import { useParams, useRouter } from "next/navigation";
import { useTheme } from "@/contexts/theme-context";
import { ChevronLeftIcon } from "@/components/icons";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { useUserStore } from "@/store/user";
import { useAccountSnapshot } from "@/hooks/use-account-snapshot";
import { usePoolData } from "@/hooks/use-earn";
import { BASIS_DEPOSIT_TOKENS, findBasisVault, fmtPct, fmtSignedPct, fmtUsdCompact } from "@/lib/farm/basis-vaults";
import { BasisActionPanel, type BasisAccountInputs } from "@/components/farm/basis/basis-action-panel";
import { BasisAnalytics, BasisOverview, BasisTransactions } from "@/components/farm/basis/basis-sections";
import { SampleDataBadge } from "@/components/farm/basis/basis-ui";

const UI_TABS = [
  { id: "overview", label: "Overview" },
  { id: "analytics", label: "Analytics" },
  { id: "all-transactions", label: "All Transactions" },
];

export default function BasisVaultPage() {
  const params = useParams();
  const id = params?.id as string;
  const router = useRouter();
  const { isDark } = useTheme();
  const vault = findBasisVault(id);
  const [activeTab, setActiveTab] = useState("overview");
  const [token, setToken] = useState<string>("USDC");

  const userAddress = useUserStore((s) => s.address);
  const { snapshot } = useAccountSnapshot(userAddress);
  const { pools } = usePoolData();

  const account = useMemo<BasisAccountInputs>(() => {
    const margin = snapshot?.api?.margin;
    const balances: Record<string, number> = {};
    const debts: Record<string, number> = {};
    const prices: Record<string, number | null> = {};
    const borrowApy: Record<string, number | null> = {};
    for (const t of BASIS_DEPOSIT_TOKENS) {
      balances[t] = margin?.collateral.filter((c) => c.symbol === t).reduce((s, c) => s + c.amount, 0) ?? 0;
      debts[t] = margin?.debts.filter((d) => d.symbol === t).reduce((s, d) => s + d.debt, 0) ?? 0;
      prices[t] = margin?.prices?.[t]?.usd ?? null;
      const pool = pools[t];
      borrowApy[t] = pool ? pool.borrowApr * 100 : null;
    }
    return { connected: Boolean(userAddress), hasMargin: Boolean(margin?.exists), balances, debts, prices, borrowApy };
  }, [snapshot, pools, userAddress]);

  const muted = isDark ? "text-[#A7A7A7]" : "text-[#777777]";
  const strong = isDark ? "text-white" : "text-[#111111]";

  const back = (
    <nav aria-label="Breadcrumb">
      <button
        type="button"
        onClick={() => router.push("/farm?category=delta-neutral")}
        className={`w-fit h-fit flex gap-2 items-center cursor-pointer text-[15px] font-medium hover:text-[#703AE6] transition-colors ${isDark ? "text-white" : "text-[#5A5555]"}`}
      >
        <ChevronLeftIcon />
        Back to pools
      </button>
    </nav>
  );

  if (!vault) {
    return (
      <main className="flex flex-col gap-5 px-4 sm:px-10 lg:px-30 pt-4 sm:pt-5 pb-16">
        {back}
        <section className={`w-full rounded-2xl border p-8 text-center ${isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"}`}>
          <h1 className={`text-[18px] font-semibold ${strong}`}>Vault not found</h1>
          <p className={`text-[13px] font-medium mt-2 ${muted}`}>&ldquo;{id}&rdquo; isn&apos;t a delta-neutral vault.</p>
        </section>
      </main>
    );
  }

  const v = vault;
  const stats: { k: string; value: React.ReactNode; tip?: string }[] = [
    { k: "Vault APY (7D)", value: fmtPct(v.apy7), tip: "After perp fees, execution and the vault fee." },
    { k: "Vault APY (30D)", value: fmtPct(v.apy30) },
    {
      k: "Funding Now",
      value: <span className={v.fundingNow >= 0 ? (isDark ? "text-[#3FC0A3]" : "text-[#0B7A63]") : isDark ? "text-[#F0666E]" : "text-[#C9333B]"}>{fmtSignedPct(v.fundingNow)}</span>,
      tip: "Annualised. Positive means shorts get paid.",
    },
    { k: "Net Delta", value: fmtSignedPct(v.delta, 2), tip: "Spot minus short, as a share of the vault." },
    {
      k: "TVL / Cap",
      value: (
        <>
          {fmtUsdCompact(v.tvl)} <small className={`text-[13px] font-medium ${muted}`}>/ {fmtUsdCompact(v.cap)}</small>
        </>
      ),
    },
  ];

  return (
    <main className="flex flex-col gap-4 px-4 sm:px-10 lg:px-30 pt-4 sm:pt-5 pb-24 xl:pb-16">
      <header className="flex flex-col gap-3">
        {back}
        <div className="flex gap-2 items-center flex-wrap">
          <Image src={v.icon} alt="" width={26} height={26} className="w-6 h-6 sm:w-7 sm:h-7 rounded-full" />
          <h1 className={`text-[18px] sm:text-[20px] font-bold ${isDark ? "text-white" : "text-[#181822]"}`}>{v.name}</h1>
          {["Vault", "Jupiter", "Phoenix"].map((tag) => (
            <span key={tag} className="text-[10px] sm:text-[12px] font-semibold rounded px-1.5 py-0.5 bg-[#703AE6] text-white">
              {tag}
            </span>
          ))}
          <SampleDataBadge />
        </div>
      </header>

      <section
        aria-label="Vault statistics"
        className={`rounded-xl border p-3 grid grid-cols-2 gap-x-2 gap-y-4 md:flex md:justify-between tabular-nums ${isDark ? "bg-[#1A1A1A] border-[#2A2A2A]" : "bg-white border-[#E8E8E8]"}`}
      >
        {stats.map((s) => (
          <article key={s.k} className="flex-1 min-w-0 px-2 md:px-4 flex flex-col gap-1.5">
            <div className={`flex items-center gap-1 text-[12px] font-medium whitespace-nowrap ${muted}`}>
              {s.k}
              {s.tip && <InfoTooltip content={s.tip} label={s.k} />}
            </div>
            <div className={`text-[20px] font-semibold leading-tight whitespace-nowrap ${strong}`}>{s.value}</div>
          </article>
        ))}
      </section>

      <div className="flex flex-col xl:flex-row gap-4 w-full">
        <article className="flex-1 min-w-0 flex flex-col gap-3">
          <AnimatedTabs
            tabs={UI_TABS}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            type="border"
            containerClassName={`w-full rounded-xl border p-1 ${isDark ? "bg-[#111111] border-[#333333]" : "bg-white border-[#E5E7EB]"}`}
            tabClassName="!flex-1 !px-2 text-[12px]"
          />
          <div className={`w-full flex flex-col gap-4 rounded-2xl border p-4 sm:p-6 ${isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-[#F7F7F7] border-[#E8E8E8]"}`}>
            {activeTab === "analytics" ? (
              <BasisAnalytics vault={v} />
            ) : activeTab === "all-transactions" ? (
              <BasisTransactions vault={v} />
            ) : (
              <BasisOverview vault={v} token={token} borrowApy={account.borrowApy[token]} />
            )}
          </div>
        </article>

        <aside className="w-full xl:w-[420px] shrink-0 flex flex-col gap-3 xl:sticky xl:top-4 xl:self-start">
          <BasisActionPanel vault={v} token={token} onToken={setToken} account={account} />
        </aside>
      </div>
    </main>
  );
}
