/**
 * End-to-end test of the new margin collateral (JupUSD and the Token-2022 xStocks NVDAx / GOOGLx /
 * AAPLx / TSLAx) against the fork, with a fresh Keypair standing in for the browser wallet. The
 * app's /api/jupiter/* calls are routed straight to the real Next.js route handlers.
 *
 *   npx tsx --env-file=.env.local scripts/e2e-collateral.ts
 *
 * Flow: faucet every registry token → registry checks (USDT not depositable, the xStocks Token-2022)
 * → seed Earn USDC → create margin → deposit each new collateral (its USD value vs Jupiter's price)
 * → borrow USDC against them (HF = holdings / debt) → margin swaps (Jupiter): USDC → NVDAx, GOOGLx → USDC, and xStock → xStock
 * (GOOGLx → AAPLx, TSLAx → GOOGLx; ~30-account routes, 256 KiB heap frame) → wallet spot swap USDC → TSLAx → withdraw some AAPLx while in
 * debt → repay all → withdraw every new collateral.
 */
import { Keypair } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { fundOnFork } from "@/lib/solana/server/fork-faucet";
import { fetchJupiterUsdPrices, refreshForkPrices } from "@/lib/solana/server/fork-prices";
import { healKaminoReserves } from "@/lib/solana/server/kamino-heal";
import { GET as quoteGET } from "@/app/api/jupiter/quote/route";
import { POST as swapInstructionsPOST } from "@/app/api/jupiter/swap-instructions/route";
import { POST as swapPOST } from "@/app/api/jupiter/swap/route";
import { executeWalletSwap, fetchJupiterQuote, setApiBase } from "@/lib/solana/swap";
import { executeMarginSwap, quoteMarginSwap, setExecApiBase } from "@/lib/solana/exec";
import { fetchWalletBalances } from "@/lib/solana/balances";
import { CollateralDropdownOptions } from "@/lib/constants";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  TOKENS,
  getToken,
  keypairSigner,
  setPriceRefresher,
  supply,
  createMarginAccount,
  depositAndBorrow,
  fetchMarginSnapshot,
  getConnection,
  describeError,
  repay,
  withdrawCollateral,
} from "@/lib/solana";

const BASE = "http://app.local";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(`${BASE}/api/jupiter/quote`)) return quoteGET(new NextRequest(url));
  if (url.startsWith(`${BASE}/api/jupiter/swap-instructions`)) return swapInstructionsPOST(new NextRequest(url, init as never));
  if (url.startsWith(`${BASE}/api/jupiter/swap`)) return swapPOST(new NextRequest(url, init as never));
  return realFetch(input, init);
}) as typeof fetch;
setApiBase(BASE);
setExecApiBase(BASE);

const kp = Keypair.generate();
const signer = keypairSigner(kp);
const owner = kp.publicKey;
setPriceRefresher(() => Promise.all([refreshForkPrices(), healKaminoReserves()]));
const opts = { signer, onStatus: (s: string) => process.stdout.write(`    · ${s}\n`) };

const NEW_COLLATERAL: { symbol: string; amount: number }[] = [
  { symbol: "JupUSD", amount: 500 },
  { symbol: "NVDAx", amount: 2 },
  { symbol: "GOOGLx", amount: 2 },
  { symbol: "AAPLx", amount: 2 },
  { symbol: "TSLAx", amount: 2 },
];

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

async function show(label: string) {
  const s = await fetchMarginSnapshot(owner);
  console.log(`  [${label}] HF=${s.healthFactor === null ? "∞" : s.healthFactor.toFixed(4)} holdings=$${s.totalCollateralUsd.toFixed(2)} debt=$${s.totalDebtUsd.toFixed(2)}`);
  for (const c of s.collateral) console.log(`    ${c.symbol.padEnd(8)} ${c.amount} = $${c.usd.toFixed(2)}`);
  for (const d of s.debts) console.log(`    debt ${d.symbol} ${d.debt} = $${d.usd.toFixed(2)}`);
  return s;
}

