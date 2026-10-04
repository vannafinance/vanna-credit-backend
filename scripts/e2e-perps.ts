/**
 * End-to-end test of the Perps page's service layer (lib/solana/perps.ts) against the fork, with a
 * fresh Keypair standing in for the browser wallet. The app's /api/perps/* calls are routed straight
 * to the real Next.js route handlers (no dev server needed).
 *
 *   npx tsx --env-file=.env.local scripts/e2e-perps.ts
 *
 * Flow (Frontend Integration Guide, "GMTrade: perpetual positions"): faucet → create margin →
 * deposit 1,000 USDC → open a 3x ETH long (prepare_user + prepare_position + order, keeper fill) →
 * HF counts the venue account → borrow 300 USDC, then a 2x BTC short → close the ETH long (fill +
 * settle back to the margin) → open a SOL long, cancel it while pending (+ settle) → close the BTC
 * short → no market open, the GMTrade slot freed.
 */
import { Keypair } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { fundOnFork } from "@/lib/solana/server/fork-faucet";
import { refreshForkPrices } from "@/lib/solana/server/fork-prices";
import { healKaminoReserves } from "@/lib/solana/server/kamino-heal";
import { POST as fillPOST } from "@/app/api/perps/fill/route";
import { POST as lookupPOST } from "@/app/api/perps/lookup-table/route";
import { setExecApiBase } from "@/lib/solana/exec";
import { cancelPerpOrder, closePerp, fetchPerpsHistory, fetchPerpsView, openPerp } from "@/lib/solana/perps";
import { TOKENS, keypairSigner, setPriceRefresher, createMarginAccount, depositAndBorrow, fetchMarginSnapshot, fetchMarginHistory, getConnection, describeError } from "@/lib/solana";

const BASE = "http://app.local";
const realFetch = globalThis.fetch;
/** When set, the fork keeper is held back so an order stays pending (to cancel it). */
let holdKeeper = false;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(`${BASE}/api/perps/lookup-table`)) return lookupPOST(new NextRequest(url, init as never));
  if (url.startsWith(`${BASE}/api/perps/fill`)) {
    if (holdKeeper) return new Response(JSON.stringify({ ok: true, fills: [] }), { status: 200 });
    return fillPOST(new NextRequest(url, init as never));
  }
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
    `  [${label}] HF=${a.healthFactor === null ? "∞" : a.healthFactor.toFixed(4)} holdings=$${a.totalCollateralUsd.toFixed(2)} debt=$${a.totalDebtUsd.toFixed(2)} marginUSDC=${a.marginUsdc.toFixed(2)} venue=$${a.venueValueUsd.toFixed(2)} idle=${a.idleUsdc.toFixed(2)}`,
  );
  for (const p of v.positions)
    console.log(`    ${p.marketName} ${p.side.padEnd(5)} size=$${p.sizeUsd.toFixed(2)} entry=${p.entryPrice.toFixed(2)} mark=${p.markPrice.toFixed(2)} coll=${p.collateralUsdc.toFixed(2)} lev=${p.leverage.toFixed(2)}x pnl=${p.pnlUsd.toFixed(2)} equity=${p.equityUsd.toFixed(2)} liq=${p.liquidationPrice?.toFixed(2) ?? "—"}`);
  for (const o of v.orders) console.log(`    ${o.marketName} pending ${o.kind} ${o.side} size=$${o.sizeUsd.toFixed(2)} escrow=${o.escrowedUsdc}`);
  return v;
}

