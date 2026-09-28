'use client';

/**
 * Supply panel for the earn form (current implementation). Lets the user pick a
 * pool, enter an amount (with %-of-balance pills), previews the vault shares
 * and projected earnings via {@link InfoCard}, and submits the supply mutation
 * (`lender_supply` via {@link useSupplyLiquidity}, which drives the tx-progress
 * modal + toast itself).
 *
 * Available balance is asset-aware: native SOL keeps SOL_FEE_RESERVE_LAMPORTS
 * back for fees / ATA rent; SPL tokens use the full wallet ATA balance. All
 * balance / cap / first-supply checks are done in exact base units (bigint),
 * mirroring what the program will check on-chain.
 */
import { useState, useEffect, useMemo, useRef, memo } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { InfoCard } from "../margin/info-card";
import { Button } from "../ui/button";
import { motion, AnimatePresence } from "framer-motion";
import { useTheme } from "@/contexts/theme-context";
import { useUserStore } from "@/store/user";
import { useSupplyLiquidity, usePoolData, usePoolDetails } from "@/hooks/use-earn";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useSelectedPoolStore } from "@/store/selected-pool-store";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { TOKENS, tokenIcon } from "@/lib/solana/tokens";
import { SOL_FEE_RESERVE_LAMPORTS } from "@/lib/solana/balances";
import { previewSupplyShares } from "@/lib/solana/lend";
import { fromRaw, lenderTotalAssets, MIN_INITIAL_SHARES, toRaw } from "@/lib/solana/math";
import { resolveToken, shortAddress } from "./earn-utils";

/** Parse a UI amount into raw base units; null when the text isn't a valid amount. */
const safeRaw = (value: string, decimals: number): bigint | null => {
  if (!value) return null;
  try {
    return toRaw(value, decimals);
  } catch {
    return null;
  }
};

