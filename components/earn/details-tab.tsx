'use client';

/**
 * "Details" tab for an earn pool: a statistics panel (supplied/borrowed pie
 * cards + key metrics like APY, utilization, oracle price, exchange rate,
 * reserve factor, caps, status, rate-curve parameters) and a grid of the
 * pool's on-chain accounts (reserve, asset config, share mint, liquidity vault,
 * price feed, program) with explorer links. Everything is read from the chain
 * (decoded Reserve + AssetConfig via usePoolDetails, oracle price via
 * useTokenPrices). Renders responsive desktop-grid vs. mobile key/value-row layouts.
 */
import { useMemo } from "react";
import { StatsCard } from "../ui/stats-card";
import { AddressBadge } from "../ui/address-badge";
import { formatValue } from "@/lib/utils/format-value";
import { useTheme } from "@/contexts/theme-context";
import { usePoolDetails } from "@/hooks/use-earn";
import { useSelectedPoolStore } from "@/store/selected-pool-store";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { LIQUIDATION_HEALTH_FACTOR, VANNA_PROGRAM_ID } from "@/lib/solana/config";
import { TOKENS } from "@/lib/solana/tokens";
import { WAD, wadToNumber } from "@/lib/solana/math";
import { resolveToken } from "./earn-utils";
import { PublicKey } from "@solana/web3.js";
import { oracleSourceLabel } from "@/lib/solana/oracle";

/**
 * Placeholder statistics descriptors (with em-dash values) exported for reuse
 * on other pages (e.g. the farm detail page) where live pool data isn't wired.
 */
// Static export for use in other pages (e.g. farm detail page)
export const items = [
  { heading: "Available Liquidity", mainInfo: "—", subInfo: "—", tooltip: "Total assets available for borrowing" },
  { heading: "Supply APY", mainInfo: "—", subInfo: "—", tooltip: "Annual percentage yield for suppliers" },
  { heading: "Borrow APY", mainInfo: "—", tooltip: "Annual percentage yield for borrowers" },
  { heading: "Utilization Rate", mainInfo: "—", tooltip: "Ratio of borrowed assets to supplied assets" },
  { heading: "Liquidation Bonus", mainInfo: "—", tooltip: "Bonus paid to liquidators when this asset is seized" },
  { heading: "Oracle Price", mainInfo: "—", tooltip: "Current oracle price of the asset" },
  { heading: "Exchange Rate", mainInfo: "—", subInfo: "—", tooltip: "Exchange rate between the share token and the underlying asset" },
];

/** WAD coefficient → plain decimal string ("0.05"), trimmed. */
const wadStr = (v: bigint): string => {
  const n = wadToNumber(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 6 }) : (v / WAD).toString();
};

/** Address card styled like {@link StatsCard}'s non-pie layout, with a copy + explorer badge. */
const AddressCard = ({ heading, addr, tooltip }: { heading: string; addr: string | null; tooltip: string }) => {
  const { isDark } = useTheme();
  return (
    <div className="w-full h-fit py-[14px]" title={tooltip}>
      <div className="w-fit h-fit flex flex-col gap-[6px]">
        <div className={`text-[11px] font-medium ${isDark ? "text-[#919191]" : "text-[#5C5B5B]"}`}>{heading}</div>
        {addr ? <AddressBadge address={addr} /> : <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>—</span>}
      </div>
    </div>
  );
};

/**
 * Vault details view for the selected pool. Computes supplied/borrowed splits
 * and USD values from the projected on-chain reserve + oracle prices, and lists
 * the pool's on-chain accounts.
 */
