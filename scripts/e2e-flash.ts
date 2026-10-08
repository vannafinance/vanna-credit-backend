/**
 * End-to-end test of Flash repay (lib/solana/flash-repay.ts) against the fork, with a fresh Keypair
 * standing in for the browser wallet. The app's API routes it needs (Jupiter quote / swap
 * instructions, Titan quote, Phoenix lookup table / access / book) are routed straight to the real
 * Next.js route handlers (no dev server needed).
 *
 *   npx tsx --env-file=.env.local scripts/e2e-flash.ts
 *
 * Run 1 (flash repay, keep collateral): faucet → seed Earn liquidity → create margin → deposit
 * 3 SOL + 200 USDC → borrow 300 USDC + 0.5 SOL → margin swap 400 USDC → SOL → 2x SOL long on
 * Phoenix with 50 USDC → supply 30 USDC to Kamino → plan + execute: closes the perp, exits Kamino,
 * swaps SOL → USDC for the USDC loan, repays both loans → total debt 0, no positions left.
 *
 * Run 2 (flash repay and withdraw): borrow 0.2 SOL, swap all but 0.1 SOL → USDC (the SOL loan now needs a
 * swap back) → plan + execute with transfer → debt 0 and the margin account emptied to the wallet.
 */
import { Keypair } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { fundOnFork } from "@/lib/solana/server/fork-faucet";
import { refreshForkPrices } from "@/lib/solana/server/fork-prices";
import { healKaminoReserves } from "@/lib/solana/server/kamino-heal";
import { GET as quoteGET } from "@/app/api/jupiter/quote/route";
import { POST as swapInstructionsPOST } from "@/app/api/jupiter/swap-instructions/route";
import { GET as titanQuoteGET } from "@/app/api/titan/quote/route";
import { POST as lookupPOST } from "@/app/api/perps/lookup-table/route";
import { POST as accessPOST } from "@/app/api/perps/phoenix-access/route";
import { POST as bookPOST } from "@/app/api/perps/phoenix-book/route";
import { setApiBase } from "@/lib/solana/swap";
import { executeMarginSwap, farmDeposit, quoteMarginSwap, setExecApiBase } from "@/lib/solana/exec";
import { openPerp } from "@/lib/solana/perps";
import { executeFlashRepay, planFlashRepay, type FlashPlan } from "@/lib/solana/flash-repay";
import { receiptByMint } from "@/lib/solana/kamino";
import { TOKENS, keypairSigner, setPriceRefresher, supply, createMarginAccount, depositAndBorrow, fetchMarginSnapshot, fetchWalletBalances, getConnection, describeError } from "@/lib/solana";

const BASE = "http://app.local";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(`${BASE}/api/jupiter/quote`)) return quoteGET(new NextRequest(url));
  if (url.startsWith(`${BASE}/api/jupiter/swap-instructions`)) return swapInstructionsPOST(new NextRequest(url, init as never));
  if (url.startsWith(`${BASE}/api/titan/quote`)) return titanQuoteGET(new NextRequest(url));
  if (url.startsWith(`${BASE}/api/perps/lookup-table`)) return lookupPOST(new NextRequest(url, init as never));
  if (url.startsWith(`${BASE}/api/perps/phoenix-access`)) return accessPOST(new NextRequest(url, init as never));
  if (url.startsWith(`${BASE}/api/perps/phoenix-book`)) return bookPOST(new NextRequest(url, init as never));
  return realFetch(input, init);
}) as typeof fetch;
setApiBase(BASE);
setExecApiBase(BASE);

