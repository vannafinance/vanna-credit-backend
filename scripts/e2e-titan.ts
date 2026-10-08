/**
 * End-to-end test of the Spot page's Titan path (lib/solana/aggregator.ts with `provider: "titan"`)
 * against the fork, with a fresh Keypair standing in for the browser wallet. The app's
 * /api/titan/quote route is called in-process (needs TITAN_API_KEY in .env.local).
 *
 *   npx tsx --env-file=.env.local scripts/e2e-titan.ts
 *
 * Flow: faucet → create margin → deposit 500 USDC → margin swap 100 USDC → SOL via Titan →
 * margin swap 0.3 SOL → USDC via Titan → wallet swap 0.5 SOL → USDC via Titan → the picker's
 * Jupiter-only quote still works.
 */
import { Keypair } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { fundOnFork } from "@/lib/solana/server/fork-faucet";
import { refreshForkPrices } from "@/lib/solana/server/fork-prices";
import { healKaminoReserves } from "@/lib/solana/server/kamino-heal";
import { GET as titanQuoteGET } from "@/app/api/titan/quote/route";
import { GET as quoteGET } from "@/app/api/jupiter/quote/route";
import { POST as swapInstructionsPOST } from "@/app/api/jupiter/swap-instructions/route";
import { setApiBase } from "@/lib/solana/swap";
import { setExecApiBase } from "@/lib/solana/exec";
import { bestSwapQuote, executeSwapQuote, type SwapProvider } from "@/lib/solana/aggregator";
import { fromRaw, toRaw } from "@/lib/solana/math";
import { fetchWalletBalances } from "@/lib/solana/balances";
import { TOKENS, keypairSigner, setPriceRefresher, createMarginAccount, depositAndBorrow, fetchMarginSnapshot, describeError } from "@/lib/solana";

const BASE = "http://app.local";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(`${BASE}/api/titan/quote`)) return titanQuoteGET(new NextRequest(url));
  if (url.startsWith(`${BASE}/api/jupiter/quote`)) return quoteGET(new NextRequest(url));
  if (url.startsWith(`${BASE}/api/jupiter/swap-instructions`)) return swapInstructionsPOST(new NextRequest(url, init as never));
  return realFetch(input, init);
}) as typeof fetch;
setApiBase(BASE);
setExecApiBase(BASE);

const kp = Keypair.generate();
const signer = keypairSigner(kp);
const owner = kp.publicKey;
setPriceRefresher(() => Promise.all([refreshForkPrices(), healKaminoReserves()]));
const opts = { signer, onStatus: (s: string) => process.stdout.write(`    · ${s}\n`) };

const token = (symbol: string) => {
  const t = TOKENS.find((x) => x.symbol === symbol);
  if (!t) throw new Error(`${symbol} not in the registry`);
  return t;
};

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    return await fn();
  } catch (error) {
    console.error(`✖ ${name} FAILED: ${describeError(error)}`);
    const raw = (error as { raw?: string }).raw;
    if (raw) console.error(raw.split("\n").slice(-40).join("\n"));
    throw error;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

/** Quotes with the picked aggregator, swaps, and returns the quote that ran. */
async function swap(mode: "wallet" | "margin", provider: SwapProvider, from: string, to: string, amount: string) {
  const f = token(from);
  const t = token(to);
  const req = { mode, inputMint: f.mint.toBase58(), outputMint: t.mint.toBase58(), fromSymbol: from, toSymbol: to, amountUi: amount, amountRaw: toRaw(amount, f.decimals), slippageBps: 100, owner, provider };
  const quote = await bestSwapQuote(req);
  console.log(`  quote: ${amount} ${from} → ${fromRaw(BigInt(quote.outAmount), t.decimals)} ${to} via ${quote.provider} (${(quote.routePlan ?? []).map((r) => r.swapInfo?.label).join(", ")})`);
  assert(quote.provider === provider, `quoted by ${provider}`);
  const sig = await executeSwapQuote(quote, { mode, fromSymbol: from, toSymbol: to, amountUi: amount, slippageBps: 100 }, opts);
  console.log(`  tx=${sig}`);
  return quote;
}

const marginAmount = async (symbol: string) => Number((await fetchMarginSnapshot(owner)).collateral.find((c) => c.symbol === symbol)?.amount ?? 0);

async function main() {
  console.log(`e2e wallet: ${owner.toBase58()}`);
  await step("faucet + create margin + deposit 500 USDC", async () => {
    for (const s of ["SOL", "USDC"]) await fundOnFork(s, owner.toBase58());
    await createMarginAccount(opts);
    await depositAndBorrow({ deposits: [{ symbol: "USDC", amount: 500 }] }, opts);
  });

  await step("margin swap 100 USDC → SOL via Titan", async () => {
    const before = await marginAmount("SOL");
    await swap("margin", "titan", "USDC", "SOL", "100");
    const after = await marginAmount("SOL");
    console.log(`  margin SOL ${before} → ${after}`);
    assert(after > before, "SOL arrived in the margin account");
  });

  await step("margin swap 0.3 SOL → USDC via Titan", async () => {
    const before = await marginAmount("USDC");
    await swap("margin", "titan", "SOL", "USDC", "0.3");
    const after = await marginAmount("USDC");
    console.log(`  margin USDC ${before} → ${after}`);
    assert(after > before, "USDC arrived in the margin account");
  });

  await step("wallet swap 0.5 SOL → USDC via Titan", async () => {
    const before = Number((await fetchWalletBalances(owner)).ui.USDC ?? 0);
    await swap("wallet", "titan", "SOL", "USDC", "0.5");
    const after = Number((await fetchWalletBalances(owner)).ui.USDC ?? 0);
    console.log(`  wallet USDC ${before} → ${after}`);
    assert(after > before, "USDC arrived in the wallet");
  });

  await step("Jupiter picked: quote comes from Jupiter only", async () => {
    const q = await bestSwapQuote({ mode: "margin", inputMint: token("USDC").mint.toBase58(), outputMint: token("SOL").mint.toBase58(), fromSymbol: "USDC", toSymbol: "SOL", amountUi: "10", amountRaw: toRaw("10", 6), slippageBps: 100, owner, provider: "jupiter" });
    assert(q.provider === "jupiter" && q.quotes.length === 1, "Jupiter-only quote");
  });
  console.log("\n✔ e2e-titan passed");
}

main().catch(() => process.exit(1));
