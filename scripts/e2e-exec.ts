/**
 * End-to-end test of the margin_execute flows (lib/solana/exec.ts) against the fork, with a fresh
 * Keypair standing in for the browser wallet. The app's /api/jupiter/* calls are routed straight
 * to the real Next.js route handlers (no dev server needed).
 *
 *   npx tsx --env-file=.env.local scripts/e2e-exec.ts
 *
 * Flow: faucet → seed Earn liquidity → create margin → deposit USDC, borrow SOL (cross-asset) →
 * margin swap SOL → JitoSOL (Jupiter) → deposit 1 JitoSOL collateral → Farm: supply the margin
 * account's JitoSOL to Kamino (no leverage) → check HF counts the cTokens → Farm withdraw half →
 * margin swap back JitoSOL → USDC.
 */
import { Keypair } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { fundOnFork } from "@/lib/solana/server/fork-faucet";
import { refreshForkPrices } from "@/lib/solana/server/fork-prices";
import { healKaminoReserves } from "@/lib/solana/server/kamino-heal";
import { GET as quoteGET } from "@/app/api/jupiter/quote/route";
import { POST as swapInstructionsPOST } from "@/app/api/jupiter/swap-instructions/route";
import { setApiBase } from "@/lib/solana/swap";
import { executeMarginSwap, farmDeposit, farmWithdraw, quoteMarginSwap, setExecApiBase } from "@/lib/solana/exec";
import { receiptForUnderlying } from "@/lib/solana/kamino";
import {
  TOKENS,
  keypairSigner,
  setPriceRefresher,
  supply,
  createMarginAccount,
  depositAndBorrow,
  fetchMarginSnapshot,
  fetchMarginHistory,
  getConnection,
  describeError,
} from "@/lib/solana";

const BASE = "http://app.local";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(`${BASE}/api/jupiter/quote`)) return quoteGET(new NextRequest(url));
  if (url.startsWith(`${BASE}/api/jupiter/swap-instructions`)) return swapInstructionsPOST(new NextRequest(url, init as never));
  return realFetch(input, init);
}) as typeof fetch;
setApiBase(BASE);
setExecApiBase(BASE);

const kp = Keypair.generate();
const signer = keypairSigner(kp);
const owner = kp.publicKey;
// Same work as POST /api/prices/refresh.
setPriceRefresher(() => Promise.all([refreshForkPrices(), healKaminoReserves().then((h) => h.length && console.log(`    healed reserves: ${JSON.stringify(h)}`))]));
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

async function printMargin(label: string) {
  const s = await fetchMarginSnapshot(owner);
  console.log(`  [${label}] HF=${s.healthFactor === null ? "∞" : s.healthFactor.toFixed(4)} collateral=$${s.totalCollateralUsd.toFixed(2)} debt=$${s.totalDebtUsd.toFixed(2)}`);
  for (const c of s.collateral) console.log(`    collateral ${c.symbol.padEnd(9)} ${c.amount.toFixed(6).padStart(16)}  $${c.usd.toFixed(2)}${c.active ? "" : " (inactive)"}`);
  for (const d of s.debts) console.log(`    debt       ${d.symbol.padEnd(9)} ${d.debt.toFixed(6).padStart(16)}  $${d.usd.toFixed(2)}`);
  return s;
}

async function main() {
  console.log(`e2e wallet: ${owner.toBase58()}  slot ${await getConnection().getSlot()}`);
  await step("faucet 1000 of each token", async () => {
    for (const t of TOKENS) {
      const r = await fundOnFork(t.symbol, owner.toBase58());
      console.log(`  +${r.added} ${r.symbol}`);
    }
  });
  await step("seed Earn liquidity (500 of each lendable token)", async () => {
    for (const t of TOKENS.filter((x) => x.lendable)) console.log(`  supply ${t.symbol}: ${(await supply(t.symbol, 500, opts)).signature}`);
  });
  await step("create margin account", async () => console.log(`  ${(await createMarginAccount(opts)).address}`));
  await step("deposit 400 USDC + borrow 1 SOL (cross-asset)", async () => {
    console.log(`  tx ${(await depositAndBorrow({ deposits: [{ symbol: "USDC", amount: 400 }], borrows: [{ symbol: "SOL", amount: 1 }] }, opts)).signature}`);
  });
  await printMargin("after borrow");

  await step("margin swap 0.5 SOL → JitoSOL via Jupiter", async () => {
    const req = { fromSymbol: "SOL", toSymbol: "JitoSOL", amount: 0.5, slippageBps: 100 };
    const quote = await quoteMarginSwap(req);
    console.log(`  quote out=${quote.outAmount} min=${quote.otherAmountThreshold} via ${(quote.routePlan ?? []).map((r) => r.swapInfo?.label).join(" → ")}`);
    console.log(`  tx ${(await executeMarginSwap(req, quote, opts)).signature}`);
  });
  await printMargin("after swap");

  await step("deposit 1 JitoSOL into the margin account", async () => {
    console.log(`  tx ${(await depositAndBorrow({ deposits: [{ symbol: "JitoSOL", amount: 1 }] }, opts)).signature}`);
  });

  await step("Farm: supply the margin account's JitoSOL to Kamino", async () => {
    const s = await fetchMarginSnapshot(owner);
    const held = s.collateral.find((c) => c.symbol === "JitoSOL")?.amount ?? 0;
    console.log(`  tx ${(await farmDeposit({ symbol: "JitoSOL", marginAmount: Math.floor(held * 1e6) / 1e6 }, opts)).signature}`);
  });
  const afterFarm = await printMargin("after farm deposit");
  const k = afterFarm.collateral.find((c) => c.symbol === receiptForUnderlying("JitoSOL")!.symbol);
  if (!k || k.usd <= 0) throw new Error("kJitoSOL collateral missing or valued at $0");

  await step("Farm: withdraw half of kJitoSOL", async () => {
    const r = await farmWithdraw({ symbol: "JitoSOL", receipts: Math.floor((k.amount / 2) * 1e6) / 1e6 }, opts);
    console.log(`  tx ${r.signature} (≈${r.underlying} JitoSOL back to margin)`);
  });
  await printMargin("after farm withdraw");

  await step("margin swap 0.5 JitoSOL → USDC via Jupiter", async () => {
    const req = { fromSymbol: "JitoSOL", toSymbol: "USDC", amount: 0.5, slippageBps: 100 };
    const quote = await quoteMarginSwap(req);
    console.log(`  tx ${(await executeMarginSwap(req, quote, opts)).signature}`);
  });
  await printMargin("final");

  const history = await fetchMarginHistory(owner);
  console.log(`\nhistory rows: ${history.rows.map((r) => r.type).join(", ")}`);
  console.log("\n✔ e2e-exec passed");
}

main().catch(() => process.exit(1));