async function main() {
  console.log(`e2e wallet: ${owner.toBase58()}  slot ${await getConnection().getSlot()}`);
  await step("markets", async () => {
    const v = await fetchPerpsView(null);
    for (const m of v.markets) console.log(`  ${m.name} leg=${m.leg} index=${m.indexPrice} fresh=${m.priceFresh} max=${m.maxLeverage}x trading=${m.tradingEnabled}`);
    assert(v.markets.length >= 3, "ETH, BTC and SOL listed");
  });
  await step("faucet + create margin + deposit 1000 USDC", async () => {
    for (const t of TOKENS) await fundOnFork(t.symbol, owner.toBase58());
    await createMarginAccount(opts);
    await depositAndBorrow({ deposits: [{ symbol: "USDC", amount: 1000 }] }, opts);
    await show("funded");
  });

  await step("open 3x ETH long with 200 USDC (first trade: setup + order + fill)", async () => {
    const r = await openPerp({ market: "ETH", side: "long", collateral: 200, leverage: 3 }, opts);
    console.log(`  ${r.summary} tx=${r.signature}`);
    const v = await show("ETH long");
    const pos = v.positions.find((p) => p.market === "ETH" && p.side === "long");
    assert(pos && Math.abs(pos.sizeUsd - 600) < 0.01, "ETH position size $600");
    assert(Math.abs(v.account.marginUsdc - 800) < 0.01, "200 USDC moved out of the margin");
    assert(v.account.venueValueUsd > 190, "the venue account counts toward holdings");
  });

  await step("borrow 300 USDC, then a 2x BTC short with 400 USDC", async () => {
    await depositAndBorrow({ borrows: [{ symbol: "USDC", amount: 300 }] }, opts);
    const r = await openPerp({ market: "BTC", side: "short", collateral: 400, leverage: 2 }, opts);
    console.log(`  ${r.summary} tx=${r.signature}`);
    const v = await show("ETH long + BTC short");
    const hf = v.account.totalCollateralUsd / v.account.totalDebtUsd;
    assert(v.account.healthFactor !== null && Math.abs(v.account.healthFactor - hf) < 0.01, `HF = holdings / debt (${v.account.healthFactor} vs ${hf})`);
  });

  await step("close the ETH long (fill + settle back to margin)", async () => {
    const before = (await fetchPerpsView(owner)).account.marginUsdc;
    const r = await closePerp({ market: "ETH", side: "long" }, opts);
    console.log(`  ${r.summary} settle=${r.signature}`);
    const v = await show("ETH closed");
    assert(!v.positions.some((p) => p.market === "ETH"), "ETH long gone");
    assert(v.account.marginUsdc > before + 150, `USDC back in margin (${before} → ${v.account.marginUsdc})`);
    assert(v.account.idleUsdc === 0, "nothing left idle in the venue account");
  });

  await step("open a SOL long and cancel it while pending", async () => {
    holdKeeper = true;
    await openPerp({ market: "SOL", side: "long", collateral: 50, leverage: 2 }, opts).catch((e) => console.log(`  (expected while held) ${describeError(e)}`));
    holdKeeper = false;
    let v = await show("SOL pending");
    assert(v.orders.some((o) => o.market === "SOL" && o.kind === "open"), "SOL order pending");
    const c = await cancelPerpOrder({ market: "SOL", side: "long" }, opts);
    console.log(`  ${c.summary} settle=${c.signature}`);
    v = await show("SOL cancelled");
    assert(!v.orders.some((o) => o.market === "SOL"), "SOL order gone");
  });

  await step("close the BTC short", async () => {
    const r = await closePerp({ market: "BTC", side: "short" }, opts);
    console.log(`  ${r.summary}`);
    const v = await show("all closed");
    assert(v.positions.length === 0 && v.orders.length === 0, "nothing open");
    const s = await fetchMarginSnapshot(owner);
    assert(!s.collateral.some((c) => c.symbol === "GMTrade"), "the GMTrade slot is freed");
  });

  await step("perps history (decoded from the venue account's transactions)", async () => {
    const rows = await fetchPerpsHistory(owner);
    for (const r of rows) console.log(`  ${r.action.padEnd(7)} ${r.market ?? "—"} ${r.side ?? ""} size=${r.sizeUsd ?? "—"} usdc=${r.usdc ?? "—"} ${r.signature.slice(0, 10)}…`);
    assert(rows.some((r) => r.action === "open" && r.market === "ETH" && r.side === "long" && r.sizeUsd === 600 && r.usdc === 200), "ETH open row");
    assert(rows.some((r) => r.action === "close" && r.market === "BTC"), "BTC close row");
    assert(rows.some((r) => r.action === "cancel" && r.market === "SOL"), "SOL cancel row");
    assert(rows.some((r) => r.action === "settle" && (r.usdc ?? 0) > 0), "settle row with USDC");
  });

  await step("history", async () => {
    const h = await fetchMarginHistory(owner);
    for (const row of h.rows) console.log(`  ${row.type.padEnd(12)} ${row.amount} ${row.symbol} ${row.signature.slice(0, 12)}…`);
    assert(h.rows.some((r) => r.type === "perp-open") && h.rows.some((r) => r.type === "perp-settle"), "perp rows decoded");
  });
  console.log("\n✔ e2e-perps passed");
}

main().catch(() => process.exit(1));