export const Details = () => {
  const { isDark } = useTheme();
  const selectedAsset = useSelectedPoolStore((state) => state.selectedAsset);
  const token = resolveToken(selectedAsset) ?? TOKENS[0];
  const selectedAssetLabel = token.symbol;
  const { details, isLoading } = usePoolDetails();

  const pool = details[selectedAssetLabel];
  const asset = pool?.asset ?? null;
  const reserve = pool?.reserve ?? null;
  const tokenPrices = useTokenPrices([selectedAssetLabel]);
  const oraclePrice = tokenPrices[selectedAssetLabel] ?? 0;
  const usd = (n: number) => (oraclePrice > 0 ? `$${formatValue(n * oraclePrice, { type: "number", useLargeFormat: true })}` : "—");
  const amt = (n: number) => `${formatValue(n, { type: "number", useLargeFormat: true })} ${selectedAssetLabel}`;

  const totalSupplied = pool?.totalSupplied ?? 0;
  const totalBorrowed = pool?.totalBorrowed ?? 0;
  const borrowedPercent = Math.min(Math.max((pool?.utilization ?? 0) * 100, 0), 100);
  const suppliedPercent = totalSupplied > 0 ? (100 - borrowedPercent) : 0;

  const addresses = useMemo(() => [
    { heading: `v${selectedAssetLabel} Share Mint`, addr: reserve?.shareMint.toBase58() ?? null, tooltip: `Share token minted to ${selectedAssetLabel} suppliers` },
    { heading: `${selectedAssetLabel} Reserve`, addr: reserve?.address.toBase58() ?? null, tooltip: `Reserve account holding the ${selectedAssetLabel} pool's accounting and rate curve` },
    { heading: "Liquidity Vault", addr: reserve?.liquidityVault.toBase58() ?? null, tooltip: "Token account holding the pool's idle liquidity" },
    { heading: "Asset Config", addr: asset?.address.toBase58() ?? null, tooltip: "Per-asset risk configuration (collateral / borrow flags, caps, oracle)" },
    {
      heading: "Scope Prices",
      addr: asset && !asset.oracle.scopePrices.equals(PublicKey.default) ? asset.oracle.scopePrices.toBase58() : null,
      tooltip: "Kamino Scope price account — the program's primary price source for this asset",
    },
    {
      heading: "Pyth Fallback Feed",
      addr: asset && !asset.oracle.pythPrice.equals(PublicKey.default) ? asset.oracle.pythPrice.toBase58() : null,
      tooltip: "Pyth price account used while the Scope price is stale",
    },
    { heading: `${selectedAssetLabel} Mint`, addr: token.mint.toBase58(), tooltip: token.isNative ? "Wrapped SOL mint (native SOL is wrapped/unwrapped automatically)" : `${selectedAssetLabel} token mint` },
    { heading: "Vanna Lending Program", addr: VANNA_PROGRAM_ID.toBase58(), tooltip: "The Vanna lending program" },
  ], [selectedAssetLabel, reserve, asset, token]);

  const detailItems = useMemo(() => {
    if (!pool?.reserve) return [];
    const curve = pool.reserve.rateCurve;
    return [
      {
        heading: "Available Liquidity",
        mainInfo: amt(pool.availableLiquidity),
        subInfo: usd(pool.availableLiquidity),
        tooltip: `Total ${selectedAssetLabel} available to withdraw or borrow`,
      },
      {
        heading: "Supply APY",
        mainInfo: `${(pool.supplyApr * 100).toFixed(2)}%`,
        subInfo: amt(pool.totalSupplied),
        tooltip: "Borrow rate × utilization × (1 − reserve factor), from the on-chain rate curve",
      },
      {
        heading: "Borrow APY",
        mainInfo: `${(pool.borrowApr * 100).toFixed(2)}%`,
        tooltip: "Rate the on-chain curve charges borrowers at the current utilization",
      },
      {
        heading: "Utilization Rate",
        mainInfo: `${(pool.utilization * 100).toFixed(2)}%`,
        tooltip: "Ratio of borrowed assets to supplied assets",
      },
      {
        heading: "Liquidation Bonus",
        mainInfo: asset ? `${(asset.liquidationBonusBps / 100).toFixed(2)}%` : "—",
        subInfo: `Liquidatable at HF ≤ ${LIQUIDATION_HEALTH_FACTOR.toFixed(2)}`,
        tooltip: "Bonus paid to liquidators when this asset is seized from an unhealthy margin account",
      },
      {
        heading: "Oracle Price",
        mainInfo: oraclePrice > 0 ? `$${oraclePrice.toFixed(oraclePrice < 1 ? 4 : 2)}` : "—",
        subInfo: asset ? `${oracleSourceLabel(asset.oracle)} · max age ${asset.maxPriceAgeSecs}s` : undefined,
        tooltip: `Current oracle price of ${selectedAssetLabel}`,
      },
      {
        heading: "Share Token Exchange Rate",
        mainInfo: pool.exchangeRate.toFixed(9).replace(/\.?0+$/, ""),
        subInfo: `${selectedAssetLabel} per v${selectedAssetLabel}`,
        tooltip: `Exchange rate between v${selectedAssetLabel} and ${selectedAssetLabel}`,
      },
      {
        heading: "Reserve Factor",
        mainInfo: `${(pool.reserveFactor * 100).toFixed(2)}%`,
        tooltip: "Share of borrower interest kept by the protocol",
      },
      {
        heading: "Supply Cap",
        mainInfo: pool.supplyCapUi === null ? "Uncapped" : amt(pool.supplyCapUi),
        subInfo: pool.supplyCapUi === null ? undefined : `${Math.min(100, (pool.totalSupplied / pool.supplyCapUi) * 100).toFixed(2)}% used`,
        tooltip: "Maximum total supply the reserve accepts",
      },
      {
        heading: "Borrow Cap",
        mainInfo: pool.borrowCapUi === null ? "Uncapped" : amt(pool.borrowCapUi),
        subInfo: pool.borrowCapUi === null ? undefined : `${Math.min(100, (pool.totalBorrowed / pool.borrowCapUi) * 100).toFixed(2)}% used`,
        tooltip: "Maximum total borrows the reserve allows",
      },
      {
        heading: "Status",
        mainInfo: pool.statusLabel,
        tooltip: "Active: all actions · Supply only: no new borrows · Repay only: no supply/borrow · Frozen: repay only",
      },
      {
        heading: "Rate Curve",
        mainInfo: `×${wadStr(curve.rateMultiplierWad)}`,
        subInfo: `linear ${wadStr(curve.linearCoeffWad)} · jump ${wadStr(curve.jumpCoeffWad)}`,
        tooltip: "Annual borrow rate = multiplier × (linear × (u + u³²) + jump × u⁶⁴)",
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, asset, selectedAssetLabel, oraclePrice]);

  const notInitialised = !isLoading && !pool?.reserve;

  return (
    <section className={`w-full h-fit flex flex-col gap-[14px] rounded-[16px] border-[1px] ${
      isDark ? "bg-[#111111]" : "bg-[#F4F4F4]"
    }`} aria-label="Vault Details">
      <div className="w-full h-fit rounded-[16px] pt-[16px] px-3 sm:px-[20px] flex flex-col gap-[14px]">
        <h2 className={`w-full h-fit text-[18px] sm:text-[21px] font-semibold ${
          isDark ? "text-white" : ""
        }`}>Statistics</h2>
        <article className={`w-full h-fit flex flex-col sm:flex-row items-center rounded-[14px] gap-[12px] ${
          isDark ? "bg-[#222222]" : "bg-[#FFFFFF]"
        }`} aria-label="Supply and Borrow Overview">
          {isLoading || notInitialised ? (
            <div className={`w-full h-[120px] flex items-center justify-center text-[14px] ${
              isDark ? "text-[#919191]" : "text-[#76737B]"
            }`}>
              {isLoading ? "Loading vault statistics..." : `The ${selectedAssetLabel} pool is not initialised on this network.`}
            </div>
          ) : (
            <>
              <StatsCard
                percentage={suppliedPercent}
                heading="Total Supplied"
                mainInfo={amt(totalSupplied)}
                subInfo={usd(totalSupplied)}
                pie={true}
              />
              <StatsCard
                percentage={borrowedPercent}
                heading="Total Borrowed"
                mainInfo={amt(totalBorrowed)}
                subInfo={usd(totalBorrowed)}
                pie={true}
              />
            </>
          )}
        </article>
        {/* Desktop: grid layout */}
        <article className="hidden sm:grid w-full h-full grid-cols-3 gap-x-3 gap-y-1" aria-label="Vault Statistics">
          {isLoading ? (
            <div className={`col-span-3 h-[200px] flex items-center justify-center text-[14px] ${
              isDark ? "text-[#919191]" : "text-[#76737B]"
            }`}>
              Loading statistics...
            </div>
          ) : (
            detailItems.map((item, idx) => (
              <StatsCard
                key={idx}
                heading={item.heading}
                mainInfo={item.mainInfo}
                subInfo={item.subInfo}
                tooltip={item.tooltip}
              />
            ))
          )}
        </article>
        {/* Mobile: clean key-value rows */}
        <article className={`sm:hidden w-full rounded-xl overflow-hidden border ${isDark ? "border-[#2A2A2A]" : "border-[#E8E8E8]"}`} aria-label="Vault Statistics">
          {isLoading ? (
            <div className={`h-[120px] flex items-center justify-center text-[14px] ${
              isDark ? "text-[#919191]" : "text-[#76737B]"
            }`}>
              Loading statistics...
            </div>
          ) : (
            detailItems.map((item, idx) => (
              <div key={idx} className={`flex items-center justify-between px-4 py-3 ${isDark ? "bg-[#1A1A1A]" : "bg-white"}`}>
                <span className={`text-[12px] font-medium ${isDark ? "text-[#919191]" : "text-[#5C5B5B]"}`}>
                  {item.heading}
                </span>
                <div className="flex flex-col items-end gap-0.5">
                  <span className={`text-[14px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>
                    {item.mainInfo}
                  </span>
                  {item.subInfo && (
                    <span className={`text-[11px] font-medium ${isDark ? "text-[#919191]" : "text-[#5C5B5B]"}`}>
                      {item.subInfo}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </article>
        <article className="w-full h-fit rounded-[16px] pb-[20px] flex flex-col gap-3" aria-label="On-chain Addresses">
          <h3 className={`text-[18px] sm:text-[21px] font-semibold w-full h-fit ${
            isDark ? "text-white" : ""
          }`}>
            Addresses
          </h3>
          {/* Desktop: grid */}
          <div className="hidden sm:grid w-full h-full grid-cols-2 lg:grid-cols-3 gap-x-[12px]">
            {addresses.map((item, idx) => (
              <AddressCard key={idx} heading={item.heading} addr={item.addr} tooltip={item.tooltip} />
            ))}
          </div>
          {/* Mobile: clean rows */}
          <div className={`sm:hidden w-full rounded-xl overflow-hidden border ${isDark ? "border-[#2A2A2A]" : "border-[#E8E8E8]"}`}>
            {addresses.map((item, idx) => (
              <div key={idx} className={`flex items-center justify-between px-4 py-3 ${isDark ? "bg-[#1A1A1A]" : "bg-white"}`}>
                <span className={`text-[12px] font-medium ${isDark ? "text-[#919191]" : "text-[#5C5B5B]"}`}>
                  {item.heading}
                </span>
                {item.addr ? (
                  <AddressBadge address={item.addr} />
                ) : (
                  <span className={`text-[13px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}>—</span>
                )}
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
};
