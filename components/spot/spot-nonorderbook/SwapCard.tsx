"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/shallow";
import { useUserStore } from "@/store/user";
import { useMarginAccountInfoStore, refreshMarginAccount } from "@/store/margin-account-info-store";
import { useWallet } from "@/hooks/use-wallet";
import { refreshAfterTx } from "@/lib/after-tx";
import { useTokenPrices } from "@/hooks/use-token-prices";
import { useV3Account } from "@/hooks/use-v3-account";
import { PublicKey } from "@solana/web3.js";
import { bestSwapQuote, executeSwapQuote, providerLabel, type AggregatedQuote, type SwapProvider } from "@/lib/solana/aggregator";
import { TitanUnavailableError } from "@/lib/solana/titan";
import { fromRaw, toRaw } from "@/lib/solana/math";
import { spendableLamports } from "@/lib/solana/balances";
import { explorerUrl } from "@/lib/solana/config";
import { describeError } from "@/lib/solana/errors";
import { LIQ_HF, SAFE_HF, WARN_HF, accountNumbers, hfZone } from "@/lib/account-model";
import { IC, Icon, VMark } from "@/components/v3/icons";
import { Info } from "@/components/v3/ui";
import { hfFmt, nf, usd } from "@/components/v3/format";
import { SwapSettingsModal, TokenPickerModal, AUTO_SLIPPAGE_PERCENT } from "../v3/swap-modals";
import { withSwap, type SwapPreview } from "../v3/swap-model";
import { Token, SwapButtonState, RouteStep } from "./types";
import { SWAP_TOKENS, routeTokenForMint } from "./registry-tokens";

/** Quick-pick chips in the token picker: the majors, JupUSD and the xStocks. */
const POPULAR_SYMBOLS = ["SOL", "USDC", "USDT", "JupUSD", "NVDAx", "GOOGLx", "AAPLx", "TSLAx"];
import { onTxStatus, showTxStep, showTxSuccess, showTxError } from "@/lib/tx-progress";
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

/** The aggregators the user can pick in the header dropdown; the swap runs through the picked one. */
const AGGREGATORS: { id: SwapProvider; label: string; hint: string }[] = [
  { id: "jupiter", label: "Jupiter", hint: "Jupiter's best route across Solana AMMs" },
  { id: "titan", label: "Titan", hint: "Titan's meta-aggregated route" },
];

type RoutePlanStep = { swapInfo?: { label?: string; inputMint?: string; outputMint?: string }; percent?: number };

interface SwapCardProps {
  baseSymbol?: string;
  /** Called with the pair and the quoted values, so the page's account panel can show "now → after". */
  onPreview?: (p: SwapPreview) => void;
}

/**
 * The Spot swap card (V3 design): swaps collateral inside the margin account through the picked
 * aggregator (Jupiter / Titan), with percent chips, quote details, route card, the "after this swap"
 * health factor and the safety floor.
 */
