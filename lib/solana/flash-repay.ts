/**
 * Flash repay — close every position and repay every loan of the margin account, as a SEQUENCE of
 * ordinary transactions (the program has no atomic "close everything" instruction).
 *
 *   1. perps     close every Phoenix position (reduce-only market orders) and bring the USDC home
 *   2. farm      redeem every Kamino cToken back to its underlying, in the margin account
 *   3. swap      for each loan the margin can't cover in its own token, swap other holdings into it
 *                (stables first, then the largest volatile holding) through the best aggregator
 *   4. repay     repay_all every loan from the margin vault and close its debt position
 *   5. transfer  (optional, "Flash transfer") withdraw every remaining holding to the wallet
 *
 * Every step is its own transaction(s) and wallet approval, reusing the existing services
 * (perps.ts, exec.ts, aggregator.ts, margin.ts). Each step re-reads the chain before acting, so a
 * run that stopped half-way is resumed by planning and executing again: finished work is simply
 * no longer there to do. Nothing is ever repaid beyond what is owed (repay_all repays the exact
 * accrued debt); when the account can't cover its debt the swap step stops with the shortfall.
 */
import { PublicKey } from "@solana/web3.js";
import { isStable } from "@/lib/account-model";
import { bestSwapQuote, executeSwapQuote, type AggregatedQuote, type SwapProvider } from "./aggregator";
import { farmWithdraw } from "./exec";
import { receiptByMint } from "./kamino";
import { closeDebtPosition, fetchMarginSnapshot, repay, withdrawCollateral, type MarginServiceOptions, type MarginSnapshot } from "./margin";
import { describeError } from "./errors";
import { fromRaw, rawToNumber } from "./math";
import { closePerp, withdrawPerpCollateral } from "./perps";
import { findToken, getToken } from "./tokens";
import { getActiveSigner, type TxSigner } from "./wallet-bridge";
import type { OnchainPrice } from "./pyth";

/** Each loan is covered with this much headroom over the accrued debt before repaying, bps.
 * repay_all itself asks for 0.2% (accrual between quote and landing); the rest absorbs swap drift. */
const DEBT_BUFFER_BPS = 50n;
/** Holdings worth less than this are ignored as swap sources / leftovers, USD. */
const DUST_USD = 0.01;
/** Smallest swap input worth quoting, USD (tiny routes fail on aggregators). */
const MIN_SWAP_USD = 0.05;
/** Swap rounds (per loan, ×2 overall) before the swap step gives up re-sizing. */
const MAX_SWAP_ROUNDS = 6;

export type FlashStepKey = "perps" | "farm" | "swap" | "repay" | "transfer";

/** One closing perp position, as the oracle values it now. */
export interface FlashPerpRow {
  market: string;
  name: string;
  side: "long" | "short";
  sizeUsd: number;
  sizeTokens: number;
  /** Index-price P&L + funding. */
  pnlUsd: number;
  /** Taker fee to close at the index price, USD. */
  closeFeeUsd: number;
  /** What the position returns as USDC (equity after the close fee), USD. */
  equityUsd: number;
}

/** One Kamino cToken position redeemed back to its underlying. */
export interface FlashFarmRow {
  symbol: string;
  receiptSymbol: string;
  receipts: number;
  /** Underlying redeemable now (reserve exchange rate). */
  underlying: number;
  usd: number;
}

/** One planned swap leg (oracle prices; `outQuoted` when an aggregator quote was available). */
export interface FlashSwapLeg {
  from: string;
  to: string;
  inAmount: number;
  outAmount: number;
  inUsd: number;
  outUsd: number;
  /** True when `outAmount` comes from a live aggregator quote (otherwise oracle-priced). */
  quoted: boolean;
  provider?: SwapProvider;
}

/** One loan and where its repayment comes from. */
export interface FlashLoanRow {
  symbol: string;
  amount: number;
  usd: number;
  /** Own-token amounts used: from the positions' proceeds, from what the margin already held. */
  fromProceeds: number;
  fromHoldings: number;
  swaps: FlashSwapLeg[];
  /** Part of the loan nothing in the account can cover. */
  shortAmount: number;
}

