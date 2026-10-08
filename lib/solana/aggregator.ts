/**
 * Best-price routing for the Spot page: quotes Jupiter and Titan side by side (wallet or margin
 * mode) and picks the larger output. A Titan quote is presented in Jupiter's quote shape (in / out /
 * minimum out / route labels) so the swap card renders either the same way; `provider` says which
 * executor runs it. Titan is skipped quietly when the server has no TITAN_API_KEY or no wallet is
 * connected (Titan builds its instructions for a specific user). When the user picks one aggregator
 * (`QuoteRequest.provider`), only that one is quoted and its failure is shown as is.
 */
import { PublicKey } from "@solana/web3.js";
import { executeMarginSwap, quoteMarginSwap, type MarginSwapRequest } from "./exec";
import type { MarginServiceOptions } from "./margin";
import { executeWalletSwap, fetchJupiterQuote, type JupiterQuote } from "./swap";
import { executeMarginTitanSwap, executeWalletTitanSwap, fetchTitanQuote, quoteMarginTitanSwap, TitanUnavailableError, type TitanQuote } from "./titan";
import type { TxSigner } from "./wallet-bridge";

export type SwapProvider = "jupiter" | "titan";

/** Why Titan did or didn't take part in a quote (shown next to the route). */
export type TitanStatus = "quoted" | "no-route" | "not-configured" | "no-wallet";

export type AggregatedQuote = JupiterQuote & {
  provider: SwapProvider;
  titan?: TitanQuote;
  /** Every provider that quoted, best first (out amounts, raw). */
  quotes: { provider: SwapProvider; outAmount: string }[];
  titanStatus?: TitanStatus;
};

export interface QuoteRequest {
  mode: "wallet" | "margin";
  inputMint: string;
  outputMint: string;
  fromSymbol: string;
  toSymbol: string;
  /** UI amount (margin quotes) and raw amount (wallet quotes). */
  amountUi: string;
  amountRaw: bigint;
  slippageBps: number;
  /** The connected wallet (Titan quotes need it); null = Jupiter only. */
  owner: PublicKey | null;
  /** Quote only this aggregator (the Spot page's Jupiter / Titan picker); omitted = best of both. */
  provider?: SwapProvider;
}

function titanAsQuote(t: TitanQuote, req: QuoteRequest): AggregatedQuote {
  const out = BigInt(t.outAmount);
  return {
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    inAmount: t.inAmount,
    outAmount: t.outAmount,
    otherAmountThreshold: ((out * BigInt(10_000 - t.slippageBps)) / 10_000n).toString(),
    slippageBps: t.slippageBps,
    // Same shape as Jupiter's routePlan, so the route card shows each leg's tokens and split.
    routePlan: t.steps?.length
      ? t.steps.map((s) => ({ swapInfo: { label: s.label, inputMint: s.inputMint, outputMint: s.outputMint }, percent: s.percent }))
      : (t.labels.length ? t.labels : ["Titan"]).map((label) => ({ swapInfo: { label, inputMint: req.inputMint, outputMint: req.outputMint }, percent: 100 })),
    provider: "titan",
    titan: t,
    quotes: [],
  };
}

/** Quotes both providers and returns the better one (Jupiter's error if neither has a route). */
export async function bestSwapQuote(req: QuoteRequest): Promise<AggregatedQuote> {
  const marginReq: MarginSwapRequest = { fromSymbol: req.fromSymbol, toSymbol: req.toSymbol, amount: req.amountUi, slippageBps: req.slippageBps };
  const useJupiter = req.provider !== "titan";
  const useTitan = req.provider !== "jupiter";
  if (req.provider === "titan" && !req.owner) throw new Error("Connect a wallet to get a Titan quote");
  const jupiter: Promise<AggregatedQuote | null> = !useJupiter
    ? Promise.resolve(null)
    : (req.mode === "margin" ? quoteMarginSwap(marginReq) : fetchJupiterQuote({ inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amountRaw, slippageBps: req.slippageBps })).then(
    (q): AggregatedQuote => ({ ...q, provider: "jupiter", quotes: [] }),
  );
  const titan: Promise<AggregatedQuote | null> = useTitan && req.owner
    ? (req.mode === "margin"
        ? quoteMarginTitanSwap(marginReq, req.owner)
        : fetchTitanQuote({ inputMint: req.inputMint, outputMint: req.outputMint, amount: req.amountRaw, userPublicKey: req.owner.toBase58(), slippageBps: req.slippageBps, mode: "wallet" })
      ).then((t) => titanAsQuote(t, req))
    : Promise.resolve(null);
  const [j, t] = await Promise.allSettled([jupiter, titan]);
  const titanStatus: TitanStatus | undefined = !useTitan
    ? undefined
    : !req.owner
    ? "no-wallet"
    : t.status === "fulfilled"
      ? "quoted"
      : t.reason instanceof TitanUnavailableError
        ? "not-configured"
        : "no-route";
  const quotes = [j, t].flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
  if (quotes.length === 0) {
    // Titan picked on its own: surface its own error (e.g. TITAN_API_KEY missing, no route).
    if (req.provider === "titan" && t.status === "rejected") throw t.reason;
    if (j.status === "rejected") throw j.reason;
    if (t.status === "rejected" && !(t.reason instanceof TitanUnavailableError)) throw t.reason;
    throw new Error("No route found");
  }
  quotes.sort((a, b) => (BigInt(b.outAmount) > BigInt(a.outAmount) ? 1 : BigInt(b.outAmount) < BigInt(a.outAmount) ? -1 : 0));
  return { ...quotes[0], quotes: quotes.map((q) => ({ provider: q.provider, outAmount: q.outAmount })), titanStatus };
}

/** Runs the quote with its provider's executor; returns the signature. */
export async function executeSwapQuote(
  quote: AggregatedQuote,
  req: { mode: "wallet" | "margin"; fromSymbol: string; toSymbol: string; amountUi: string; slippageBps: number },
  opts: MarginServiceOptions & { signer?: TxSigner } = {},
): Promise<string> {
  const marginReq: MarginSwapRequest = { fromSymbol: req.fromSymbol, toSymbol: req.toSymbol, amount: req.amountUi, slippageBps: req.slippageBps };
  if (quote.provider === "titan" && quote.titan) {
    if (req.mode === "margin") return (await executeMarginTitanSwap(marginReq, quote.titan, opts)).signature;
    return executeWalletTitanSwap(quote.titan, opts);
  }
  if (req.mode === "margin") return (await executeMarginSwap(marginReq, quote, opts)).signature;
  return executeWalletSwap(quote, opts);
}

export const providerLabel = (p: SwapProvider): string => (p === "titan" ? "Titan" : "Jupiter");

/** Each aggregator's logo (public/protocols). */
export const providerLogo = (p: SwapProvider): string => (p === "titan" ? "/protocols/titan.png" : "/protocols/jupiter.png");

/** Short explanation of Titan's part in the current quote. */
export const titanStatusLabel = (s: TitanStatus | undefined): string =>
  s === "quoted"
    ? "Titan quoted — the better of Titan and Jupiter is used"
    : s === "no-route"
      ? "Titan had no route for this pair / amount — Jupiter is used"
      : s === "not-configured"
        ? "Titan isn't configured on this server (TITAN_API_KEY) — Jupiter is used"
        : s === "no-wallet"
          ? "Connect a wallet to compare Titan quotes"
          : "Compares Jupiter and Titan and takes the better price";