export const SwapCard = ({ baseSymbol, onPreview }: SwapCardProps) => {
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

  // Aggregator picked in the header dropdown (quote + execution both go through it).
  const [aggregator, setAggregator] = useState<SwapProvider>("jupiter");
  const [isAggregatorMenuOpen, setIsAggregatorMenuOpen] = useState(false);
  const aggregatorMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isAggregatorMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (!aggregatorMenuRef.current?.contains(e.target as Node)) setIsAggregatorMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [isAggregatorMenuOpen]);

  // Modal state
  const [tokenModalTarget, setTokenModalTarget] = useState<"in" | "out" | null>(null);
  // Quote details open/closed; null = follow the default (open when the swap changes the health factor).
  const [isDetailsExpanded, setIsDetailsExpanded] = useState<boolean | null>(null);

  // Wallet + margin account
  const { address: userAddress, connectWallet } = useWallet();
  const isWalletConnected = Boolean(userAddress);
  const walletBalances = useUserStore((s) => s.tokenBalances);
  const { hasMarginAccount, collateralBalances } =
    useMarginAccountInfoStore(
      useShallow((s) => ({
        hasMarginAccount: s.hasMarginAccount,
        collateralBalances: s.collateralBalances,
      })),
    );
  // Program-exact account model (same health factor as every V3 page).
  const { state: modelState } = useV3Account();

  // Margin mode reads the margin vault — make sure the store has the account loaded.
  useEffect(() => {
    if (swapMode === "margin" && userAddress) void refreshMarginAccount(userAddress).catch(() => {});
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
  // Quote (debounced). Both modes quote Jupiter AND Titan and take the larger output (margin mode
  // through the margin-sized routes each adapter executes); see lib/solana/aggregator.ts.
  // ---------------------------------------------------------------------------------------------
  const [quote, setQuote] = useState<AggregatedQuote | null>(null);
  const [quoteFetchedAt, setQuoteFetchedAt] = useState(0);
  const [quoteError, setQuoteError] = useState<{ noRoute: boolean; message: string; unavailable?: boolean } | null>(null);
  const [isQuoteLoading, setIsQuoteLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const quoteRequestId = useRef(0);

  const amountInRaw = tokenIn ? safeRaw(amountIn, tokenIn.decimals) : null;

  const requestQuote = useCallback(
    async (from: Token, to: Token, amountUi: string, raw: bigint): Promise<AggregatedQuote> =>
      bestSwapQuote({
        mode: swapMode === "margin" ? "margin" : "wallet",
        inputMint: from.id,
        outputMint: to.id,
        fromSymbol: from.symbol,
        toSymbol: to.symbol,
        amountUi,
        amountRaw: raw,
        slippageBps,
        owner: userAddress ? new PublicKey(userAddress) : null,
        provider: aggregator,
      }),
    [swapMode, slippageBps, userAddress, aggregator],
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
          setQuoteError({ noRoute: isNoRouteError(message), message, unavailable: error instanceof TitanUnavailableError });
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

  // Route card path: the tokens in hop order and, per leg, the AMMs (with split %) that carry it.
  // Falls back to a single tokenIn → tokenOut leg when the plan's legs don't chain.
  const routePath = useMemo<{ tokens: Token[]; legs: string[] } | null>(() => {
    if (!route || !tokenIn || !tokenOut) return null;
    const tokens: Token[] = [tokenIn];
    const legs: string[] = [];
    let cur = tokenIn.id;
    for (let guard = 0; guard < 6 && cur !== tokenOut.id; guard++) {
      const steps = route.filter((r) => r.tokenIn.id === cur);
      if (!steps.length) break;
      const next = steps[0].tokenOut;
      legs.push(
        steps
          .filter((r) => r.tokenOut.id === next.id)
          .map((r) => (r.poolFee ? `${r.protocol} ${r.poolFee}` : r.protocol))
          .join(" · "),
      );
      tokens.push(next.id === tokenOut.id ? tokenOut : next);
      cur = next.id;
    }
    if (cur !== tokenOut.id) return { tokens: [tokenIn, tokenOut], legs: [routeLabel ?? ""] };
    return { tokens, legs };
  }, [route, tokenIn, tokenOut, routeLabel]);

  // Project the post-swap health factor for margin-mode swaps on the account model: the paid
  // token's collateral line falls by its USD value, the received one rises by the quote's, debt is
  // unchanged. Blocked below SAFE_HF (when it lowers the HF), amber below WARN_HF.
  const quoteUsd = useMemo(() => {
    if (!quote || !tokenIn || !tokenOut || !(tokenInPrice > 0) || !(tokenOutPrice > 0)) return null;
    return {
      inUsd: Number(fromRaw(BigInt(quote.inAmount), tokenIn.decimals)) * tokenInPrice,
      outUsd: Number(fromRaw(BigInt(quote.outAmount), tokenOut.decimals)) * tokenOutPrice,
    };
  }, [quote, tokenIn, tokenOut, tokenInPrice, tokenOutPrice]);
  const futureHealthFactor = useMemo<{ before: number; after: number; showWarning: boolean; blocked: boolean; amber: boolean } | null>(() => {
    if (swapMode !== "margin" || !hasMarginAccount || !modelState || !quoteUsd || !tokenIn || !tokenOut) return null;
    const before = withSwap(modelState, tokenIn.symbol, 0, tokenOut.symbol, 0);
    const after = withSwap(modelState, tokenIn.symbol, quoteUsd.inUsd, tokenOut.symbol, quoteUsd.outUsd);
    const h0 = accountNumbers(before).hf;
    const h1 = accountNumbers(after).hf;
    if (!Number.isFinite(h0) && !Number.isFinite(h1)) return null;
    const lowers = h1 < h0 - 1e-9;
    const blocked = lowers && h1 < SAFE_HF;
    return { before: h0, after: h1, showWarning: h1 <= LIQ_HF, blocked, amber: !blocked && lowers && h1 < WARN_HF };
  }, [swapMode, hasMarginAccount, modelState, quoteUsd, tokenIn, tokenOut]);

  // Tell the page what is about to happen (pair + quoted USD), for its account panel.
  useEffect(() => {
    if (!onPreview || !tokenIn || !tokenOut) return;
    onPreview({ from: tokenIn.symbol, to: tokenOut.symbol, inUsd: quoteUsd?.inUsd ?? 0, outUsd: quoteUsd?.outUsd ?? 0, quoted: Boolean(quoteUsd) && !isQuoteLoading });
  }, [onPreview, tokenIn, tokenOut, quoteUsd, isQuoteLoading]);

  const formatHfLabel = (hf: number): string => {
    if (!Number.isFinite(hf) || hf <= 0) return "No debt";
    return hf.toFixed(2);
  };

  // ---------------------------------------------------------------------------------------------
  // Execution — wallet: Jupiter's own transaction; margin: the swap instruction wrapped in
  // margin_execute (health-checked on-chain after the swap)
  // ---------------------------------------------------------------------------------------------
  const [txHash, setTxHash] = useState("");
  const [txError, setTxError] = useState("");

  const queryClient = useQueryClient();
  const swapMutation = useMutation({
    mutationFn: async () => {
      if (!quote || !tokenIn || !tokenOut || amountInRaw === null) throw new Error("No quote to execute");
      let toExecute = quote;
      // Re-quote a stale quote right before signing. If the fresh quote's minimum output is
      // worse than what the user reviewed, stop and show it instead of silently accepting it.
      if (Date.now() - quoteFetchedAt > QUOTE_MAX_AGE_MS) {
        // Re-quote both providers (margin mode with the margin-sized routes) and keep the better one.
        const fresh = await requestQuote(tokenIn, tokenOut, amountIn, amountInRaw);
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
      return executeSwapQuote(toExecute, {
        mode: swapMode === "margin" ? "margin" : "wallet",
        fromSymbol: tokenIn.symbol,
        toSymbol: tokenOut.symbol,
        amountUi: amountIn,
        slippageBps,
      }, { onStatus: onTxStatus });
    },
    onMutate: () => {
      setTxError("");
      setTxHash("");
    },
    onSuccess: (signature) => {
      setTxHash(signature);
      showTxSuccess(`Swapped ${amountIn} ${tokenIn?.symbol} for ${tokenOut?.symbol}`);
      setAmountIn("");
      // Account snapshot (wallet + margin balances) first; the new swap row in history shortly after.
      void refreshAfterTx(queryClient, ["margin"]);
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

  // Quote details default open when the swap moves the health factor (design behaviour).
  const detailsOpen = isDetailsExpanded ?? Boolean(futureHealthFactor);
  const balanceNum = (b: string | null) => (b === null ? 0 : parseFloat(b) || 0);
  const tokFmtSwap = (b: string | null, sym: string) =>
    balanceNum(b).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: /^(USDC|USDT|JupUSD)$/.test(sym) ? 2 : 4 });
  const swappableTip = (sym: string) =>
    `${sym} in your margin account. In Vanna every token in the margin account is collateral and swappable at the same time: a swap trades it inside the account and the health check runs after the swap.`;

  // CTA label / style per state (the live states plus the safety floor).
  const cta: { label: string; kind: "g" | "off" | "danger" } = (() => {
    if (isSwapping) return { label: "Swapping…", kind: "off" };
    switch (buttonState) {
      case "connect_wallet":
        return { label: "Connect Wallet", kind: "g" };
      case "select_token":
        return { label: "Select a token", kind: "off" };
      case "enter_amount":
        return { label: "Enter an Amount", kind: "off" };
      case "loading_quote":
        return { label: "Fetching the best price…", kind: "off" };
      case "no_margin_account":
        return { label: "Create a margin account first", kind: "off" };
      case "insufficient_balance":
        return { label: "Insufficient Balance", kind: "danger" };
      case "no_route":
        return { label: "No route", kind: "danger" };
      case "ready":
        return futureHealthFactor?.blocked ? { label: `Health factor would fall below ${nf(SAFE_HF, 2)}`, kind: "danger" } : { label: "Swap", kind: "g" };
      default:
        return { label: "Swap", kind: "off" };
    }
  })();
  const ctaEnabled = cta.kind === "g" && !isSwapping;
  const dexOption = AGGREGATORS.find((a) => a.id === aggregator) ?? AGGREGATORS[0];
  const DEX_SYM: Record<SwapProvider, string> = { jupiter: "JUP", titan: "TITAN" };
  const hfAfter = futureHealthFactor;

  return (
    <>
      <section className="sp-card" aria-label="Swap">
        {/* Swap heading + aggregator picker + Settings */}
        <div className="sp-hd">
          <div className="sp-hdl">
            <span className="sp-ttl">Swap</span>
            {/* Aggregator picker: the quote and the swap both go through the picked one. */}
            <span className="sp-dexw" ref={aggregatorMenuRef} style={{ position: "relative" }}>
              <button
                type="button"
                className="sp-dex"
                onClick={() => setIsAggregatorMenuOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={isAggregatorMenuOpen}
                title={routeLabel ? `Current route: ${routeLabel}` : undefined}
              >
                <span className="sp-via">via</span>
                <Icon sym={DEX_SYM[aggregator]} className="sp-ico s16" />
                <b>{dexOption.label}</b>
                <span className={`sp-chev ${isAggregatorMenuOpen ? "up" : ""}`}>{IC.chev}</span>
              </button>
              {isAggregatorMenuOpen && (
                <div className="pop sp-dexm" role="listbox">
                  {AGGREGATORS.map((a) => {
                    const selected = a.id === aggregator;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`sp-dexo ${selected ? "on" : ""}`}
                        onClick={() => {
                          setAggregator(a.id);
                          setIsAggregatorMenuOpen(false);
                          setTxHash("");
                        }}
                      >
                        <Icon sym={DEX_SYM[a.id]} className="sp-ico s28" />
                        <span>
                          <b>{a.label}</b>
                          <small>{a.hint}</small>
                        </span>
                        {selected && <span className="sp-ok">{IC.check}</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </span>
          </div>
          <button type="button" className="sp-gear" aria-label="Swap settings" onClick={() => setIsSettingsOpen(true)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6.5 2.5L7.2 1.2C7.3 1.1 7.5 1 7.6 1H8.4C8.5 1 8.7 1.1 8.8 1.2L9.5 2.5L11 3.1L12.3 2.7C12.5 2.6 12.7 2.7 12.8 2.8L13.4 3.4C13.5 3.5 13.6 3.7 13.5 3.9L13.1 5.2L13.7 6.7L15 7.4C15.1 7.5 15.2 7.7 15.2 7.8V8.6C15.2 8.7 15.1 8.9 15 9L13.7 9.7L13.1 11.2L13.5 12.5C13.6 12.7 13.5 12.9 13.4 13L12.8 13.6C12.7 13.7 12.5 13.8 12.3 13.7L11 13.3L9.5 13.9L8.8 15.2C8.7 15.3 8.5 15.4 8.4 15.4H7.6C7.5 15.4 7.3 15.3 7.2 15.2L6.5 13.9L5 13.3L3.7 13.7C3.5 13.8 3.3 13.7 3.2 13.6L2.6 13C2.5 12.9 2.4 12.7 2.5 12.5L2.9 11.2L2.3 9.7L1 9C0.9 8.9 0.8 8.7 0.8 8.6V7.8C0.8 7.7 0.9 7.5 1 7.4L2.3 6.7L2.9 5.2L2.5 3.9C2.4 3.7 2.5 3.5 2.6 3.4L3.2 2.8C3.3 2.7 3.5 2.6 3.7 2.7L5 3.1L6.5 2.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="8" cy="8.2" r="2.2" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
        </div>

        {/* You Pay */}
        <div className="sp-in">
          <div className="sp-lr">
            <span className="sp-lbl">You Pay</span>
            {isWalletConnected && (
              <span className="sp-pcs">
                {[25, 50, 75, 100].map((p) => (
                  <button key={p} type="button" className={`sp-pc p${p} ${activePercent === p ? "on" : ""}`} onClick={() => handlePercentClick(p)}>
                    {p === 100 ? "Max" : `${p}%`}
                  </button>
                ))}
              </span>
            )}
          </div>
          <div className="sp-tr">
            <button type="button" className="sp-tok" aria-label={`Select token, now ${tokenIn?.symbol ?? "none"}`} onClick={() => setTokenModalTarget("in")}>
              {tokenIn && <Icon sym={tokenIn.symbol} className="sp-ico s24" />}
              <span>{tokenIn?.symbol ?? "Select"}</span>
              {IC.chev}
            </button>
            <input
              className="sp-amt num"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={amountIn}
              aria-label="Amount to pay"
              onChange={(e) => {
                let v = e.target.value.replace(/,/g, "").replace(/[^0-9.]/g, "");
                const dot = v.indexOf(".");
                if (dot >= 0) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "");
                setAmountIn(v);
                setActivePercent(null);
                setTxHash("");
              }}
            />
          </div>
          <div className="sp-br">
            {isWalletConnected && tokenIn ? (
              <span className="sp-bal">
                <span className="num">Swappable: {tokFmtSwap(tokenInBalance, tokenIn.symbol)}</span>
                <Info text={swappableTip(tokenIn.symbol)} />
                <button type="button" className="sp-max" onClick={handleMaxClick}>
                  MAX
                </button>
              </span>
            ) : (
              <span />
            )}
            {amountInUsd && <span className="sp-usd num">~ ${amountInUsd}</span>}

          </div>
        </div>

        <div className="sp-flipw">
          <button type="button" className="sp-flip" aria-label="Reverse swap direction" onClick={handleFlip}>
            <VMark size={24} />
          </button>
        </div>

        {/* You Receive */}
        <div className="sp-in">
          <div className="sp-lr">
            <span className="sp-lbl">You Receive</span>
          </div>
          <div className="sp-tr">
            <button type="button" className="sp-tok" aria-label={`Select token, now ${tokenOut?.symbol ?? "none"}`} onClick={() => setTokenModalTarget("out")}>
              {tokenOut && <Icon sym={tokenOut.symbol} className="sp-ico s24" />}
              <span>{tokenOut?.symbol ?? "Select"}</span>
              {IC.chev}
            </button>
            <input className="sp-amt num" readOnly tabIndex={-1} placeholder={isQuoteLoading ? "…" : "0"} value={isQuoteLoading ? "" : amountOut} aria-label="Amount you receive" />
          </div>
          <div className="sp-br">
            {isWalletConnected && tokenOut ? <span className="sp-bal num">Swappable: {tokFmtSwap(tokenOutBalance, tokenOut.symbol)}</span> : <span />}
            {amountOutUsd && <span className="sp-usd num">~ ${amountOutUsd}</span>}
          </div>
        </div>

        <div className="sp-dyn" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {hasQuote && quote ? (
            <>
              {/* Quote details */}
              <div className="sp-det">
                <div
                  className="sp-dh"
                  role="button"
                  tabIndex={0}
                  aria-expanded={detailsOpen}
                  onClick={() => setIsDetailsExpanded(!detailsOpen)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setIsDetailsExpanded(!detailsOpen);
                    }
                  }}
                >
                  <span className="sp-dl">
                    {exchangeRate && (
                      <button
                        type="button"
                        className="sp-rate num"
                        title="Click to flip direction"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFlipRate();
                        }}
                      >
                        {exchangeRate}
                      </button>
                    )}
                    {hfAfter && (
                      <span className="sp-hfh">
                        · HF <span>{hfFmt(hfAfter.before)}</span> {IC.arrow} <b className={hfAfter.after < SAFE_HF ? "neg" : ""}>{hfFmt(hfAfter.after)}</b>
                      </span>
                    )}
                    <button
                      type="button"
                      className="sp-ref"
                      aria-label="Refresh quote"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRefreshNonce((n) => n + 1);
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <path d="M11.67 7A4.67 4.67 0 1 1 7 2.33M7 2.33L9.33 4.67M7 2.33L4.67 4.67" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  </span>
                  <span className={`sp-chev ${detailsOpen ? "up" : ""}`}>{IC.chev}</span>
                </div>
                {detailsOpen && (
                  <div className="sp-db num">
                    {priceImpactInfo.label && (
                      <div className="sp-dr">
                        <span>Price Impact</span>
                        <span className={`sp-imp ${priceImpactInfo.level === "medium" ? "med" : priceImpactInfo.level ?? "low"}`}>
                          {priceImpactInfo.label}
                          <i />
                        </span>
                      </div>
                    )}
                    {hfAfter && (
                      <div className="sp-dr">
                        <span>Health Factor</span>
                        <span>
                          {hfFmt(hfAfter.before)} <em>{IC.arrow}</em> <b className={hfAfter.after < SAFE_HF ? "neg" : ""}>{hfFmt(hfAfter.after)}</b>
                        </span>
                      </div>
                    )}
                    <div className="sp-dr">
                      <span>Slippage Tolerance</span>
                      <span>
                        {slippagePercent}%{" "}
                        <button type="button" className="sp-edit" onClick={() => setIsSettingsOpen(true)}>
                          Edit
                        </button>
                      </span>
                    </div>
                    {minReceived && (
                      <div className="sp-dr">
                        <span>Min. Received</span>
                        <span>{minReceived}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Route card (AMM per hop, straight from the aggregator's route plan) */}
              {routePath && (
                <div className="sp-route">
                  <div className="sp-rh">
                    <span className="sp-rl">
                      <b>Route</b>
                      <span>
                        · {routePath.legs.length} {routePath.legs.length === 1 ? "hop" : "hops"}
                        {routeLabel ? ` · ${routeLabel}` : ""}
                      </span>
                    </span>
                    <span className="sp-via2">
                      <Icon sym={DEX_SYM[quote.provider]} className="sp-ico s16" />
                      via {providerLabel(quote.provider)}
                    </span>
                  </div>
                  <div className="sp-rpath">
                    {routePath.tokens.map((t, i) => (
                      <span key={`${t.id}-${i}`} style={{ display: "contents" }}>
                        <span className="sp-rt">
                          <Icon sym={t.symbol} className="sp-ico s36" />
                          <b>{t.symbol}</b>
                        </span>
                        {i < routePath.tokens.length - 1 && (
                          <span className="sp-rline">
                            <small title={routePath.legs[i]}>{routePath.legs[i]}</small>
                            <i />
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="sp-sp" />
          )}

          {/* No route / quote failure — shown honestly, never replaced by an estimate. */}
          {quoteError && !isQuoteLoading && (
            <div className="sp-warn info">
              {IC.warn}
              <span>
                {quoteError.unavailable
                  ? "Titan isn't set up on this server yet (TITAN_API_KEY missing). Switch to Jupiter to swap."
                  : quoteError.noRoute
                    ? `No route found for ${tokenIn?.symbol} → ${tokenOut?.symbol} on ${providerLabel(aggregator)} at this amount. Try a different amount, pair or aggregator.`
                    : `Couldn't fetch a quote: ${quoteError.message}`}
              </span>
            </div>
          )}

          {/* High price-impact warning banner (from the aggregator's reported price impact). */}
          {isHighPriceImpact && (
            <div className="sp-warn danger">
              {IC.warn}
              <span>
                High price impact{priceImpactInfo.label ? ` (${priceImpactInfo.label})` : ""}. The route&apos;s liquidity is too thin for this trade size. Reduce the amount.
              </span>
            </div>
          )}

          {/* Health-factor floor: blocked below SAFE_HF, amber below WARN_HF, both only when the swap lowers it. */}
          {hfAfter?.blocked ? (
            <div className="sp-warn danger">
              {IC.warn}
              <span>
                This swap would take your health factor from {hfFmt(hfAfter.before)} to {hfFmt(hfAfter.after)}, below the {nf(SAFE_HF, 2)} safety floor (liquidation at{" "}
                {nf(LIQ_HF, 2)}).
              </span>
            </div>
          ) : hfAfter?.amber ? (
            <div className="sp-warn warn">
              {IC.warn}
              <span>
                Health factor would be <span className={hfZone(hfAfter.after)}>{hfFmt(hfAfter.after)}</span>, close to the {nf(SAFE_HF, 2)} safety floor (liquidation at {nf(LIQ_HF, 2)}).
              </span>
            </div>
          ) : null}

          {/* Margin mode needs a margin account (the swap runs inside it). */}
          {swapMode === "margin" && isWalletConnected && !hasMarginAccount && (
            <div className="sp-warn warn">
              {IC.warn}
              <span>
                Swaps run inside your margin account — create one on the <a href="/margin" style={{ textDecoration: "underline" }}>Margin</a> page first.
              </span>
            </div>
          )}

          {/* Swap CTA */}
          <button type="button" className={`sp-cta ${cta.kind}`} disabled={!ctaEnabled} onClick={handleButtonClick}>
            {cta.label}
          </button>

          {/* Last swap result */}
          {txHash && (
            <a className="sp-done" href={explorerUrl("tx", txHash)} target="_blank" rel="noopener noreferrer">
              Swap confirmed — view transaction
            </a>
          )}
          {txError && !isSwapping && <p className="sp-warn danger">{txError}</p>}
        </div>
      </section>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <SwapSettingsModal
          slippage={slippage}
          onSlippageChange={setSlippage}
          mode={slippageMode}
          onModeChange={setSlippageMode}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}

      {/* Token picker — the whole registry, both sides (the aggregators route any pair). */}
      {tokenModalTarget !== null && (
        <TokenPickerModal
          tokens={tokenList}
          popular={tokenList.filter((t) => POPULAR_SYMBOLS.includes(t.symbol))}
          balances={isWalletConnected ? tokenListBalances : undefined}
          onSelect={handleTokenSelect}
          onClose={() => setTokenModalTarget(null)}
        />
      )}
    </>
  );
};
