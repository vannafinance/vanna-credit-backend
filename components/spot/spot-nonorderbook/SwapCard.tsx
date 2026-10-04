"use client";

import { useTheme } from "@/contexts/theme-context";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, refreshMarginAccount } from "@/store/margin-account-info-store";
import { useWallet, refreshWalletBalancesOnChain } from "@/hooks/use-wallet";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { executeWalletSwap, fetchJupiterQuote, type JupiterQuote } from "@/lib/solana/swap";
import { executeMarginSwap, quoteMarginSwap } from "@/lib/solana/exec";
import { fromRaw, toRaw } from "@/lib/solana/math";
import { spendableLamports } from "@/lib/solana/balances";
import { projectHealthFactor } from "@/lib/solana/margin";
import { LIQUIDATION_HEALTH_FACTOR, explorerUrl } from "@/lib/solana/config";
import { describeError } from "@/lib/solana/errors";
import { SwapInput } from "./SwapInput";
import { SwapDirectionButton } from "./SwapDirectionButton";
import { SwapDetails } from "./SwapDetails";
import { SwapButton } from "./SwapButton";
import { TokenSearchModal } from "./TokenSearchModal";
import { SwapSettings, AUTO_SLIPPAGE_PERCENT } from "./SwapSettings";
import { RouteInfo } from "./RouteInfo";
import { Token, SwapButtonState, RouteStep } from "./types";
import { SWAP_TOKENS, routeTokenForMint } from "./registry-tokens";
import { showTxStep, showTxSuccess, showTxError } from "@/lib/tx-progress";
import { amountFromBalancePercent, getMaxSwappableBalance } from "@/lib/utils/swap-amount";

type SwapMode = "wallet" | "margin";

/**
 * Debounce window for quote fetches. Each Jupiter quote is a round trip through our
 * `/api/jupiter/quote` proxy; firing on every keystroke would burn the API quota for a single
 * typed amount. Wait until the user pauses for `QUOTE_DEBOUNCE_MS` before asking.
 */
const QUOTE_DEBOUNCE_MS = 400;
/** A quote older than this is re-fetched right before executing (pool prices move). */
const QUOTE_MAX_AGE_MS = 20_000;

/** Exact decimal string → raw units, or null when the text isn't a valid positive amount. */
function safeRaw(amount: string, decimals: number): bigint | null {
  try {
    const raw = toRaw(amount.replace(/,/g, ""), decimals);
    return raw > 0n ? raw : null;
  } catch {
    return null;
  }
}

/** Format a swap amount with adaptive precision (up to 6 decimals, trailing zeros trimmed). */
function formatSwapAmount(raw: bigint, decimals: number): string {
  const text = fromRaw(raw, decimals);
  const [whole, frac = ""] = text.split(".");
  const trimmed = frac.slice(0, 6).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** Format a price/rate with adaptive precision. Smaller rates need more decimals. */
function formatSwapRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const decimals = n >= 100 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
  return n.toFixed(decimals).replace(/\.?0+$/, "") || "0";
}

/** Jupiter's "no route" responses (COULD_NOT_FIND_ANY_ROUTE / NO_ROUTES_FOUND / TOKEN_NOT_TRADABLE). */
function isNoRouteError(message: string): boolean {
  return /no route|could not find any route|COULD_NOT_FIND_ANY_ROUTE|NO_ROUTES_FOUND|not tradable|TOKEN_NOT_TRADABLE/i.test(message);
}

type RoutePlanStep = { swapInfo?: { label?: string; inputMint?: string; outputMint?: string }; percent?: number };

interface SwapCardProps {
  baseSymbol?: string;
}