export interface FlashLeftRow {
  symbol: string;
  amount: number;
  usd: number;
}

export interface FlashStepPlan {
  key: FlashStepKey;
  title: string;
  /** Short right-hand figure ("+$123.45", "$300.00"). */
  usd: number;
  /** Estimated wallet approvals (transactions) for this step. */
  txs: number;
}

export interface FlashPlan {
  owner: string;
  exists: boolean;
  transfer: boolean;
  slippageBps: number;
  perps: FlashPerpRow[];
  /** USDC sitting in the Phoenix trader account outside any position. */
  phoenixIdleUsdc: number;
  /** The whole Phoenix venue as valued now (what comes back as USDC). */
  phoenixValueUsd: number;
  farm: FlashFarmRow[];
  loans: FlashLoanRow[];
  swaps: FlashSwapLeg[];
  /** What stays in the margin (or goes to the wallet with `transfer`), after repaying. */
  left: FlashLeftRow[];
  leftUsd: number;
  debtUsd: number;
  costs: { phoenixUsd: number; swapUsd: number };
  costUsd: number;
  /** Notional that goes through a market (perp closes + swap inputs), USD — the slippage base. */
  tradedUsd: number;
  /** Realized P&L of the perp positions closed (index price, incl. funding). */
  pnlUsd: number;
  positionCount: number;
  /** Loans left unpaid even after selling everything, USD (> 0 blocks the run). */
  shortUsd: number;
  /** Holdings this flow can't move (a token outside the app's registry), shown as a note. */
  untouched: FlashLeftRow[];
  steps: FlashStepPlan[];
  txCount: number;
  /** No positions, no loans, no idle Phoenix USDC — only holdings (a pure "Flash transfer"). */
  transferOnly: boolean;
  /** Nothing at all in the account. */
  empty: boolean;
  healthFactor: number | null;
}

export interface FlashPlanOptions {
  /** Also withdraw what is left to the wallet. */
  transfer?: boolean;
  /** Max slippage for swaps and perp closes, bps (default 50). */
  slippageBps?: number;
  /** Quote each planned swap through the aggregator for a real cost (default true). */
  quote?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Shared reading helpers
// ---------------------------------------------------------------------------------------------

const usdPerUnit = (p: OnchainPrice | null | undefined) => (p && p.price > 0n ? Number(p.price) * 10 ** p.exponent : 0);

/** Registry holdings of the margin (Phoenix venue and Kamino receipts excluded), raw. */
function tokenHoldings(s: MarginSnapshot): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const c of s.collateral) if (c.token && c.amountRaw > 0n) out.set(c.token.symbol, c.amountRaw);
  return out;
}

/** What a loan needs in its own token before repay_all: the accrued debt + {@link DEBT_BUFFER_BPS}. */
const coverNeed = (debtRaw: bigint) => debtRaw + (debtRaw * DEBT_BUFFER_BPS) / 10_000n + 2n;

/** Swap-source order: stables first, then the largest holding by USD. */
function sourceOrder(a: { symbol: string; usd: number }, b: { symbol: string; usd: number }) {
  return Number(isStable(b.symbol)) - Number(isStable(a.symbol)) || b.usd - a.usd;
}

/** Floors a UI amount to the token's decimals (string, safe for toRaw). */
function floorUi(x: number, decimals: number): string {
  const d = Math.min(decimals, 9);
  const f = Math.floor(x * 10 ** d) / 10 ** d;
  return f.toFixed(d);
}

