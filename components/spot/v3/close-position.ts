/**
 * Closing a spot position through the existing services (no new transaction logic):
 *
 * - LONG  → sell the whole margin-vault balance of the token for USDC: one margin swap
 *   (`bestSwapQuote` / `executeSwapQuote`, the swap card's own path);
 * - SHORT → buy the owed token with margin USDC (margin swap), then repay that loan in full from the
 *   margin vault (`repay({ all, source: "margin" })`, the Margin page's path). Two transactions.
 *
 * Quotes are ExactIn, so a short's USDC input is sized from the on-chain price and re-quoted until
 * the quote's MINIMUM output covers the debt plus the repay-all accrual buffer.
 */
import { PublicKey } from "@solana/web3.js";
import { bestSwapQuote, executeSwapQuote, type AggregatedQuote, type SwapProvider } from "@/lib/solana/aggregator";
import { fromRaw, toRaw } from "@/lib/solana/math";
import { repay } from "@/lib/solana/margin";
import { getToken } from "@/lib/solana/tokens";
import { onTxStatus, showTxError, showTxStep, showTxSuccess } from "@/lib/tx-progress";
import { describeError } from "@/lib/solana/errors";
import type { TxSigner } from "@/lib/solana/wallet-bridge";
import type { SpotPosition } from "@/hooks/use-spot-positions";

/** Extra owed-token bought on a short close over the debt: repay-all's 0.2% buffer + interest + dust. */
const SHORT_BUY_HEADROOM = 0.006;

export interface ClosePlan {
  position: SpotPosition;
  provider: SwapProvider;
  slippageBps: number;
  fromSymbol: string;
  toSymbol: string;
  /** Exact UI amount sold. */
  amountUi: string;
  quote: AggregatedQuote;
  /** UI amount the quote returns / at least returns after slippage. */
  outUi: number;
  minOutUi: number;
  /** Short only: tokens the vault must hold to repay everything (debt + buffer). */
  needUi?: number;
  /** Short only: owed tokens already in the vault before buying. */
  heldUi?: number;
}

export interface CloseContext {
  owner: string;
  provider: SwapProvider;
  slippageBps: number;
  /** Margin-vault balance of a symbol (raw, as a decimal string) from the margin snapshot. */
  vaultRaw: (symbol: string) => bigint;
  /** On-chain price, USD. */
  priceOf: (symbol: string) => number;
}

const quoteFor = (from: string, to: string, amountUi: string, ctx: CloseContext) => {
  const a = getToken(from);
  const b = getToken(to);
  return bestSwapQuote({
    mode: "margin",
    inputMint: a.mint.toBase58(),
    outputMint: b.mint.toBase58(),
    fromSymbol: a.symbol,
    toSymbol: b.symbol,
    amountUi,
    amountRaw: toRaw(amountUi, a.decimals),
    slippageBps: ctx.slippageBps,
    owner: new PublicKey(ctx.owner),
    provider: ctx.provider,
  });
};

/** Fixed-decimals UI string (rounded down) for a quote amount. */
const ui = (n: number, decimals: number) => {
  const d = Math.min(decimals, 6);
  const f = Math.pow(10, d);
  return (Math.floor(n * f) / f).toFixed(d);
};

