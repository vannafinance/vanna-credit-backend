/**
 * End-to-end test of the Perps page's service layer (lib/solana/perps.ts — Phoenix) against the
 * fork, with a fresh Keypair standing in for the browser wallet. The app's /api/perps/lookup-table
 * call is routed straight to the real Next.js route handler (no dev server needed).
 *
 *   npx tsx --env-file=.env.local scripts/e2e-perps.ts
 *
 * Flow: faucet → create margin → deposit 1,000 USDC → 2x SOL long with 200 USDC (Ember wrap +
 * Phoenix deposit + market order in one transaction) → HF counts the Phoenix venue → borrow 300 USDC,
 * then a 2x TSLA short with 100 USDC → close the SOL long (TSLA stays, USDC stays in Phoenix) →
 * close the TSLA short (USDC withdrawn back to the margin, the venue leaves the collateral list) →
 * history rows.
 */
import { Keypair } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { fundOnFork } from "@/lib/solana/server/fork-faucet";
import { refreshForkPrices } from "@/lib/solana/server/fork-prices";
import { healKaminoReserves } from "@/lib/solana/server/kamino-heal";
import { POST as lookupPOST } from "@/app/api/perps/lookup-table/route";
import { POST as accessPOST } from "@/app/api/perps/phoenix-access/route";
import { POST as bookPOST } from "@/app/api/perps/phoenix-book/route";
import { setExecApiBase } from "@/lib/solana/exec";
import { closePerp, fetchPerpsHistory, fetchPerpsView, openPerp } from "@/lib/solana/perps";
import { TOKENS, keypairSigner, setPriceRefresher, createMarginAccount, depositAndBorrow, fetchMarginSnapshot, fetchMarginHistory, getConnection, describeError } from "@/lib/solana";

const BASE = "http://app.local";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(`${BASE}/api/perps/lookup-table`)) return lookupPOST(new NextRequest(url, init as never));
  if (url.startsWith(`${BASE}/api/perps/phoenix-access`)) return accessPOST(new NextRequest(url, init as never));
  if (url.startsWith(`${BASE}/api/perps/phoenix-book`)) return bookPOST(new NextRequest(url, init as never));
  return realFetch(input, init);
}) as typeof fetch;
setExecApiBase(BASE);

const kp = Keypair.generate();
const signer = keypairSigner(kp);
const owner = kp.publicKey;
setPriceRefresher(() => Promise.all([refreshForkPrices(), healKaminoReserves()]));
const opts = { signer, onStatus: (s: string) => process.stdout.write(`    · ${s}\n`) };

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
  const v = await fetchPerpsView(owner);
  const a = v.account;
  console.log(
    `  [${label}] HF=${a.healthFactor === null ? "∞" : a.healthFactor.toFixed(4)} holdings=$${a.totalCollateralUsd.toFixed(2)} debt=$${a.totalDebtUsd.toFixed(2)} marginUSDC=${a.marginUsdc.toFixed(2)} phoenix=$${a.venueValueUsd.toFixed(2)} (collateral ${a.idleUsdc.toFixed(2)}, withdrawable now ${a.withdrawableNowUsdc.toFixed(2)})`,
  );
  for (const p of v.positions)
    console.log(`    ${p.marketName} ${p.side.padEnd(5)} size=$${p.sizeUsd.toFixed(2)} (${p.sizeTokens}) entry=${p.entryPrice.toFixed(2)} index=${p.markPrice.toFixed(2)} pnl=${p.pnlUsd.toFixed(2)} funding=${p.fundingUsd.toFixed(4)} equity=${p.equityUsd.toFixed(2)} lev=${p.leverage.toFixed(2)}x liq=${p.liquidationPrice?.toFixed(2) ?? "—"}`);
  return v;
}