/** Memoized supply-liquidity panel; selected pool is driven by the route/store. */
export const SupplyLiquidityTab = memo(function SupplyLiquidityTab() {
  const { isDark } = useTheme();
  const router = useRouter();
  const selectedAsset = useSelectedPoolStore((state) => state.selectedAsset);
  const token = resolveToken(selectedAsset) ?? TOKENS[0];
  const selectedOption = token.symbol;

  const [amount, setAmount] = useState<string>("");
  const [selectedPercentage, setSelectedPercentage] = useState<number>(0);
  const [poolDropdownOpen, setPoolDropdownOpen] = useState(false);
  const poolDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!poolDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (poolDropdownRef.current && !poolDropdownRef.current.contains(e.target as Node)) {
        setPoolDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [poolDropdownOpen]);

  const userAddress = useUserStore((state) => state.address);
  const storeTokenBalances = useUserStore((state) => state.tokenBalances);

  const supply = useSupplyLiquidity();
  const { pools } = usePoolData();
  const { details } = usePoolDetails();
  const tokenPrices = useTokenPrices([selectedOption]);

  const selectedPool = pools[selectedOption];
  const poolDetail = details[selectedOption];

  // Spendable wallet balance in raw units. SOL keeps SOL_FEE_RESERVE_LAMPORTS back so the
  // wallet can still pay fees and the temporary wSOL account's rent.
  const availableRaw = useMemo(() => {
    const raw = safeRaw(storeTokenBalances[selectedOption] ?? "0", token.decimals) ?? 0n;
    if (!token.isNative) return raw;
    const spendable = raw - SOL_FEE_RESERVE_LAMPORTS;
    return spendable > 0n ? spendable : 0n;
  }, [storeTokenBalances, selectedOption, token]);
  const availableBalance = Number(fromRaw(availableRaw, token.decimals));

  const handlePercentageClick = (percent: number) => {
    setSelectedPercentage(percent);
    if (availableRaw > 0n) {
      // Exact base-unit math (no float rounding), so the 100% pill can never nudge the
      // amount above the spendable balance.
      setAmount(fromRaw((availableRaw * BigInt(percent)) / 100n, token.decimals));
    }
  };

  useEffect(() => {
    setAmount("");
    setSelectedPercentage(0);
  }, [selectedAsset]);

  const amountRaw = safeRaw(amount, token.decimals);

  // First-ever supply to an empty pool must mint at least MIN_INITIAL_SHARES base units
  // (the program's BelowMinimumInitialSupply guard) — shares are 1:1 with assets then.
  const isFirstSupply = poolDetail ? poolDetail.shareSupply === 0n : selectedPool?.shareSupply === "0";
  const minFirstSupply = fromRaw(MIN_INITIAL_SHARES, token.decimals);
  const belowFirstSupplyMin = isFirstSupply && amountRaw !== null && amountRaw > 0n && amountRaw < MIN_INITIAL_SHARES;

  // Supply cap (0 = uncapped): lender_total_assets + amount must stay ≤ cap.
  const capHeadroomRaw = useMemo(() => {
    const reserve = poolDetail?.reserve;
    if (!reserve || reserve.supplyCap === 0n || !poolDetail?.projected) return null;
    const room = reserve.supplyCap - lenderTotalAssets(poolDetail.projected);
    return room > 0n ? room : 0n;
  }, [poolDetail]);
  const exceedsCap = capHeadroomRaw !== null && amountRaw !== null && amountRaw > capHeadroomRaw;

  // Reserve status gate (program: supply allowed only while Active / Supply only).
  const supplyAllowed = !selectedPool || (selectedPool.initialised && (selectedPool.status === "Active" || selectedPool.status === "Supply only"));

  const handleSupply = async () => {
    if (!amountRaw || amountRaw <= 0n || !userAddress) return;
    try {
      // The hook shows the progress modal, success toast and a readable error
      // (describeError), and refreshes pools / positions / wallet balances afterwards.
      await supply.mutateAsync({ symbol: selectedOption, amount });
      setAmount("");
      setSelectedPercentage(0);
    } catch {
      // Error already surfaced by useSupplyLiquidity.
    }
  };

  // Calculate preview data for InfoCard — straight from the projected on-chain state.
  const exchangeRate = selectedPool?.exchangeRate ?? 1;
  const supplyAPY = (selectedPool?.supplyApr ?? 0) * 100;
  const amountNum = amountRaw ? Number(fromRaw(amountRaw, token.decimals)) : 0;
  // USD value of the amount being supplied (oracle price; "—" when no price, never a guess).
  const unitPriceUsd = tokenPrices[selectedOption] ?? 0;
  const formattedUsd = unitPriceUsd > 0
    ? `$${(amountNum * unitPriceUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";
  const sharesPreviewRaw = poolDetail && amountRaw ? previewSupplyShares(poolDetail, amountRaw) : null;
  const sharesPreview = sharesPreviewRaw !== null
    ? fromRaw(sharesPreviewRaw, token.decimals)
    : exchangeRate > 0 ? (amountNum / exchangeRate).toFixed(token.decimals) : "0";
  // Projection at the CURRENT supply APY — the rate moves with utilization, so this is an
  // estimate, labelled as such (no invented "from/to" range or bonus/rewards split).
  const monthlyEarnings = (amountNum * supplyAPY) / 100 / 12;
  const yearlyEarnings = (amountNum * supplyAPY) / 100;
  const tokenFmt = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${selectedOption}`;

  const infoData = useMemo(() => ({
    youGetVToken: `${sharesPreview} v${selectedOption}`,
    tokenPerVToken: exchangeRate.toFixed(9).replace(/\.?0+$/, ""),
    currentAPY: `${supplyAPY.toFixed(2)}%`,
    projectedMonthly: tokenFmt(monthlyEarnings),
    projectedYearly: tokenFmt(yearlyEarnings),
    poolAvailable: selectedPool ? tokenFmt(selectedPool.availableLiquidity) : "—",
    supplyCapRoom: capHeadroomRaw === null ? "Uncapped" : `${fromRaw(capHeadroomRaw, token.decimals)} ${selectedOption}`,
  }), [sharesPreview, exchangeRate, supplyAPY, monthlyEarnings, yearlyEarnings, selectedOption, selectedPool, capHeadroomRaw, token.decimals]); // eslint-disable-line react-hooks/exhaustive-deps

  const infoPropsData = useMemo(() => ({
    data: infoData,
    expandableSections: [
      {
        title: "More Details",
        headingBold: false,
        defaultExpanded: false,
        items: [
          { id: "youGetVToken", name: `You Get (v${selectedOption})` },
          { id: "tokenPerVToken", name: `${selectedOption} per v${selectedOption}` },
          { id: "currentAPY", name: "Current Supply APY" },
          { id: "projectedMonthly", name: "Est. Monthly Earnings (at current APY)" },
          { id: "projectedYearly", name: "Est. Yearly Earnings (at current APY)" },
          { id: "supplyCapRoom", name: "Remaining Supply Cap" },
        ],
      },
    ],
    showExpandable: true,
  }), [infoData, selectedOption]);

  const getButtonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (supply.isPending) return "Supplying...";
    if (!supplyAllowed) return selectedPool?.initialised ? `Pool is ${selectedPool.status}` : "Pool not initialised";
    if (!amountRaw || amountRaw <= 0n) return "Enter Amount";
    if (amountRaw > availableRaw) return "Insufficient Balance";
    if (belowFirstSupplyMin) return `First supply min ${minFirstSupply} ${selectedOption}`;
    if (exceedsCap) return "Exceeds Supply Cap";
    return "Supply Liquidity";
  };

  const isButtonDisabled =
    !userAddress || supply.isPending || !supplyAllowed || !amountRaw || amountRaw <= 0n ||
    amountRaw > availableRaw || belowFirstSupplyMin || exceedsCap;

  return (
    <>
      {/* Input card */}
      <div className={`w-full rounded-2xl border flex flex-col ${
        isDark ? "bg-[#111111] border-[#2A2A2A]" : "bg-white border-[#EEEEEE]"
      }`}>
        <div className="flex items-center justify-between px-4 pt-4 pb-2 gap-3">
          {/* Token dropdown */}
          <div className="relative shrink-0" ref={poolDropdownRef}>
            <button
              type="button"
              onClick={() => setPoolDropdownOpen(!poolDropdownOpen)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer transition-colors ${
                isDark ? "bg-[#2A2A2A] hover:bg-[#333333]" : "bg-[#F0F0F0] hover:bg-[#E2E2E2]"
              }`}
              aria-haspopup="listbox"
              aria-expanded={poolDropdownOpen}
            >
              <Image
                src={tokenIcon(selectedOption)}
                alt={selectedOption}
                width={20}
                height={20}
                className="rounded-full w-5 h-5 flex-none"
              />
              <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                {selectedOption}
              </span>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className={`shrink-0 w-3.5 h-3.5 transition-transform duration-200 ${isDark ? "text-[#AAA]" : "text-[#555]"} ${poolDropdownOpen ? "rotate-180" : ""}`}
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            <AnimatePresence>
              {poolDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.15 }}
                  className={`absolute left-0 top-full mt-1 z-50 rounded-xl border shadow-lg overflow-hidden min-w-[140px] ${
                    isDark ? "bg-[#222222] border-[#333333]" : "bg-white border-[#E8E8E8]"
                  }`}
                  role="listbox"
                >
                  {TOKENS.map(({ symbol: opt }) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => {
                        setPoolDropdownOpen(false);
                        if (opt !== selectedOption) router.push(`/earn/${opt}`);
                      }}
                      className={`flex items-center gap-2 w-full px-4 py-2.5 text-[13px] font-medium transition-colors ${
                        opt === selectedOption
                          ? "text-[#703AE6]"
                          : isDark
                            ? "text-white hover:bg-[#333]"
                            : "text-[#111] hover:bg-[#F5F5F5]"
                      }`}
                      role="option"
                      aria-selected={opt === selectedOption}
                    >
                      <Image
                        src={tokenIcon(opt)}
                        alt={opt}
                        width={16}
                        height={16}
                        className="rounded-full"
                      />
                      {opt}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {/* Amount input */}
          <div className="flex-1 min-w-0">
            <label htmlFor="supply-amount" className="sr-only">Supply Amount</label>
            <input
              id="supply-amount"
              onChange={(e) => {
                const sanitized = validateAmountChange(e.target.value);
                if (sanitized === null) return;
                setAmount(sanitized);
                setSelectedPercentage(0);
              }}
              value={amount}
              type="text"
              inputMode="decimal"
              placeholder="0"
              disabled={supply.isPending}
              className={`w-full text-right text-[28px] font-semibold bg-transparent outline-none placeholder:opacity-20 ${
                isDark ? "text-white placeholder:text-white" : "text-[#111111] placeholder:text-[#111111]"
              } ${supply.isPending ? "opacity-50" : ""}`}
            />
            <div className={`text-right text-[12px] font-medium mt-0.5 ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
              ≈ {formattedUsd}
            </div>
          </div>
        </div>

        {/* Balance / preview row + % pills */}
        <div className="flex items-center justify-between gap-2 px-4 pb-3">
          <div className="flex items-center gap-1 shrink-0">
            {DEPOSIT_PERCENTAGES.map((pct) => (
              <motion.button
                key={pct}
                type="button"
                disabled={supply.isPending || availableBalance <= 0}
                onClick={() => handlePercentageClick(pct)}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.93 }}
                transition={{ duration: 0.1 }}
                className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold cursor-pointer border transition-all ${
                  selectedPercentage === pct
                    ? `${PERCENTAGE_COLORS[pct]} text-white border-transparent`
                    : isDark
                      ? "bg-[#2A2A2A] text-[#A7A7A7] border-[#333333] hover:text-white"
                      : "bg-[#F0F0F0] text-[#888888] hover:text-[#555555] border-[#E2E2E2]"
                } ${supply.isPending || availableBalance <= 0 ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                {pct}%
              </motion.button>
            ))}
          </div>
          <span
            className={`text-[10px] font-medium whitespace-nowrap overflow-hidden text-ellipsis min-w-0 ${
              isDark ? "text-[#777777]" : "text-[#A7A7A7]"
            }`}
            title={userAddress ? `Spendable: ${fromRaw(availableRaw, token.decimals)} ${selectedOption}${token.isNative ? ` (${fromRaw(SOL_FEE_RESERVE_LAMPORTS, 9)} SOL kept for fees)` : ""}` : undefined}
          >
            Bal: {userAddress ? `${availableBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${selectedOption}` : `-- ${selectedOption}`}
          </span>
        </div>
      </div>

      <section className="flex flex-col gap-[8px]" aria-label="Supply Details">
        <InfoCard
          data={infoPropsData.data}
          expandableSections={infoPropsData.expandableSections}
          showExpandable={infoPropsData.showExpandable}
        />
      </section>

      <Button
        text={getButtonText()}
        size="large"
        type="gradient"
        disabled={isButtonDisabled}
        onClick={handleSupply}
      />


      {isFirstSupply && selectedPool?.initialised && (
        <div className={`text-xs text-center ${isDark ? "text-gray-500" : "text-gray-500"}`}>
          This pool is empty — the first supply must be at least {minFirstSupply} {selectedOption}.
        </div>
      )}

      {/* Reserve Info */}
      <div className={`text-xs text-center ${isDark ? "text-gray-600" : "text-gray-400"}`}>
        Reserve: {shortAddress(selectedPool?.reserve)}
      </div>
    </>
  );
});