/** Quotes the close of `p` (no transaction). Throws a readable error when it can't be closed. */
export async function planClose(p: SpotPosition, ctx: CloseContext): Promise<ClosePlan> {
  const tok = getToken(p.symbol);
  const usdc = getToken("USDC");
  if (p.side === "long") {
    const raw = ctx.vaultRaw(p.symbol);
    if (raw <= 0n) throw new Error(`No ${p.symbol} in the margin account`);
    const amountUi = fromRaw(raw, tok.decimals);
    const quote = await quoteFor(p.symbol, "USDC", amountUi, ctx);
    return {
      position: p,
      provider: ctx.provider,
      slippageBps: ctx.slippageBps,
      fromSymbol: p.symbol,
      toSymbol: "USDC",
      amountUi,
      quote,
      outUi: Number(fromRaw(BigInt(quote.outAmount), usdc.decimals)),
      minOutUi: Number(fromRaw(BigInt(quote.otherAmountThreshold ?? quote.outAmount), usdc.decimals)),
    };
  }
  // Short: buy what the vault lacks to repay everything.
  const heldUi = Number(fromRaw(ctx.vaultRaw(p.symbol), tok.decimals));
  const needUi = p.qty * (1 + SHORT_BUY_HEADROOM);
  const buyUi = Math.max(0, needUi - heldUi);
  const usdcHeld = Number(fromRaw(ctx.vaultRaw("USDC"), usdc.decimals));
  const px = ctx.priceOf(p.symbol);
  if (buyUi <= 0) throw new Error(`The margin account already holds enough ${p.symbol}: repay it on the Margin page`);
  if (!(px > 0)) throw new Error(`No on-chain price for ${p.symbol}`);
  let spend = buyUi * px * (1 + ctx.slippageBps / 10_000 + 0.01);
  for (let i = 0; i < 4; i++) {
    if (spend > usdcHeld) {
      throw new Error(
        `Buying back ${buyUi.toFixed(6)} ${p.symbol} needs about ${spend.toFixed(2)} USDC; the margin account holds ${usdcHeld.toFixed(2)} USDC. Deposit or borrow USDC first.`,
      );
    }
    const amountUi = ui(spend, usdc.decimals);
    const quote = await quoteFor("USDC", p.symbol, amountUi, ctx);
    const outUi = Number(fromRaw(BigInt(quote.outAmount), tok.decimals));
    const minOutUi = Number(fromRaw(BigInt(quote.otherAmountThreshold ?? quote.outAmount), tok.decimals));
    if (minOutUi >= buyUi) {
      return { position: p, provider: ctx.provider, slippageBps: ctx.slippageBps, fromSymbol: "USDC", toSymbol: p.symbol, amountUi, quote, outUi, minOutUi, needUi, heldUi };
    }
    // The minimum out fell short: scale the input by the shortfall (plus a little) and re-quote.
    spend = Math.min(usdcHeld, spend * (buyUi / Math.max(minOutUi, 1e-12)) * 1.003);
  }
  throw new Error(`Couldn't size a buy-back quote for ${p.symbol}. Try again or raise slippage.`);
}

/**
 * Sends the close: the swap, then (short) the full repay from the margin vault. Progress goes through
 * the app's tx-progress toasts; returns the signatures. `opts.signer` defaults to the connected wallet.
 */
export async function executeClose(plan: ClosePlan, opts: { signer?: TxSigner } = {}): Promise<string[]> {
  const p = plan.position;
  const sigs: string[] = [];
  try {
    showTxStep(
      p.side === "long"
        ? `Closing ${p.symbol} long: selling ${plan.amountUi} ${p.symbol} for USDC — approve in your wallet`
        : `Closing ${p.symbol} short (1/2): buying ${p.symbol} with ${plan.amountUi} USDC — approve in your wallet`,
    );
    sigs.push(
      await executeSwapQuote(plan.quote, { mode: "margin", fromSymbol: plan.fromSymbol, toSymbol: plan.toSymbol, amountUi: plan.amountUi, slippageBps: plan.slippageBps }, opts),
    );
    if (p.side === "short") {
      showTxStep(`Closing ${p.symbol} short (2/2): repaying the ${p.symbol} loan from your margin account — approve in your wallet`);
      sigs.push((await repay({ symbol: p.symbol, all: true, source: "margin" }, { ...opts, onStatus: onTxStatus })).signature);
    }
    showTxSuccess(`Closed ${p.symbol} ${p.side}`);
    return sigs;
  } catch (error) {
    const msg = describeError(error, `Closing ${p.symbol} ${p.side} failed`);
    showTxError(sigs.length ? `${msg} (the swap went through: ${p.symbol} is in your margin account — repay it on the Margin page)` : msg);
    throw error;
  }
}