export const SwapCard = ({ baseSymbol }: SwapCardProps) => {
  const { isDark } = useTheme();
  const tokenList = SWAP_TOKENS;
  const initialToken = baseSymbol
    ? tokenList.find((t) => t.symbol.toLowerCase() === baseSymbol.toLowerCase()) ?? tokenList[0]
    : tokenList[0];

  // Token state
  const [tokenIn, setTokenIn] = useState<Token | null>(initialToken ?? null);
  const [tokenOut, setTokenOut] = useState<Token | null>(
    tokenList.find((t) => t.id !== initialToken?.id) ?? null,
  );

  // Amount state (amountOut is derived from the live quote)
  const [amountIn, setAmountIn] = useState("");

  // Swaps always run inside the margin account (margin_execute → Jupiter), health-checked
  // on-chain after the swap. The wallet-mode path below is kept but not exposed in the UI.
  const swapMode = "margin" as SwapMode;

  // Settings state
  const [slippage, setSlippage] = useState(AUTO_SLIPPAGE_PERCENT);
  const [slippageMode, setSlippageMode] = useState<"auto" | "custom">("auto");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const slippagePercent = slippageMode === "auto" ? AUTO_SLIPPAGE_PERCENT : slippage;
  const slippageBps = useMemo(() => {
    const n = parseFloat(slippagePercent);
    if (!Number.isFinite(n) || n <= 0) return Math.round(parseFloat(AUTO_SLIPPAGE_PERCENT) * 100);
    return Math.min(5_000, Math.max(1, Math.round(n * 100)));
  }, [slippagePercent]);

  // Modal state
  const [tokenModalTarget, setTokenModalTarget] = useState<"in" | "out" | null>(null);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);

  // Wallet + margin account
  const { address: userAddress, connectWallet } = useWallet();
  const isWalletConnected = Boolean(userAddress);
  const walletBalances = useUserStore((s) => s.tokenBalances);
  const { hasMarginAccount, collateralBalances, grossCollateralValue, totalBorrowedValue } =
    useMarginAccountInfoStore(
      useShallow((s) => ({
        hasMarginAccount: s.hasMarginAccount,
        collateralBalances: s.collateralBalances,
        grossCollateralValue: s.grossCollateralValue,
        totalBorrowedValue: s.totalBorrowedValue,
      })),
    );

  // Margin mode reads the margin vault — make sure the store has the account loaded.
  useEffect(() => {
    if (swapMode === "margin" && userAddress) void refreshMarginAccount(userAddress);
  }, [swapMode, userAddress]);

  // ---------------------------------------------------------------------------------------------
  // Balances (wallet: user store; margin: margin-vault balances). SOL keeps the fee reserve back.
  // ---------------------------------------------------------------------------------------------
  const getBalance = useCallback(
    (token: Token | null): string | null => {
      if (!isWalletConnected || !token) return null;
      if (swapMode === "margin") {
        if (!hasMarginAccount) return "0";
        return collateralBalances[token.symbol]?.amount ?? "0";
      }
      const raw = walletBalances[token.symbol] ?? "0";
      if (token.isNative) {
        const lamports = safeRaw(raw, token.decimals) ?? 0n;
        return fromRaw(spendableLamports(lamports), token.decimals);
      }
      return raw;
    },
    [isWalletConnected, swapMode, hasMarginAccount, collateralBalances, walletBalances],
  );

  const tokenInBalance = getBalance(tokenIn);
  const tokenOutBalance = getBalance(tokenOut);

  const tokenListBalances = useMemo(() => {
    const map: Record<string, string> = {};
    tokenList.forEach((t) => {
      const b = getBalance(t);
      if (b !== null) map[t.id] = (parseFloat(b) || 0).toLocaleString("en-US", { maximumFractionDigits: 4 });
    });
    return map;
  }, [tokenList, getBalance]);

  // Live on-chain (fork Pyth) prices — used only for the USD echo under each input and the
  // margin-mode health projection. Unknown prices are 0 and render as no USD value.
  const swapTokenPrices = useTokenPrices(
    [tokenIn?.symbol, tokenOut?.symbol].filter((s): s is string => Boolean(s)),
  );
  const tokenInPrice = tokenIn ? swapTokenPrices[tokenIn.symbol] ?? 0 : 0;
  const tokenOutPrice = tokenOut ? swapTokenPrices[tokenOut.symbol] ?? 0 : 0;

  // ---------------------------------------------------------------------------------------------
  // Quote (debounced). Both modes → Jupiter via /api/jupiter/quote (margin mode through
  // quoteMarginSwap, the same exact-input routing the margin adapter executes).
  // ---------------------------------------------------------------------------------------------
  const [quote, setQuote] = useState<JupiterQuote | null>(null);
  const [quoteFetchedAt, setQuoteFetchedAt] = useState(0);
  const [quoteError, setQuoteError] = useState<{ noRoute: boolean; message: string } | null>(null);
  const [isQuoteLoading, setIsQuoteLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const quoteRequestId = useRef(0);

  const amountInRaw = tokenIn ? safeRaw(amountIn, tokenIn.decimals) : null;

  const requestQuote = useCallback(
    async (from: Token, to: Token, amountUi: string, raw: bigint): Promise<JupiterQuote> => {
      if (swapMode === "margin") {
        return quoteMarginSwap({ fromSymbol: from.symbol, toSymbol: to.symbol, amount: amountUi, slippageBps });
      }
      return fetchJupiterQuote({ inputMint: from.id, outputMint: to.id, amount: raw, slippageBps });
    },
    [swapMode, slippageBps],
  );

  useEffect(() => {
    const id = ++quoteRequestId.current;
    setQuote(null);
    setQuoteError(null);
    if (!tokenIn || !tokenOut || tokenIn.id === tokenOut.id || amountInRaw === null) {
      setIsQuoteLoading(false);
      return;
    }
    // Show the loading affordance immediately so the UI feels responsive even though the
    // actual fetch is delayed by the debounce window.
    setIsQuoteLoading(true);
    const timer = setTimeout(() => {
      requestQuote(tokenIn, tokenOut, amountIn, amountInRaw)
        .then((q) => {
          if (id !== quoteRequestId.current) return;
          setQuote(q);
          setQuoteFetchedAt(Date.now());
        })
        .catch((error) => {
          if (id !== quoteRequestId.current) return;
          const message = error instanceof Error ? error.message : String(error);
          setQuoteError({ noRoute: isNoRouteError(message), message });
        })
        .finally(() => {
          if (id === quoteRequestId.current) setIsQuoteLoading(false);
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // amountInRaw is derived from amountIn + tokenIn; keyed on primitives to avoid re-running on
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, tokenIn?.id, tokenOut?.id, requestQuote, refreshNonce]);

  // ---------------------------------------------------------------------------------------------
  // Quote-derived display values (all from Jupiter's response — nothing estimated locally)
  // ---------------------------------------------------------------------------------------------
  const outRaw = quote && tokenOut ? BigInt(quote.outAmount) : null;
  const amountOut = outRaw !== null && tokenOut ? formatSwapAmount(outRaw, tokenOut.decimals) : "";

  const formatUsd = (value: number): string =>
    value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const amountInUsd = useMemo(() => {
    const n = parseFloat(amountIn);
    if (!Number.isFinite(n) || n <= 0 || tokenInPrice <= 0) return null;
    return formatUsd(n * tokenInPrice);
  }, [amountIn, tokenInPrice]);
  const amountOutUsd = useMemo(() => {
    const n = parseFloat(amountOut);
    if (!Number.isFinite(n) || n <= 0 || tokenOutPrice <= 0) return null;
    return formatUsd(n * tokenOutPrice);
  }, [amountOut, tokenOutPrice]);

  // Click-to-flip direction for the displayed exchange-rate row.
  const [rateInverted, setRateInverted] = useState(false);
  const handleFlipRate = useCallback(() => setRateInverted((v) => !v), []);

  const exchangeRate = useMemo(() => {
    if (!quote || !tokenIn || !tokenOut) return null;
    const inUi = Number(fromRaw(BigInt(quote.inAmount), tokenIn.decimals));
    const outUi = Number(fromRaw(BigInt(quote.outAmount), tokenOut.decimals));
    if (!(inUi > 0) || !(outUi > 0)) return null;
    return rateInverted
      ? `1 ${tokenOut.symbol} = ${formatSwapRate(inUi / outUi)} ${tokenIn.symbol}`
      : `1 ${tokenIn.symbol} = ${formatSwapRate(outUi / inUi)} ${tokenOut.symbol}`;
  }, [quote, tokenIn, tokenOut, rateInverted]);

  // Price impact as reported by Jupiter's quote (`priceImpactPct` is a fraction).
  const priceImpactInfo = useMemo<{ pct: number | null; label: string | null; level: "low" | "medium" | "high" | null }>(() => {
    const fraction = quote?.priceImpactPct !== undefined ? parseFloat(quote.priceImpactPct) : NaN;
    if (!Number.isFinite(fraction)) return { pct: null, label: null, level: null };
    const pct = Math.abs(fraction) * 100;
    const level = pct < 1 ? "low" : pct < 3 ? "medium" : "high";
    const label = pct < 0.01 ? "<0.01%" : `-${pct.toFixed(2)}%`;
    return { pct, label, level };
  }, [quote]);
  const isHighPriceImpact = priceImpactInfo.pct !== null && priceImpactInfo.pct > 5;

  // Min received = Jupiter's `otherAmountThreshold` (ExactIn: min out after slippage).
  const minReceived =
    quote?.otherAmountThreshold && tokenOut
      ? `${formatSwapAmount(BigInt(quote.otherAmountThreshold), tokenOut.decimals)} ${tokenOut.symbol}`
      : null;

  // Route steps straight from Jupiter's routePlan (AMM label per hop, split % when < 100).
  const route = useMemo<RouteStep[] | null>(() => {
    const plan = (quote?.routePlan ?? []) as RoutePlanStep[];
    if (plan.length === 0) return null;
    return plan.map((step) => ({
      tokenIn: routeTokenForMint(step.swapInfo?.inputMint),
      tokenOut: routeTokenForMint(step.swapInfo?.outputMint),
      protocol: step.swapInfo?.label ?? "Unknown AMM",
      poolFee: step.percent !== undefined && step.percent < 100 ? `${step.percent}%` : undefined,
      percentage: step.percent,
    }));
  }, [quote]);
  const routeLabel = route ? [...new Set(route.map((r) => r.protocol))].join(", ") : null;

  // Project post-swap health factor for margin-mode swaps: collateral changes by (out − in) USD
  // at oracle prices, debt is unchanged. Warning banner only when after ≤ liquidation threshold.
  const futureHealthFactor = useMemo<{ before: number; after: number; showWarning: boolean } | null>(() => {
    if (swapMode !== "margin" || !hasMarginAccount || !quote || !tokenIn || !tokenOut) return null;
    if (!(tokenInPrice > 0) || !(tokenOutPrice > 0) || totalBorrowedValue <= 0) return null;
    const inUsd = Number(fromRaw(BigInt(quote.inAmount), tokenIn.decimals)) * tokenInPrice;
    const outUsd = Number(fromRaw(BigInt(quote.outAmount), tokenOut.decimals)) * tokenOutPrice;
    const before = projectHealthFactor(grossCollateralValue, totalBorrowedValue);
    const after = projectHealthFactor(Math.max(0, grossCollateralValue - inUsd + outUsd), totalBorrowedValue);
    if (before === null || after === null) return null;
    return { before, after, showWarning: after <= LIQUIDATION_HEALTH_FACTOR };
  }, [swapMode, hasMarginAccount, quote, tokenIn, tokenOut, tokenInPrice, tokenOutPrice, grossCollateralValue, totalBorrowedValue]);

  const formatHfLabel = (hf: number): string => {
    if (!Number.isFinite(hf) || hf <= 0) return "—";
    return hf.toFixed(2);
  };

  // ---------------------------------------------------------------------------------------------
  // Execution — wallet: Jupiter's own transaction; margin: the swap instruction wrapped in
  // margin_execute (health-checked on-chain after the swap)
  // ---------------------------------------------------------------------------------------------
  const [txHash, setTxHash] = useState("");
  const [txError, setTxError] = useState("");

  const swapMutation = useMutation({
    mutationFn: async () => {
      if (!quote || !tokenIn || !tokenOut || amountInRaw === null) throw new Error("No quote to execute");
      let toExecute = quote;
      // Re-quote a stale quote right before signing. If the fresh quote's minimum output is
      // worse than what the user reviewed, stop and show it instead of silently accepting it.
      if (Date.now() - quoteFetchedAt > QUOTE_MAX_AGE_MS) {
        // Margin swaps re-quote through quoteMarginSwap too (its shorter route fits margin_execute).
        const fresh =
          swapMode === "margin"
            ? await quoteMarginSwap({ fromSymbol: tokenIn.symbol, toSymbol: tokenOut.symbol, amount: amountIn, slippageBps })
            : await fetchJupiterQuote({ inputMint: tokenIn.id, outputMint: tokenOut.id, amount: amountInRaw, slippageBps });
        const reviewedMin = BigInt(quote.otherAmountThreshold ?? quote.outAmount);
        const freshMin = BigInt(fresh.otherAmountThreshold ?? fresh.outAmount);
        setQuote(fresh);
        setQuoteFetchedAt(Date.now());
        if (freshMin < reviewedMin) {
          throw new Error("The price moved since your quote. Review the updated quote and swap again.");
        }
        toExecute = fresh;
      }
      showTxStep(`Swapping ${amountIn} ${tokenIn.symbol} for ${tokenOut.symbol}${swapMode === "margin" ? " in your margin account" : ""} — approve in your wallet`);
      if (swapMode === "margin") {
        const result = await executeMarginSwap(
          { fromSymbol: tokenIn.symbol, toSymbol: tokenOut.symbol, amount: amountIn, slippageBps },
          toExecute,
        );
        return result.signature;
      }
      return executeWalletSwap(toExecute);
    },
    onMutate: () => {
      setTxError("");
      setTxHash("");
    },
    onSuccess: (signature) => {
      setTxHash(signature);
      showTxSuccess(`Swapped ${amountIn} ${tokenIn?.symbol} for ${tokenOut?.symbol}`);
      setAmountIn("");
      if (userAddress) {
        void refreshWalletBalancesOnChain(userAddress);
        void refreshMarginAccount(userAddress);
      }
    },
    onError: (error) => {
      const errorMsg = describeError(error, "Swap failed");
      setTxError(errorMsg);
      showTxError(errorMsg);
    },
  });

  const isSwapping = swapMutation.isPending;
  const isActionLoading = isQuoteLoading || isSwapping;

  const buttonState: SwapButtonState = (() => {
    if (!isWalletConnected) return "connect_wallet";
    if (!tokenIn || !tokenOut) return "select_token";
    if (amountInRaw === null) return "enter_amount";
    if (isQuoteLoading) return "loading_quote";
    if (swapMode === "margin" && !hasMarginAccount) return "no_margin_account";
    const balanceRaw = tokenInBalance !== null ? safeRaw(tokenInBalance, tokenIn.decimals) ?? 0n : null;
    if (balanceRaw !== null && amountInRaw > balanceRaw) return "insufficient_balance";
    if (quoteError?.noRoute) return "no_route";
    if (!quote) return "disabled";
    return "ready";
  })();

  const hasQuote = Boolean(quote && tokenIn && tokenOut && !isQuoteLoading);

  // Handlers
  const handleFlip = useCallback(() => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    // Carry the quoted output over as the new input (like the Stellar card did).
    setAmountIn(amountOut);
    setTxHash("");
  }, [tokenIn, tokenOut, amountOut]);

  const handleTokenSelect = useCallback(
    (token: Token) => {
      // Picking the token already on the other side flips the pair instead of producing a
      // same-token "swap".
      if (tokenModalTarget === "in") {
        if (token.id === tokenOut?.id) setTokenOut(tokenIn);
        setTokenIn(token);
      } else {
        if (token.id === tokenIn?.id) setTokenIn(tokenOut);
        setTokenOut(token);
      }
      setAmountIn("");
      setTokenModalTarget(null);
    },
    [tokenModalTarget, tokenIn, tokenOut],
  );

  const handleMaxClick = useCallback(() => {
    if (tokenInBalance && tokenIn) setAmountIn(getMaxSwappableBalance(tokenInBalance, 0n, tokenIn.decimals));
  }, [tokenInBalance, tokenIn]);

  // Preset % state
  const [activePercent, setActivePercent] = useState<number | null>(null);
  const handlePercentClick = useCallback(
    (pct: number) => {
      setActivePercent(pct);
      if (!tokenInBalance || !tokenIn || (safeRaw(tokenInBalance, tokenIn.decimals) ?? 0n) <= 0n) return;
      setAmountIn(amountFromBalancePercent(tokenInBalance, pct, 0n, tokenIn.decimals));
      setTxHash("");
    },
    [tokenInBalance, tokenIn],
  );

  const handleButtonClick = useCallback(() => {
    if (buttonState === "connect_wallet") {
      void connectWallet();
      return;
    }
    if (buttonState !== "ready") return;
    swapMutation.mutate();
  }, [buttonState, connectWallet, swapMutation]);

  const bannerBase = "mt-2 px-3 py-2 rounded-xl text-[12px] font-medium flex items-start gap-2";
  const warnIcon = (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0 mt-0.5">
      <path d="M7 1.5L13 12.5H1L7 1.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7 5.5V8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7" cy="10" r="0.7" fill="currentColor" />
    </svg>
  );

  return (
    <>
      <div
        className={`w-full max-w-[480px] rounded-2xl sm:rounded-3xl overflow-hidden flex flex-col transition-colors ${
          isDark
            ? "bg-[#1A1A1A] border border-[#2A2A2A]"
            : "bg-white border border-[#E8E8E8]"
        }`}
        style={{
          boxShadow: isDark
            ? "0 8px 32px rgba(0,0,0,0.3)"
            : "0 4px 20px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)",
        }}
      >
        {/* Card body */}
        <div className="p-3 sm:p-4 flex flex-col gap-1">
          {/* Swap heading + aggregator label + Settings */}
          <div className="flex items-center justify-between px-0.5 pb-2">
            <div className="relative flex items-center">
              <span
                className={`text-[14px] sm:text-[16px] font-semibold ${isDark ? "text-white" : "text-[#111111]"}`}
              >
                Swap
              </span>
              {/* Jupiter aggregates the fork's pool AMMs, so there is no per-DEX picker. */}
              <span
                className={`flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2.5 py-1 rounded-lg text-[12px] sm:text-[14px] font-medium leading-[18px] ${
                  isDark ? "text-[#777777]" : "text-[#A7A7A7]"
                }`}
                title={routeLabel ? `Current route: ${routeLabel}` : "Routes across Raydium, Orca and Meteora pools"}
              >
                <span>via</span>
                <span className={`font-semibold ${isDark ? "text-[#CCCCCC]" : "text-[#555555]"}`}>Jupiter</span>
              </span>
            </div>

            <button
              type="button"
              onClick={() => setIsSettingsOpen((prev) => !prev)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors ${
                isSettingsOpen
                  ? isDark ? "bg-[#2A2A2A]" : "bg-[#F0F0F0]"
                  : isDark ? "hover:bg-[#2A2A2A]" : "hover:bg-[#F4F4F4]"
              }`}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M6.5 2.5L7.2 1.2C7.3 1.1 7.5 1 7.6 1H8.4C8.5 1 8.7 1.1 8.8 1.2L9.5 2.5L11 3.1L12.3 2.7C12.5 2.6 12.7 2.7 12.8 2.8L13.4 3.4C13.5 3.5 13.6 3.7 13.5 3.9L13.1 5.2L13.7 6.7L15 7.4C15.1 7.5 15.2 7.7 15.2 7.8V8.6C15.2 8.7 15.1 8.9 15 9L13.7 9.7L13.1 11.2L13.5 12.5C13.6 12.7 13.5 12.9 13.4 13L12.8 13.6C12.7 13.7 12.5 13.8 12.3 13.7L11 13.3L9.5 13.9L8.8 15.2C8.7 15.3 8.5 15.4 8.4 15.4H7.6C7.5 15.4 7.3 15.3 7.2 15.2L6.5 13.9L5 13.3L3.7 13.7C3.5 13.8 3.3 13.7 3.2 13.6L2.6 13C2.5 12.9 2.4 12.7 2.5 12.5L2.9 11.2L2.3 9.7L1 9C0.9 8.9 0.8 8.7 0.8 8.6V7.8C0.8 7.7 0.9 7.5 1 7.4L2.3 6.7L2.9 5.2L2.5 3.9C2.4 3.7 2.5 3.5 2.6 3.4L3.2 2.8C3.3 2.7 3.5 2.6 3.7 2.7L5 3.1L6.5 2.5Z" stroke={isSettingsOpen ? "#703AE6" : isDark ? "#555555" : "#B0B0B0"} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                <circle cx="8" cy="8.2" r="2.2" stroke={isSettingsOpen ? "#703AE6" : isDark ? "#555555" : "#B0B0B0"} strokeWidth="1.2" fill="none" />
              </svg>
            </button>
          </div>

          {/* From Token Input */}
          <SwapInput
            label="You Pay"
            token={tokenIn}
            amount={amountIn}
            amountUsd={amountInUsd}
            balance={tokenInBalance}
            onTokenSelect={() => setTokenModalTarget("in")}
            onAmountChange={(val) => { setAmountIn(val); setActivePercent(null); setTxHash(""); }}
            onMaxClick={handleMaxClick}
            showMax
            showPresets
            activePercent={activePercent}
            onPercentClick={handlePercentClick}
            swapMode={swapMode}
          />

          <SwapDirectionButton onClick={handleFlip} />

          {/* To Token Input */}
          <SwapInput
            label="You Receive"
            token={tokenOut}
            amount={amountOut}
            amountUsd={amountOutUsd}
            balance={tokenOutBalance}
            isReadOnly
            isLoading={isQuoteLoading}
            onTokenSelect={() => setTokenModalTarget("out")}
          />

          {/* Swap Details */}
          <div className="mt-2">
            <SwapDetails
              isVisible={hasQuote}
              isExpanded={isDetailsExpanded}
              onToggleExpand={() => setIsDetailsExpanded((prev) => !prev)}
              exchangeRate={exchangeRate}
              onFlipRate={exchangeRate ? handleFlipRate : undefined}
              quoteRate={null}
              priceImpact={priceImpactInfo.label}
              priceImpactLevel={priceImpactInfo.level}
              slippage={slippagePercent}
              minReceived={minReceived}
              fee={null}
              networkCost={null}
              onRefreshRate={() => setRefreshNonce((n) => n + 1)}
              isRefreshing={isQuoteLoading}
              onEditSlippage={() => setIsSettingsOpen(true)}
              healthFactorBefore={futureHealthFactor ? formatHfLabel(futureHealthFactor.before) : null}
              healthFactorAfter={futureHealthFactor ? formatHfLabel(futureHealthFactor.after) : null}
              healthFactorAtRisk={Boolean(futureHealthFactor?.showWarning)}
            />
          </div>

          {/* Jupiter route (AMM per hop) */}
          {hasQuote && route && (
            <div className="mt-2">
              <RouteInfo route={route} dex="Jupiter" />
            </div>
          )}

          {/* No route / quote failure — shown honestly, never replaced by an estimate. */}
          {quoteError && !isQuoteLoading && (
            <div
              className={`${bannerBase} ${
                isDark ? "bg-[#2A2A2A] text-[#CCCCCC] border border-[#333333]" : "bg-[#F7F7F7] text-[#555555] border border-[#EEEEEE]"
              }`}
            >
              {warnIcon}
              <span>
                {quoteError.noRoute
                  ? `No route found for ${tokenIn?.symbol} → ${tokenOut?.symbol} at this amount on the fork's pool AMMs. Try a different amount or pair.`
                  : `Couldn't fetch a quote: ${quoteError.message}`}
              </span>
            </div>
          )}

          {/* High price-impact warning banner (from Jupiter's reported price impact). */}
          {isHighPriceImpact && (
            <div
              className={`${bannerBase} font-semibold ${
                isDark ? "bg-[#FC5457]/10 text-[#FC5457] border border-[#FC5457]/30" : "bg-[#FFF1F1] text-[#C62525] border border-[#FFB3B3]"
              }`}
            >
              {warnIcon}
              <span>
                High price impact{priceImpactInfo.label ? ` (${priceImpactInfo.label})` : ""}. The route&apos;s
                liquidity is too thin for this trade size. Reduce the amount.
              </span>
            </div>
          )}

          {/* Future health-factor warning — margin swaps that would leave HF at or below the
              liquidation threshold. */}
          {futureHealthFactor?.showWarning && (
            <div
              className={`${bannerBase} font-semibold ${
                isDark ? "bg-[#FC5457]/10 text-[#FC5457] border border-[#FC5457]/30" : "bg-[#FFF1F1] text-[#C62525] border border-[#FFB3B3]"
              }`}
            >
              {warnIcon}
              <span>
                This swap would drop your health factor from {formatHfLabel(futureHealthFactor.before)} to{" "}
                {formatHfLabel(futureHealthFactor.after)} (liquidation at {LIQUIDATION_HEALTH_FACTOR}).
              </span>
            </div>
          )}

          {/* Margin mode needs a margin account (the swap runs inside it). */}
          {swapMode === "margin" && isWalletConnected && !hasMarginAccount && (
            <div className={`${bannerBase} ${isDark ? "bg-yellow-500/10 text-yellow-400" : "bg-yellow-50 text-yellow-700"}`}>
              {warnIcon}
              <span>Swaps run inside your margin account — create one in the Margin section first.</span>
            </div>
          )}

          {/* Swap CTA Button */}
          <div className="mt-2">
            <SwapButton
              state={buttonState}
              onClick={handleButtonClick}
              tokenSymbol={tokenIn?.symbol}
              isLoading={isActionLoading}
            />
          </div>

          {/* Last swap result */}
          {txHash && (
            <a
              href={explorerUrl("tx", txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 text-center text-[12px] font-semibold text-[#703AE6] hover:text-[#8D61EB] transition-colors"
            >
              Swap confirmed — view transaction
            </a>
          )}
          {txError && !isSwapping && (
            <p className="mt-2 text-center text-[12px] font-medium text-[#FC5457]">{txError}</p>
          )}
        </div>
      </div>

      {/* Settings Modal */}
      <SwapSettings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        slippage={slippage}
        onSlippageChange={setSlippage}
        slippageMode={slippageMode}
        onSlippageModeChange={setSlippageMode}
      />

      {/* Token Search Modal — the whole registry, both sides (Jupiter routes any pair). */}
      <TokenSearchModal
        isOpen={tokenModalTarget !== null}
        onClose={() => setTokenModalTarget(null)}
        onSelect={handleTokenSelect}
        tokens={tokenList}
        popularTokens={tokenList.slice(0, 5)}
        balances={tokenListBalances}
      />
    </>
  );
};
