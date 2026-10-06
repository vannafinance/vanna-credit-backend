'use client';

/**
 * Withdraw panel for the earn form. Redeems vault shares (`lender_redeem` via
 * {@link useWithdrawLiquidity}) back to the underlying asset, with %-of-position
 * pills and an {@link InfoCard} preview of what is received. The amount is
 * entered in UNDERLYING units (the service converts it to shares, rounding up);
 * the 100% pill redeems every share (`all: true`) so no share dust is left
 * behind. SOL is received as native SOL (the service unwraps it in the same tx).
 *
 * Withdrawals are bounded by both the user's position and the pool's available
 * liquidity (borrowed funds can't be withdrawn until repaid). Pool stats and
 * positions refresh through the hook's invalidation + the slot-tick revalidation.
 */
import { useState, useMemo, useEffect, useRef, memo } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { DEPOSIT_PERCENTAGES, PERCENTAGE_COLORS } from "@/lib/constants/margin";
import { InfoCard } from "../margin/info-card";
import { Button } from "../ui/button";
import { motion, AnimatePresence } from "framer-motion";
import { useUserStore } from "@/store/user";
import { useTheme } from "@/contexts/theme-context";
import { useWithdrawLiquidity, usePoolData, useUserPositions } from "@/hooks/use-earn";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { validateAmountChange } from "@/lib/utils/sanitize-amount";
import { useSelectedPoolStore } from "@/store/selected-pool-store";
import { LENDING_TOKENS, TOKENS, tokenIcon } from "@/lib/solana/tokens";
import { fromRaw, toRaw } from "@/lib/solana/math";
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