async function main() {
  console.log(`e2e wallet: ${owner.toBase58()}  slot ${await getConnection().getSlot()}`);
  await step("markets", async () => {
    const v = await fetchPerpsView(null);
    for (const m of v.markets) console.log(`  ${m.name} index=${m.indexPrice} mark=${m.markPrice} fresh=${m.priceFresh} max=${m.maxLeverage}x trading=${m.tradingEnabled}`);
    assert(v.markets.length === 5, "SOL, ETH, BTC, TSLA and META listed");
  });
  await step("faucet + create margin + deposit 1000 USDC", async () => {
    for (const t of TOKENS) await fundOnFork(t.symbol, owner.toBase58());
    await createMarginAccount(opts);
    await depositAndBorrow({ deposits: [{ symbol: "USDC", amount: 1000 }] }, opts);
    await show("funded");
  });

  await step("2x SOL long with 200 USDC (wrap + deposit + order, one tx)", async () => {
    const r = await openPerp({ market: "SOL", side: "long", collateral: 200, leverage: 2 }, opts);
    console.log(`  ${r.summary} tx=${r.signature}`);
    const v = await show("SOL long");
    const pos = v.positions.find((p) => p.market === "SOL" && p.side === "long");
    assert(pos && pos.sizeUsd > 300 && pos.sizeUsd < 420, `SOL position ~$400 (${pos?.sizeUsd})`);
    assert(Math.abs(v.account.marginUsdc - 800) < 0.01, "200 USDC moved out of the margin");
    assert(v.account.venueValueUsd > 190, "the Phoenix venue counts toward holdings");
    const s = await fetchMarginSnapshot(owner);
    assert(s.collateral.some((c) => c.symbol === "Phoenix"), "the venue is on the collateral list");
  });

  await step("borrow 300 USDC, then a 2x TSLA short with 100 USDC", async () => {
    await depositAndBorrow({ borrows: [{ symbol: "USDC", amount: 300 }] }, opts);
    const r = await openPerp({ market: "TSLA", side: "short", collateral: 100, leverage: 2 }, opts);
    console.log(`  ${r.summary} tx=${r.signature}`);
    const v = await show("SOL long + TSLA short");
    assert(v.positions.some((p) => p.market === "TSLA" && p.side === "short"), "TSLA short open");
    const hf = v.account.totalCollateralUsd / v.account.totalDebtUsd;
    assert(v.account.healthFactor !== null && Math.abs(v.account.healthFactor - hf) < 0.01, `HF = holdings / debt (${v.account.healthFactor} vs ${hf})`);
  });

  await step("close the SOL long (TSLA stays open, USDC stays in Phoenix)", async () => {
    const r = await closePerp({ market: "SOL", side: "long" }, opts);
    console.log(`  ${r.summary}`);
    const v = await show("SOL closed");
    assert(!v.positions.some((p) => p.market === "SOL"), "SOL long gone");
    assert(v.positions.some((p) => p.market === "TSLA"), "TSLA still open");
  });

  await step("close the TSLA short (everything back to the margin)", async () => {
    const before = (await fetchPerpsView(owner)).account.marginUsdc;
    const r = await closePerp({ market: "TSLA", side: "short" }, opts);
    console.log(`  ${r.summary}`);
    const v = await show("all closed");
    assert(v.positions.length === 0, "nothing open");
    assert(v.account.marginUsdc > before + 250, `USDC back in the margin (${before} → ${v.account.marginUsdc})`);
    const s = await fetchMarginSnapshot(owner);
    assert(!s.collateral.some((c) => c.symbol === "Phoenix"), "the Phoenix venue left the collateral list");
  });

  await step("perps history", async () => {
    const rows = await fetchPerpsHistory(owner);
    for (const r of rows) console.log(`  ${r.action.padEnd(8)} ${r.market ?? "—"} ${r.side ?? ""} size=${r.sizeUsd?.toFixed(2) ?? "—"} usdc=${r.usdc ?? "—"} ${r.signature.slice(0, 10)}…`);
    assert(rows.some((r) => r.action === "open" && r.market === "SOL" && r.side === "long"), "SOL open row");
    assert(rows.some((r) => r.action === "close" && r.market === "TSLA" && r.side === "short"), "TSLA close row");
    assert(rows.some((r) => r.action === "deposit"), "deposit row");
    assert(rows.some((r) => r.action === "settle"), "withdraw row");
    const h = await fetchMarginHistory(owner);
    assert(h.rows.some((r) => r.type === "perp-open") && h.rows.some((r) => r.type === "perp-settle"), "margin history has the Phoenix funding and its return");
  });
  console.log("\n✔ e2e-perps passed");
}

main().catch(() => process.exit(1));