async function main() {
  console.log(`e2e wallet: ${owner.toBase58()}  slot ${await getConnection().getSlot()}`);

  await step("registry", async () => {
    assert(!CollateralDropdownOptions.includes("USDT"), "USDT is not offered as a deposit");
    for (const { symbol } of NEW_COLLATERAL) assert(CollateralDropdownOptions.includes(symbol), `${symbol} offered as a deposit`);
    for (const s of ["NVDAx", "GOOGLx", "AAPLx", "TSLAx"]) assert(getToken(s).tokenProgram.equals(TOKEN_2022_PROGRAM_ID), `${s} is Token-2022`);
    console.log(`  deposit picker: ${CollateralDropdownOptions.join(", ")}`);
  });

  await step("faucet every registry token", async () => {
    for (const t of TOKENS) await fundOnFork(t.symbol, owner.toBase58());
    for (let i = 0; i < 4; i++) await fundOnFork("USDC", owner.toBase58()); // 5,000 USDC: Earn seed + repay
    const b = await fetchWalletBalances(owner);
    for (const { symbol } of NEW_COLLATERAL) {
      console.log(`  wallet ${symbol} = ${b.ui[symbol]}`);
      assert(Number(b.ui[symbol]) > 0, `${symbol} funded`);
    }
  });

  await step("seed Earn USDC liquidity + create margin", async () => {
    await supply("USDC", "3000", opts);
    await createMarginAccount(opts);
  });

  const jup = await fetchJupiterUsdPrices(TOKENS);
  for (const { symbol, amount } of NEW_COLLATERAL) {
    await step(`deposit ${amount} ${symbol}`, async () => {
      await depositAndBorrow({ deposits: [{ symbol, amount }] }, opts);
      const s = await show(symbol);
      const row = s.collateral.find((c) => c.symbol === symbol);
      assert(row && Math.abs(row.amount - amount) < 1e-9, `${symbol} amount in the margin vault`);
      const expected = amount * (jup[symbol] ?? 0);
      const diff = expected ? Math.abs(row.usd - expected) / expected : 0;
      console.log(`  oracle $${row.usd.toFixed(2)} vs Jupiter $${expected.toFixed(2)} (${(diff * 100).toFixed(2)}%)`);
      assert(row.usd > 0, `${symbol} valued`);
      assert(!expected || diff < 0.03, `${symbol} oracle value within 3% of Jupiter`);
    });
  }

  await step("borrow 1,500 USDC against the new collateral", async () => {
    await depositAndBorrow({ borrows: [{ symbol: "USDC", amount: 1500 }] }, opts);
    const s = await show("borrowed");
    const hf = s.totalCollateralUsd / s.totalDebtUsd;
    assert(s.healthFactor !== null && Math.abs(s.healthFactor - hf) < 0.01, `HF = holdings / debt (${s.healthFactor} vs ${hf})`);
  });

  await step("margin swap 200 USDC → NVDAx (Jupiter)", async () => {
    const req = { fromSymbol: "USDC", toSymbol: "NVDAx", amount: 200, slippageBps: 100 };
    const before = (await fetchMarginSnapshot(owner)).collateral.find((c) => c.symbol === "NVDAx")?.amount ?? 0;
    await executeMarginSwap(req, await quoteMarginSwap(req), opts);
    const after = (await show("NVDAx bought")).collateral.find((c) => c.symbol === "NVDAx")?.amount ?? 0;
    assert(after > before, `NVDAx grew (${before} → ${after})`);
  });

  await step("margin swap 1 GOOGLx → USDC (unwind an xStock)", async () => {
    const req = { fromSymbol: "GOOGLx", toSymbol: "USDC", amount: 1, slippageBps: 100 };
    const before = (await fetchMarginSnapshot(owner)).collateral.find((c) => c.symbol === "USDC")?.amount ?? 0;
    await executeMarginSwap(req, await quoteMarginSwap(req), opts);
    const after = (await show("GOOGLx → USDC")).collateral.find((c) => c.symbol === "USDC")?.amount ?? 0;
    assert(after > before, `USDC grew (${before} → ${after})`);
  });

  await step("margin swap 0.5 GOOGLx → AAPLx (xStock to xStock, ~30-account route, 256 KiB heap)", async () => {
    const req = { fromSymbol: "GOOGLx", toSymbol: "AAPLx", amount: 0.5, slippageBps: 150 };
    const quote = await quoteMarginSwap(req);
    console.log(`  route: ${(quote.routePlan ?? []).map((r) => r.swapInfo?.label).join(" > ")}`);
    const before = (await fetchMarginSnapshot(owner)).collateral.find((c) => c.symbol === "AAPLx")?.amount ?? 0;
    await executeMarginSwap(req, quote, opts);
    const after = (await show("GOOGLx → AAPLx")).collateral.find((c) => c.symbol === "AAPLx")?.amount ?? 0;
    assert(after > before, `AAPLx grew (${before} → ${after})`);
  });

  await step("margin swap 0.5 TSLAx → GOOGLx (xStock to xStock)", async () => {
    const req = { fromSymbol: "TSLAx", toSymbol: "GOOGLx", amount: 0.5, slippageBps: 150 };
    const before = (await fetchMarginSnapshot(owner)).collateral.find((c) => c.symbol === "GOOGLx")?.amount ?? 0;
    await executeMarginSwap(req, await quoteMarginSwap(req), opts);
    const after = (await show("TSLAx → GOOGLx")).collateral.find((c) => c.symbol === "GOOGLx")?.amount ?? 0;
    assert(after > before, `GOOGLx grew (${before} → ${after})`);
  });

  await step("wallet spot swap 100 USDC → TSLAx", async () => {
    const usdc = getToken("USDC");
    const tsla = getToken("TSLAx");
    const before = Number((await fetchWalletBalances(owner)).ui.TSLAx);
    const quote = await fetchJupiterQuote({ inputMint: usdc.mint.toBase58(), outputMint: tsla.mint.toBase58(), amount: String(100 * 10 ** usdc.decimals), slippageBps: 100 });
    const sig = await executeWalletSwap(quote, { signer });
    const after = Number((await fetchWalletBalances(owner)).ui.TSLAx);
    console.log(`  TSLAx ${before} → ${after} tx=${sig}`);
    assert(after > before, "wallet TSLAx grew");
  });

  await step("withdraw 0.5 AAPLx while in debt", async () => {
    const before = Number((await fetchWalletBalances(owner)).ui.AAPLx);
    await withdrawCollateral({ symbol: "AAPLx", amount: 0.5 }, opts);
    const after = Number((await fetchWalletBalances(owner)).ui.AAPLx);
    assert(Math.abs(after - before - 0.5) < 1e-9, `0.5 AAPLx back in the wallet (${before} → ${after})`);
    await show("AAPLx withdrawn");
  });

  await step("repay all, then withdraw every new collateral", async () => {
    await repay({ symbol: "USDC", all: true, source: "wallet" }, opts);
    await show("repaid");
    for (const { symbol } of NEW_COLLATERAL) await withdrawCollateral({ symbol, all: true }, opts);
    const s = await show("withdrawn");
    for (const { symbol } of NEW_COLLATERAL) assert(!s.collateral.some((c) => c.symbol === symbol && c.amount > 0), `${symbol} vault empty`);
  });

  console.log("\n✔ e2e-collateral passed");
}

main().catch(() => process.exit(1));