/** Memoized withdraw-liquidity panel; selected pool is driven by the route/store. */
export const WithdrawLiquidity = memo(function WithdrawLiquidity() {
  const { isDark } = useTheme();
  const router = useRouter();
  const selectedAsset = useSelectedPoolStore((state) => state.selectedAsset);
  const token = resolveToken(selectedAsset) ?? TOKENS[0];
  const selectedOption = token.symbol;

  // Amount in underlying units; `withdrawAll` is set by the 100% pill.
  const [shares, setShares] = useState<string>("");
  const [withdrawAll, setWithdrawAll] = useState(false);
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

  const withdraw = useWithdrawLiquidity();
  const { pools } = usePoolData();
  const { positions } = useUserPositions();
  const tokenPrices = useTokenPrices([selectedOption]);

  const selectedPool = pools[selectedOption];
  const userPosition = positions[selectedOption];

  const positionRaw = userPosition?.assetsRaw ?? 0n;
  const sharesRaw = userPosition?.sharesRaw ?? 0n;
  const vTokenBalance = userPosition?.shares ?? 0;
  const positionAssets = Number(fromRaw(positionRaw, token.decimals));
  const exchangeRate = selectedPool?.exchangeRate ?? 1;
  const supplyAPY = (selectedPool?.supplyApr ?? 0) * 100;
  const poolAvailable = selectedPool?.availableLiquidity ?? 0;
  const redeemAllowed = !selectedPool || selectedPool.status !== "Frozen";

  useEffect(() => {
    setShares("");
    setWithdrawAll(false);
    setSelectedPercentage(0);
  }, [selectedAsset]);

  const handlePercentageClick = (percent: number) => {
    setSelectedPercentage(percent);
    if (positionRaw > 0n) {
      // 100% redeems every share (exact, no dust); partial pills use exact base-unit math.
      if (percent === 100) {
        setWithdrawAll(true);
        setShares(fromRaw(positionRaw, token.decimals));
        return;
      }
      setWithdrawAll(false);
      setShares(fromRaw((positionRaw * BigInt(percent)) / 100n, token.decimals));
    }
  };

  const amountRaw = safeRaw(shares, token.decimals);

  const handleWithdraw = async () => {
    if (!userAddress || (!withdrawAll && (!amountRaw || amountRaw <= 0n))) return;
    try {
      // The hook drives the progress modal / toasts (describeError) and refreshes pools,
      // positions and wallet balances afterwards.
      await withdraw.mutateAsync(withdrawAll ? { symbol: selectedOption, all: true } : { symbol: selectedOption, amount: shares });
      setShares("");
      setWithdrawAll(false);
      setSelectedPercentage(0);
    } catch {
      // Error already surfaced by useWithdrawLiquidity.
    }
  };

  const assetsPreview = amountRaw ? Number(fromRaw(amountRaw, token.decimals)) : 0;
  // Shares burned for this amount (underlying / exchange rate) — display estimate; the
  // service computes the exact share count from the projected reserve.
  const sharesPreview = withdrawAll ? vTokenBalance : exchangeRate > 0 ? assetsPreview / exchangeRate : 0;
  // USD value of what's being withdrawn (oracle price; "—" when unknown).
  const unitPriceUsd = tokenPrices[selectedOption] ?? 0;
  const formattedUsd = unitPriceUsd > 0
    ? `$${(assetsPreview * unitPriceUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "—";

  const tokenFmt = (n: number, sym: string) => `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${sym}`;
  const infoData = useMemo(() => ({
    youGetAsset: tokenFmt(assetsPreview, selectedOption),
    sharesBurned: tokenFmt(sharesPreview, `v${selectedOption}`),
    tokenPerVToken: exchangeRate.toFixed(9).replace(/\.?0+$/, ""),
    currentAPY: `${supplyAPY.toFixed(2)}%`,
    poolAvailable: tokenFmt(poolAvailable, selectedOption),
  }), [assetsPreview, sharesPreview, exchangeRate, supplyAPY, poolAvailable, selectedOption]);
  const infoPropsData = useMemo(() => ({
    data: infoData,
    expandableSections: [
      {
        title: "More Details",
        headingBold: false,
        defaultExpanded: false,
        items: [
          { id: "youGetAsset", name: `You Receive (${selectedOption})` },
          { id: "sharesBurned", name: `Shares Redeemed (v${selectedOption})` },
          { id: "tokenPerVToken", name: `${selectedOption} per v${selectedOption}` },
          { id: "currentAPY", name: "Current Supply APY" },
          { id: "poolAvailable", name: "Pool Available Liquidity" },
        ],
      },
    ],
    showExpandable: true,
  }), [infoData, selectedOption]);

  const exceedsPosition = !withdrawAll && amountRaw !== null && amountRaw > positionRaw;
  const exceedsLiquidity = assetsPreview > poolAvailable + 1e-12;

  const getButtonText = () => {
    if (!userAddress) return "Connect Wallet";
    if (withdraw.isPending) return "Withdrawing...";
    if (!redeemAllowed) return "Pool is Frozen";
    if (sharesRaw === 0n) return "No Position";
    if (!withdrawAll && (!amountRaw || amountRaw <= 0n)) return "Enter Amount";
    if (exceedsPosition) return "Insufficient Balance";
    if (exceedsLiquidity) return "Exceeds Pool Liquidity";
    return withdrawAll ? "Withdraw All" : "Withdraw Liquidity";
  };

  const isButtonDisabled =
    !userAddress || withdraw.isPending || !redeemAllowed || sharesRaw === 0n ||
    (!withdrawAll && (!amountRaw || amountRaw <= 0n)) || exceedsPosition || exceedsLiquidity;

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
                  {LENDING_TOKENS.map(({ symbol: opt }) => (
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
                      v{opt}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          {/* Amount input */}
          <div className="flex-1 min-w-0">
            <label htmlFor="withdraw-amount" className="sr-only">Withdraw Amount</label>
            <input
              id="withdraw-amount"
              onChange={(e) => {
                const sanitized = validateAmountChange(e.target.value);
                if (sanitized === null) return;
                setShares(sanitized);
                setWithdrawAll(false);
                setSelectedPercentage(0);
              }}
              value={shares}
              type="text"
              inputMode="decimal"
              placeholder="0"
              disabled={withdraw.isPending}
              className={`w-full text-right text-[28px] font-semibold bg-transparent outline-none placeholder:opacity-20 ${
                isDark ? "text-white placeholder:text-white" : "text-[#111111] placeholder:text-[#111111]"
              } ${withdraw.isPending ? "opacity-50" : ""}`}
            />
            <div className={`text-right text-[12px] font-medium mt-0.5 ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
              ≈ {formattedUsd}
            </div>
          </div>
        </div>

        {/* Balance / preview row + % pills */}
        <div className="flex items-center justify-between flex-wrap gap-x-2 gap-y-1.5 px-4 pb-3">
          <div className="flex items-center gap-1 flex-wrap">
            {DEPOSIT_PERCENTAGES.map((pct) => (
              <motion.button
                key={pct}
                type="button"
                disabled={withdraw.isPending || positionRaw <= 0n}
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
                } ${withdraw.isPending || positionRaw <= 0n ? "opacity-40 cursor-not-allowed" : ""}`}
              >
                {pct}%
              </motion.button>
            ))}
          </div>
          <span className={`text-[11px] font-medium whitespace-nowrap ${isDark ? "text-[#777777]" : "text-[#A7A7A7]"}`}>
            Supplied: {userAddress ? `${positionAssets.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${selectedOption}` : `-- ${selectedOption}`}
          </span>
        </div>
      </div>

      <section className="flex flex-col gap-[8px]" aria-label="Withdraw Details">
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
        onClick={handleWithdraw}
      />


      {/* Reserve Info */}
      <div className={`text-xs text-center ${isDark ? "text-gray-600" : "text-gray-400"}`}>
        Reserve: {shortAddress(selectedPool?.reserve)}
      </div>
    </>
  );
});