async function quoteSwap(owner: PublicKey, from: string, to: string, amountUi: string, slippageBps: number, provider?: SwapProvider): Promise<AggregatedQuote> {
  const a = getToken(from);
  const b = getToken(to);
  return bestSwapQuote({
    mode: "margin",
    inputMint: a.mint.toBase58(),
    outputMint: b.mint.toBase58(),
    fromSymbol: a.symbol,
    toSymbol: b.symbol,
    amountUi,
    amountRaw: 0n,
    slippageBps,
    owner,
    provider,
  });
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

/**
 * Reads the live margin snapshot (with its Phoenix venue and Kamino receipts) and returns what a
 * flash repay would do, in order, with estimates: proceeds per position, how each loan is covered
 * (own token, then swaps), costs, what is left, and whether the account can cover its debt.
 */
export async function planFlashRepay(owner: PublicKey, opts: FlashPlanOptions = {}): Promise<FlashPlan> {
  const slippageBps = opts.slippageBps ?? 50;
  const transfer = Boolean(opts.transfer);
  const s = await fetchMarginSnapshot(owner);
  const px = (sym: string) => usdPerUnit(s.prices[sym]);

  // Positions → proceeds per token.
  const venue = s.venue;
  const perps: FlashPerpRow[] = (venue?.positions ?? []).map((p) => ({
    market: p.key,
    name: p.name,
    side: p.isLong ? "long" : "short",
    sizeUsd: p.sizeUsd,
    sizeTokens: p.sizeTokens,
    pnlUsd: p.pnlUsd + p.fundingUsd,
    closeFeeUsd: p.closeFeeUsd,
    equityUsd: p.equityUsd,
  }));
  const phoenixValueUsd = venue ? Number(venue.valueNano) / 1e9 : 0;
  const phoenixIdleUsdc = venue?.collateralUsd ?? 0;
  const farm: FlashFarmRow[] = [];
  for (const c of s.collateral) {
    const r = receiptByMint(c.mint);
    if (!r || c.amountRaw === 0n) continue;
    const p = px(r.underlying);
    farm.push({ symbol: r.underlying, receiptSymbol: r.symbol, receipts: c.amount, underlying: p > 0 ? c.usd / p : 0, usd: c.usd });
  }

  // Buckets: proceeds (from closing) and holdings (already in the margin), UI units.
  const pro = new Map<string, number>();
  const held = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  if (phoenixValueUsd > 0) add(pro, "USDC", phoenixValueUsd / (px("USDC") || 1));
  for (const f of farm) add(pro, f.symbol, f.underlying);
  const untouched: FlashLeftRow[] = [];
  for (const c of s.collateral) {
    if (c.token) {
      if (c.amountRaw > 0n) add(held, c.token.symbol, c.amount);
    } else if (!receiptByMint(c.mint) && c.symbol !== "Phoenix" && c.usd > DUST_USD) {
      untouched.push({ symbol: c.symbol, amount: c.amount, usd: c.usd });
    }
  }
  const total = (sym: string) => (pro.get(sym) ?? 0) + (held.get(sym) ?? 0);
  const take = (sym: string, want: number) => {
    const fromPro = Math.min(pro.get(sym) ?? 0, want);
    pro.set(sym, (pro.get(sym) ?? 0) - fromPro);
    const fromHeld = Math.min(held.get(sym) ?? 0, want - fromPro);
    held.set(sym, (held.get(sym) ?? 0) - fromHeld);
    return { fromPro, fromHeld };
  };

  // Pass 1: every loan takes its own token first (debt + buffer).
  const bufferFrac = Number(DEBT_BUFFER_BPS) / 10_000;
  const loans: FlashLoanRow[] = s.debts
    .filter((d) => d.debtRaw > 0n)
    .map((d) => {
      const need = d.debt * (1 + bufferFrac);
      const got = take(d.symbol, need);
      return { symbol: d.symbol, amount: d.debt, usd: d.usd, fromProceeds: got.fromPro, fromHoldings: got.fromHeld, swaps: [], shortAmount: need - got.fromPro - got.fromHeld };
    });

  // Pass 2: swaps for what's still missing (stables first, then the largest other holding).
  const slip = slippageBps / 10_000;
  const swaps: FlashSwapLeg[] = [];
  for (const l of loans) {
    let guard = 0;
    while (l.shortAmount > 1e-9 && guard++ < 10) {
      const srcs = [...new Set([...pro.keys(), ...held.keys()])]
        .filter((x) => x !== l.symbol && findToken(x) && px(x) > 0 && total(x) * px(x) > DUST_USD)
        .map((x) => ({ symbol: x, usd: total(x) * px(x) }))
        .sort(sourceOrder);
      if (!srcs.length || !(px(l.symbol) > 0)) break;
      const src = srcs[0].symbol;
      const needUsd = l.shortAmount * px(l.symbol) * (1 + slip + 0.003);
      const inUsd = Math.min(Math.max(needUsd, MIN_SWAP_USD), srcs[0].usd);
      const inAmount = inUsd / px(src);
      take(src, inAmount);
      const outAmount = inUsd / px(l.symbol);
      const leg: FlashSwapLeg = { from: src, to: l.symbol, inAmount, outAmount, inUsd, outUsd: inUsd, quoted: false };
      l.swaps.push(leg);
      swaps.push(leg);
      // Surplus over the loan's need stays in the margin as the loan's token.
      if (outAmount > l.shortAmount) add(pro, l.symbol, outAmount - l.shortAmount);
      l.shortAmount = Math.max(0, l.shortAmount - outAmount);
    }
  }

  // Real costs: quote each planned leg (best of Jupiter / Titan for the margin account).
  if (opts.quote !== false && swaps.length) {
    await Promise.all(
      swaps.map(async (leg) => {
        try {
          const from = getToken(leg.from);
          const to = getToken(leg.to);
          const q = await quoteSwap(owner, leg.from, leg.to, floorUi(leg.inAmount, from.decimals), slippageBps);
          const out = rawToNumber(BigInt(q.outAmount), to.decimals);
          if (out > 0) {
            // The loan keeps its exact need; any change in the out amount moves the leftover.
            add(pro, leg.to, out - leg.outAmount);
            leg.outAmount = out;
            leg.outUsd = out * px(leg.to);
            leg.quoted = true;
            leg.provider = q.provider;
          }
        } catch {
          // No route right now — keep the oracle estimate; execution quotes again anyway.
        }
      }),
    );
  }

  // What's left: every bucket after the loans (the buffer is not spent: repay_all takes the exact debt).
  const leftMap = new Map<string, number>();
  for (const k of new Set([...pro.keys(), ...held.keys()])) leftMap.set(k, total(k));
  for (const l of loans) leftMap.set(l.symbol, (leftMap.get(l.symbol) ?? 0) + l.amount * bufferFrac);
  const left: FlashLeftRow[] = [...leftMap.entries()]
    .map(([symbol, amount]) => ({ symbol, amount: Math.max(0, amount), usd: Math.max(0, amount) * px(symbol) }))
    .filter((x) => x.usd > DUST_USD)
    .sort((a, b) => b.usd - a.usd);

  const phoenixFee = perps.reduce((a, p) => a + p.closeFeeUsd, 0);
  const swapCost = swaps.reduce((a, l) => a + Math.max(0, l.inUsd - l.outUsd), 0);
  const debtUsd = loans.reduce((a, l) => a + l.usd, 0);
  const shortUsd = loans.reduce((a, l) => a + l.shortAmount * px(l.symbol), 0);
  const hasPhoenix = perps.length > 0 || phoenixIdleUsdc > 0.000001;
  const transferOnly = !hasPhoenix && !farm.length && !loans.length;
  const empty = !s.exists || (transferOnly && !left.length);

  // Steps, in order, with estimated wallet approvals.
  const steps: FlashStepPlan[] = [];
  const pl = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (hasPhoenix) {
    steps.push({
      key: "perps",
      title: perps.length ? `Close ${pl(perps.length, "perp position")} on Phoenix` : "Withdraw idle USDC from Phoenix",
      usd: phoenixValueUsd,
      txs: perps.length ? perps.length + 1 : 1,
    });
  }
  if (farm.length) steps.push({ key: "farm", title: `Exit ${pl(farm.length, "Farm position")} on Kamino`, usd: farm.reduce((a, f) => a + f.usd, 0), txs: farm.length });
  if (swaps.length) {
    const pairs = [...new Set(swaps.map((w) => `${w.from} to ${w.to}`))];
    steps.push({ key: "swap", title: `Swap ${pairs.join(", ")}`, usd: swaps.reduce((a, w) => a + w.inUsd, 0), txs: swaps.length });
  }
  if (loans.length) steps.push({ key: "repay", title: `Repay ${pl(loans.length, "loan")}`, usd: debtUsd, txs: loans.length });
  if (transfer || transferOnly) {
    if (left.length) steps.push({ key: "transfer", title: "Send everything to your wallet", usd: left.reduce((a, x) => a + x.usd, 0), txs: left.length });
  }

  return {
    owner: owner.toBase58(),
    exists: s.exists,
    transfer: transfer || transferOnly,
    slippageBps,
    perps,
    phoenixIdleUsdc,
    phoenixValueUsd,
    farm,
    loans,
    swaps,
    left,
    leftUsd: left.reduce((a, x) => a + x.usd, 0),
    debtUsd,
    costs: { phoenixUsd: phoenixFee, swapUsd: swapCost },
    costUsd: phoenixFee + swapCost,
    tradedUsd: perps.reduce((a, p) => a + p.sizeUsd, 0) + swaps.reduce((a, w) => a + w.inUsd, 0),
    pnlUsd: perps.reduce((a, p) => a + p.pnlUsd, 0),
    positionCount: perps.length + farm.length,
    shortUsd,
    untouched,
    steps,
    txCount: steps.reduce((a, x) => a + x.txs, 0),
    transferOnly,
    empty,
    healthFactor: s.healthFactor,
  };
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

export type FlashStepStatus = "wait" | "run" | "done" | "failed";

export interface FlashStepState {
  key: FlashStepKey;
  title: string;
  usd: number;
  status: FlashStepStatus;
  /** Every transaction this step landed, in order. */
  txs: { label: string; signature: string }[];
  /** Latest progress line (wallet / confirmation status) while running. */
  note?: string;
  /** What went wrong (failed steps). */
  error?: string;
}

export interface FlashExecuteOptions {
  signer?: TxSigner;
  /** Called after every change (a step starts, lands a transaction, finishes or fails). */
  onProgress?: (steps: FlashStepState[]) => void;
}

export interface FlashResult {
  ok: boolean;
  steps: FlashStepState[];
  /** Index of the step that failed (ok = false). */
  failedAt?: number;
  error?: string;
}

/** Error carrying a user-facing explanation (e.g. the account can't cover its debt). */
export class FlashRepayError extends Error {}

type Ctx = { owner: PublicKey; opts: MarginServiceOptions; slippageBps: number; record: (label: string, signature: string) => void; note: (s: string) => void };

/** Step 1: close every Phoenix position, then bring all of the trader's USDC back to the margin. */
async function runPerps(c: Ctx) {
  const s = await fetchMarginSnapshot(c.owner);
  for (const p of s.venue?.positions ?? []) {
    const side = p.isLong ? "long" : "short";
    c.note(`Closing ${p.name} ${side}`);
    const r = await closePerp({ market: p.key, side, slippageBps: c.slippageBps }, c.opts);
    c.record(`Close ${p.name} ${side}`, r.signature);
  }
  const after = await fetchMarginSnapshot(c.owner);
  const open = after.venue?.positions ?? [];
  if (open.length) throw new FlashRepayError(`${open.map((p) => p.name).join(", ")} still open: no liquidity inside the price limit — retry shortly`);
  const idle = after.venue?.trader?.collateral ?? 0n;
  if (idle > 0n) {
    const now = after.venue!.withdrawableNow;
    if (now <= 0n) throw new FlashRepayError(`Phoenix can't pay out the ${fromRaw(idle, 6)} USDC right now (withdraw budget used up) — retry in a few minutes`);
    const amount = idle <= now ? undefined : rawToNumber(now, 6);
    c.note("Moving USDC back from Phoenix");
    const r = await withdrawPerpCollateral({ amount }, c.opts);
    c.record("Withdraw from Phoenix", r.signature);
    if (amount !== undefined) {
      throw new FlashRepayError(`Phoenix paid out ${fromRaw(now, 6)} of ${fromRaw(idle, 6)} USDC (withdraw budget) — retry in a few minutes for the rest`);
    }
  }
}

/** Step 2: redeem every Kamino cToken back to its underlying (stays in the margin). */
async function runFarm(c: Ctx) {
  const s = await fetchMarginSnapshot(c.owner);
  for (const col of s.collateral) {
    const r = receiptByMint(col.mint);
    if (!r || col.amountRaw === 0n) continue;
    c.note(`Withdrawing ${r.underlying} from Kamino`);
    const res = await farmWithdraw({ symbol: r.underlying, all: true }, c.opts);
    c.record(`Exit ${r.underlying} on Kamino`, res.signature);
  }
}

/**
 * Step 3: make sure the margin holds every loan's token (+ buffer). Each round re-reads the chain,
 * picks the first loan still short and swaps into it from the best source (stables first, then the
 * largest holding), sized from the live quote's minimum out.
 */
async function runSwaps(c: Ctx) {
  for (let round = 0; round < MAX_SWAP_ROUNDS * 2; round++) {
    const s = await fetchMarginSnapshot(c.owner);
    const px = (sym: string) => usdPerUnit(s.prices[sym]);
    const hold = tokenHoldings(s);
    const needs = s.debts.filter((d) => d.debtRaw > 0n).map((d) => ({ symbol: d.symbol, need: coverNeed(d.debtRaw) }));
    const short = needs.find((n) => (hold.get(n.symbol) ?? 0n) < n.need);
    if (!short) return;
    const to = getToken(short.symbol);
    const missingRaw = short.need - (hold.get(short.symbol) ?? 0n);
    const missing = rawToNumber(missingRaw, to.decimals);
    // Free = holdings not reserved for their own loan.
    const free = [...hold.entries()]
      .filter(([sym]) => sym !== short.symbol && px(sym) > 0)
      .map(([sym, raw]) => {
        const own = needs.find((n) => n.symbol === sym)?.need ?? 0n;
        const f = raw > own ? raw - own : 0n;
        const t = getToken(sym);
        return { symbol: sym, raw: f, amount: rawToNumber(f, t.decimals), usd: rawToNumber(f, t.decimals) * px(sym) };
      })
      .filter((x) => x.usd > DUST_USD)
      .sort(sourceOrder);
    const freeUsd = free.reduce((a, x) => a + x.usd, 0);
    const missingUsd = missing * px(to.symbol);
    if (!free.length || freeUsd < missingUsd * 0.98) {
      throw new FlashRepayError(
        `The account can't cover its ${to.symbol} loan: ${fromRaw(missingRaw, to.decimals)} ${to.symbol} (~$${missingUsd.toFixed(2)}) short and only ~$${freeUsd.toFixed(2)} of other holdings left. Deposit ${to.symbol} into the margin account, then retry.`,
      );
    }
    const src = free[0];
    const from = getToken(src.symbol);
    const slip = c.slippageBps / 10_000;
    let inUsd = Math.min(src.usd, Math.max(missingUsd * (1 + slip + 0.003), MIN_SWAP_USD));
    let amountUi = floorUi(Math.min(src.amount, inUsd / px(from.symbol)), from.decimals);
    c.note(`Quoting ${from.symbol} → ${to.symbol}`);
    let quote = await quoteSwap(c.owner, from.symbol, to.symbol, amountUi, c.slippageBps);
    // Size from the guaranteed minimum out: scale the input up once if it wouldn't cover the gap.
    const minOut = BigInt(quote.otherAmountThreshold ?? quote.outAmount);
    if (minOut < missingRaw && Number(amountUi) < src.amount) {
      const scale = (Number(missingRaw) / Math.max(1, Number(minOut))) * 1.003;
      inUsd = Math.min(src.usd, inUsd * scale);
      amountUi = floorUi(Math.min(src.amount, inUsd / px(from.symbol)), from.decimals);
      quote = await quoteSwap(c.owner, from.symbol, to.symbol, amountUi, c.slippageBps);
    }
    const label = `Swap ${amountUi} ${from.symbol} → ${to.symbol}`;
    c.note(label);
    const req = { mode: "margin" as const, fromSymbol: from.symbol, toSymbol: to.symbol, amountUi, slippageBps: c.slippageBps };
    let signature: string;
    try {
      signature = await executeSwapQuote(quote, req, c.opts);
    } catch (error) {
      // A Titan route the margin adapter can't run: fall back to Jupiter once.
      if (quote.provider !== "titan") throw error;
      const jq = await quoteSwap(c.owner, from.symbol, to.symbol, amountUi, c.slippageBps, "jupiter");
      signature = await executeSwapQuote(jq, req, c.opts);
    }
    c.record(label, signature);
  }
  throw new FlashRepayError("Swaps didn't cover the loans after several tries — retry to continue from here");
}

/** Step 4: repay_all every loan from the margin vault (closes each debt position, reclaims rent). */
async function runRepay(c: Ctx) {
  // Interest accrued since the swaps (or a plan that needed none) can leave a loan a hair short:
  // top it up first (a no-op when every loan is covered).
  await runSwaps(c);
  const s = await fetchMarginSnapshot(c.owner);
  for (const d of s.debts.filter((x) => x.debtRaw > 0n)) {
    if (!d.token) throw new FlashRepayError(`${d.symbol} loan isn't a token this app can repay`);
    c.note(`Repaying ${d.symbol}`);
    const r = await repay({ symbol: d.symbol, all: true, source: "margin" }, c.opts);
    c.record(`Repay ${d.symbol}`, r.signature);
  }
  // Debt positions left open with zero shares (an earlier partial run): close them too.
  const after = await fetchMarginSnapshot(c.owner);
  for (const sym of after.openDebtPositions) {
    if (after.debts.some((d) => d.symbol === sym && d.debtRaw > 0n)) continue;
    const r = await closeDebtPosition(sym, c.opts);
    c.record(`Close ${sym} debt position`, r.signature);
  }
  if (after.debts.some((d) => d.debtRaw > 0n)) throw new FlashRepayError("A loan is still open after repaying — retry to continue");
}

/** Step 5: withdraw every remaining registry holding to the wallet. */
async function runTransfer(c: Ctx) {
  const s = await fetchMarginSnapshot(c.owner);
  if (s.debts.some((d) => d.debtRaw > 0n)) throw new FlashRepayError("Repay every loan before withdrawing everything");
  for (const col of s.collateral) {
    if (!col.token || col.amountRaw === 0n) continue;
    c.note(`Withdrawing ${col.token.symbol}`);
    const r = await withdrawCollateral({ symbol: col.token.symbol, all: true }, c.opts);
    c.record(`Withdraw ${fromRaw(col.amountRaw, col.token.decimals)} ${col.token.symbol}`, r.signature);
  }
}

const RUNNERS: Record<FlashStepKey, (c: Ctx) => Promise<void>> = { perps: runPerps, farm: runFarm, swap: runSwaps, repay: runRepay, transfer: runTransfer };

/**
 * Runs `plan`'s steps in order, each as its own transaction(s). Stops at the first failure and
 * reports exactly which steps completed (with their transactions) and which didn't; call
 * {@link planFlashRepay} + this again to resume from the chain's current state.
 */
export async function executeFlashRepay(plan: FlashPlan, opts: FlashExecuteOptions = {}): Promise<FlashResult> {
  const signer = opts.signer ?? getActiveSigner();
  if (signer.publicKey.toBase58() !== plan.owner) throw new FlashRepayError("The connected wallet changed — reopen Flash repay");
  if (plan.shortUsd > 0.01) throw new FlashRepayError("The account can't cover its loans — add funds first");
  const steps: FlashStepState[] = plan.steps.map((s) => ({ key: s.key, title: s.title, usd: s.usd, status: "wait", txs: [] }));
  const emit = () => opts.onProgress?.(steps.map((s) => ({ ...s, txs: [...s.txs] })));
  emit();
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    st.status = "run";
    emit();
    const ctx: Ctx = {
      owner: signer.publicKey,
      slippageBps: plan.slippageBps,
      opts: {
        signer,
        onStatus: (status: string) => {
          st.note = status;
          emit();
        },
      },
      record: (label, signature) => {
        if (signature) st.txs.push({ label, signature });
        emit();
      },
      note: (n) => {
        st.note = n;
        emit();
      },
    };
    try {
      await RUNNERS[st.key](ctx);
      st.status = "done";
      st.note = undefined;
      emit();
    } catch (error) {
      st.status = "failed";
      st.error = error instanceof FlashRepayError ? error.message : describeError(error, "Transaction failed");
      emit();
      return { ok: false, steps, failedAt: i, error: st.error };
    }
  }
  return { ok: true, steps };
}