const kp = Keypair.generate();
const signer = keypairSigner(kp);
const owner = kp.publicKey;
// Same work as POST /api/prices/refresh.
setPriceRefresher(() => Promise.all([refreshForkPrices(), healKaminoReserves()]));
const opts = { signer, onStatus: (s: string) => process.stdout.write(`    · ${s}\n`) };

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    return await fn();
  } catch (error) {
    console.error(`✖ ${name} FAILED: ${describeError(error)}`);
    const raw = (error as { raw?: string }).raw;
    if (raw) console.error(raw.split("\n").slice(-30).join("\n"));
    throw error;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function printMargin(label: string) {
  const s = await fetchMarginSnapshot(owner);
  console.log(`  [${label}] HF=${s.healthFactor === null ? "∞" : s.healthFactor.toFixed(4)} holdings=$${s.totalCollateralUsd.toFixed(2)} debt=$${s.totalDebtUsd.toFixed(2)}`);
  for (const c of s.collateral) console.log(`    holding ${c.symbol.padEnd(9)} ${c.amount.toFixed(6).padStart(16)}  $${c.usd.toFixed(2)}${c.active ? "" : " (inactive)"}`);
  for (const d of s.debts) console.log(`    debt    ${d.symbol.padEnd(9)} ${d.debt.toFixed(6).padStart(16)}  $${d.usd.toFixed(2)}`);
  for (const p of s.venue?.positions ?? []) console.log(`    perp    ${p.name} ${p.isLong ? "long" : "short"} $${p.sizeUsd.toFixed(2)} equity $${p.equityUsd.toFixed(2)}`);
  return s;
}

function printPlan(p: FlashPlan) {
  console.log(`  plan: ${p.positionCount} positions, ${p.loans.length} loans ($${p.debtUsd.toFixed(2)}), costs $${p.costUsd.toFixed(2)}, left $${p.leftUsd.toFixed(2)}, short $${p.shortUsd.toFixed(2)}, ~${p.txCount} txs, transfer=${p.transfer}`);
  for (const r of p.perps) console.log(`    perp ${r.name} ${r.side} size $${r.sizeUsd.toFixed(2)} pnl ${r.pnlUsd.toFixed(2)} → +${r.equityUsd.toFixed(2)} USDC`);
  if (p.phoenixIdleUsdc > 0) console.log(`    phoenix idle ${p.phoenixIdleUsdc.toFixed(2)} USDC`);
  for (const f of p.farm) console.log(`    farm ${f.receiptSymbol} ${f.receipts} → ${f.underlying.toFixed(6)} ${f.symbol}`);
  for (const l of p.loans)
    console.log(`    loan ${l.amount.toFixed(6)} ${l.symbol}: own ${(l.fromProceeds + l.fromHoldings).toFixed(6)}, swaps ${l.swaps.map((w) => `${w.inAmount.toFixed(4)} ${w.from}→${w.outAmount.toFixed(4)} ${w.to}${w.quoted ? ` (${w.provider})` : " (oracle)"}`).join(", ") || "—"}, short ${l.shortAmount.toFixed(6)}`);
  for (const x of p.left) console.log(`    left ${x.amount.toFixed(6)} ${x.symbol} $${x.usd.toFixed(2)}`);
  for (const s of p.steps) console.log(`    step ${s.key.padEnd(8)} ${s.title} ($${s.usd.toFixed(2)}, ~${s.txs} tx)`);
}

async function flash(transfer: boolean) {
  const plan = await planFlashRepay(owner, { transfer, slippageBps: 100 });
  printPlan(plan);
  assert(plan.shortUsd < 0.01, "the account covers its debt");
  let last = "";
  const res = await executeFlashRepay(plan, {
    signer,
    onProgress: (steps) => {
      const line = steps.map((s) => `${s.key}:${s.status}${s.txs.length ? `(${s.txs.length})` : ""}`).join("  ");
      if (line !== last) console.log(`    ${line}`);
      last = line;
    },
  });
  for (const s of res.steps) for (const t of s.txs) console.log(`    ${s.key.padEnd(8)} ${t.label}  ${t.signature.slice(0, 16)}…`);
  if (!res.ok) throw new Error(`flash repay stopped at step ${res.failedAt}: ${res.error}`);
  return res;
}

async function main() {
  console.log(`e2e wallet: ${owner.toBase58()}  slot ${await getConnection().getSlot()}`);
  await step("faucet + seed Earn liquidity", async () => {
    for (const t of TOKENS) await fundOnFork(t.symbol, owner.toBase58());
    for (const t of TOKENS.filter((x) => x.lendable)) await supply(t.symbol, 500, opts);
  });
  await step("create margin, deposit 3 SOL + 200 USDC, borrow 300 USDC + 0.5 SOL", async () => {
    await createMarginAccount(opts);
    await depositAndBorrow({ deposits: [{ symbol: "SOL", amount: 3 }, { symbol: "USDC", amount: 200 }], borrows: [{ symbol: "USDC", amount: 300 }, { symbol: "SOL", amount: 0.5 }] }, opts);
  });
  await step("margin swap 400 USDC → SOL", async () => {
    const req = { fromSymbol: "USDC", toSymbol: "SOL", amount: 400, slippageBps: 100 };
    console.log(`  tx ${(await executeMarginSwap(req, await quoteMarginSwap(req), opts)).signature}`);
  });
  await step("2x SOL long on Phoenix with 50 USDC", async () => {
    console.log(`  ${(await openPerp({ market: "SOL", side: "long", collateral: 50, leverage: 2 }, opts)).summary}`);
  });
  await step("Farm: supply 30 USDC to Kamino", async () => {
    console.log(`  tx ${(await farmDeposit({ symbol: "USDC", marginAmount: 30 }, opts)).signature}`);
  });
  await printMargin("before flash repay");

  await step("RUN 1: flash repay (keep collateral)", () => flash(false));
  const s1 = await printMargin("after run 1");
  assert(s1.debts.every((d) => d.debtRaw === 0n) && s1.totalDebtUsd === 0, "total debt is 0");
  assert(!(s1.venue?.positions.length), "no Phoenix positions");
  assert(!s1.collateral.some((c) => c.symbol === "Phoenix"), "the Phoenix venue left the collateral list");
  assert(!s1.collateral.some((c) => receiptByMint(c.mint) && c.amountRaw > 0n), "no Kamino receipts left");
  assert(s1.totalCollateralUsd > 100, "collateral stays in the margin");

  await step("borrow 0.2 SOL, swap all but 0.1 SOL → USDC (the SOL loan now needs a swap)", async () => {
    await depositAndBorrow({ borrows: [{ symbol: "SOL", amount: 0.2 }] }, opts);
    // Keep less SOL in the margin than the SOL loan, so repaying it needs a USDC → SOL swap.
    const s = await fetchMarginSnapshot(owner);
    const sol = s.collateral.find((c) => c.symbol === "SOL")?.amount ?? 0;
    const req = { fromSymbol: "SOL", toSymbol: "USDC", amount: Math.floor((sol - 0.1) * 1e6) / 1e6, slippageBps: 100 };
    console.log(`  swap ${req.amount} SOL tx ${(await executeMarginSwap(req, await quoteMarginSwap(req), opts)).signature}`);
  });
  await printMargin("before run 2");
  const walletBefore = (await fetchWalletBalances(owner)).raw.USDC;
  await step("RUN 2: flash repay and withdraw", () => flash(true));
  const s2 = await printMargin("after run 2");
  assert(s2.totalDebtUsd === 0 && s2.debts.length === 0, "total debt is 0");
  assert(s2.collateral.every((c) => c.amountRaw === 0n), "the margin account is empty");
  const walletAfter = (await fetchWalletBalances(owner)).raw.USDC;
  assert(walletAfter > walletBefore + 500_000_000n, `the USDC landed in the wallet (${walletBefore} → ${walletAfter})`);
  console.log("\n✔ e2e-flash passed");
}

main().catch((error) => {
  console.error(`✖ ${describeError(error)}`);
  process.exit(1);
});
