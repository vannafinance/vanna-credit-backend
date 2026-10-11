/**
 * Predict end-to-end on the HOSTED fork, through the app's own API routes (start a dev server
 * first: `npx next dev -p 3100`). Fresh ephemeral wallet, no fork reset, no existing user funds.
 *
 *   1. faucet CASH (+ USDC) to a fresh keypair
 *   2. buy YES on an allowlisted market → auto-deposited into outcome_yield_pool
 *   3. buy NO on the same market → keeper merge → pool USDC lent into Vanna's USDC reserve
 *   4. multi-leg buy across 2 outcomes of one event with ONE signAllTransactions
 *   5. sell the pooled YES back (redeem + sell to the maker)
 *   5b. LARGE pooled position (E2E_PREDICT_LARGE CASH per side, default 400; 0 skips): buy YES + NO
 *       (merged and lent), then sell ALL of the pooled side whose redeem needs the larger route
 *       (normally YES on a fresh pool). The redeem's USDC → CASH route is hundreds of
 *       USDC, so interest accrued between the server's read and the transaction landing must be
 *       covered (regression: SwapAmountMismatch 6020 when the route was sized exactly at the read).
 *   6. (optional, E2E_PREDICT_USDC=1) buy paying with USDC (USDC → CASH via Jupiter/Manifest)
 *
 * Usage: npx tsx scripts/e2e-predict.ts [marketId]   (PREDICT_API=http://localhost:3100)
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

const API = process.env.PREDICT_API ?? "http://localhost:3100";

async function main() {
  const { Keypair } = await import("@solana/web3.js");
  const { keypairSigner } = await import("../lib/solana/tx");
  const { fetchPoolStates } = await import("../lib/solana/protocol-state");
  const client = await import("../lib/predict/client");
  type PredictEvent = import("../lib/predict/types").PredictEvent;
  type PredictOutcome = import("../lib/predict/types").PredictOutcome;
  client.setPredictApiBase(API);

  const kp = Keypair.generate();
  const base = keypairSigner(kp);
  let signAllCalls = 0;
  const signer = { ...base, signAllTransactions: async <T extends Parameters<typeof base.signAllTransactions>[0][number]>(txs: T[]) => (signAllCalls++, base.signAllTransactions(txs)) };
  const owner = kp.publicKey.toBase58();
  const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const check = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
    log("  ✓", msg);
  };
  const trade = async (label: string, legs: import("../lib/predict/types").TradeLegRequest[], pay?: "CASH" | "USDC") => {
    const before = signAllCalls;
    const r = await client.executePredictTrade({ owner, legs, pay }, signer, (p) => log(`  [${label}]`, p.step));
    log(`  ${label}: ${r.signatures.length} tx`, r.signatures, "merges", JSON.stringify(r.merges));
    check(signAllCalls - before === 1, `${label}: one signAllTransactions for ${r.built.transactions.length} transaction(s)`);
    return r;
  };

  log("Test wallet", owner);
  const f = await client.requestPredictFaucet(owner, 500, true);
  log("Faucet", f);

  // ---- pick markets ---------------------------------------------------------------------------
  log("Loading events (first call scans mainnet)…");
  const { events } = await client.fetchPredictEvents();
  log(`${events.length} events`);
  const allowed = (e: PredictEvent) => e.outs.filter((o) => o.poolDetail.allowlisted && !o.grp);
  const priced = (o: PredictOutcome) => o.tradable && o.y !== null && o.n !== null && o.y > 3 && o.y < 97;
  const wanted = process.argv[2];
  let event: PredictEvent | null = null;
  let pair: PredictOutcome[] = [];
  const candidates = wanted ? [events.find((e) => e.outs.some((o) => o.marketId === wanted)) ?? (await client.fetchPredictEvent(wanted))] : events.filter((e) => allowed(e).length >= 2 && e.type !== "updown").slice(0, 25);
  for (const c of candidates) {
    if (!c) continue;
    const fresh = await client.fetchPredictEvent(c.id); // scans each unpriced market's own trades
    const ok = allowed(fresh).filter(priced);
    log(`  candidate ${fresh.title}: ${ok.length}/${allowed(fresh).length} allowlisted outcomes priced`);
    if (ok.length >= 2 || (wanted && ok.length >= 1)) {
      event = fresh;
      pair = wanted ? [ok.find((o) => o.marketId === wanted) ?? ok[0], ...ok.filter((o) => o.marketId !== wanted)] : ok;
      break;
    }
  }
  if (!event || !pair.length) throw new Error("No allowlisted, priced event found (prices fill in as the mainnet scan runs; retry in a minute)");
  const m = pair[0];
  log(`Event "${event.title}" [${event.groupedBy}/${event.type}]; market ${m.marketId} "${m.name}" YES ${m.y}¢ / NO ${m.n}¢`);

  const poolOf = async (id: string) => (await client.fetchPredictEvent(id)).outs.find((o) => o.marketId === id)!.poolDetail;
  const usdcSupplied = async () => (await fetchPoolStates()).USDC?.totalSupplied ?? 0;
  const positions = () => client.fetchPredictPositions(owner);

  // ---- 2. buy YES → pool ----------------------------------------------------------------------
  const pool0 = await poolOf(m.marketId);
  log("Pool before", pool0);
  const buyYes = await trade("buy YES", [{ marketId: m.marketId, outcome: "yes", side: "buy", amount: 10 }]);
  const qYes = buyYes.built.quotes[0];
  check(qYes.pooled > 0 && qYes.pooled === qYes.amountOut, `buy YES auto-deposited ${qYes.pooled} YES into the pool`);
  let pos = await positions();
  const pYes = pos.positions.find((p) => p.marketId === m.marketId && p.side === "yes");
  check(pYes && pYes.poolShares > 0 && pYes.src === "vanna", `position shows ${pYes?.poolShares} pool shares (value ${pYes?.poolValueShares} YES)`);

  // ---- 3. buy NO → merge → Vanna USDC ----------------------------------------------------------
  const supplied0 = await usdcSupplied();
  const buyNo = await trade("buy NO", [{ marketId: m.marketId, outcome: "no", side: "buy", amount: 10 }]);
  const merged = buyNo.merges.find((r) => r.marketId === m.marketId);
  check(merged?.signature, `keeper merged ${merged?.merged} pairs: ${merged?.signature ?? merged?.error ?? merged?.skipped}`);
  const pool1 = await poolOf(m.marketId);
  const supplied1 = await usdcSupplied();
  log("Pool after merge", pool1, "USDC reserve supplied", supplied0, "→", supplied1);
  check(pool1.invested > pool0.invested, `pool invested USDC ${pool0.invested} → ${pool1.invested}`);
  check(supplied1 > supplied0, `Vanna USDC reserve supplied ${supplied0} → ${supplied1}`);

  // ---- 4. multi-leg across 2 outcomes of one event --------------------------------------------
  if (pair.length >= 2) {
    const legs = pair.slice(0, 2).map((o) => ({ marketId: o.marketId, outcome: "yes" as const, side: "buy" as const, amount: 5 }));
    const multi = await trade("multi-leg", legs);
    check(multi.built.quotes.length === 2 && multi.signatures.length === multi.built.transactions.length, `2 legs in ${multi.built.transactions.length} transaction(s), all confirmed`);
  } else log("  (event has one priced allowlisted outcome; multi-leg skipped)");

  // ---- 5. sell pooled YES back ----------------------------------------------------------------
  pos = await positions();
  const held = pos.positions.find((p) => p.marketId === m.marketId && p.side === "yes")!;
  log("YES position before sell", { shares: held.shares, wallet: held.walletShares, pool: held.poolShares, poolValue: held.poolValueShares });
  const cash0 = pos.wallet.cash;
  const sellAmt = Math.floor(held.shares * 1e6 * 0.98) / 1e6;
  const sell = await trade("sell YES", [{ marketId: m.marketId, outcome: "yes", side: "sell", amount: sellAmt }]);
  const qs = sell.built.quotes[0];
  check(qs.redeemedShares > 0, `sell redeemed ${qs.redeemedShares} pool shares first`);
  pos = await positions();
  const after = pos.positions.find((p) => p.marketId === m.marketId && p.side === "yes");
  check(pos.wallet.cash > cash0, `CASH ${cash0} → ${pos.wallet.cash} (+${qs.amountOut})`);
  check(!after || after.poolShares < held.poolShares, `pool shares ${held.poolShares} → ${after?.poolShares ?? 0}`);

  // ---- 5b. large pooled position: sell it all ---------------------------------------------------
  const large = Number(process.env.E2E_PREDICT_LARGE ?? 400);
  if (large > 0) {
    log("Faucet (large)", await client.requestPredictFaucet(owner, Math.min(1000, 2 * large + 50)));
    await trade("buy YES (large)", [{ marketId: m.marketId, outcome: "yes", side: "buy", amount: large }]);
    const bigNo = await trade("buy NO (large)", [{ marketId: m.marketId, outcome: "no", side: "buy", amount: large }]);
    const bigMerge = bigNo.merges.find((r) => r.marketId === m.marketId);
    check(bigMerge?.signature, `keeper merged ${bigMerge?.merged} pairs (large): ${bigMerge?.signature ?? bigMerge?.error ?? bigMerge?.skipped}`);
    pos = await positions();
    const poolBig = await poolOf(m.marketId);
    // Sell the side whose redeem needs the bigger USDC → CASH route (the other side's dangling tokens
    // may cover it outright on a pool that already holds a lot of them).
    const routeOf = (side: "yes" | "no") => {
      const p = pos.positions.find((x) => x.marketId === m.marketId && x.side === side);
      return p ? p.poolValueShares - (side === "yes" ? poolBig.yesDangling : poolBig.noDangling) : -Infinity;
    };
    const bigSide = routeOf("yes") >= routeOf("no") ? "yes" : "no";
    const BIG = bigSide.toUpperCase();
    const big = pos.positions.find((p) => p.marketId === m.marketId && p.side === bigSide)!;
    log(`Large ${BIG} position`, { shares: big.shares, wallet: big.walletShares, pool: big.poolShares, poolValue: big.poolValueShares }, "pool", poolBig);
    const route = routeOf(bigSide);
    if (route > 100) log(`  redeeming it needs a ${route.toFixed(2)} USDC → CASH route`);
    else log(`  ⚠ the pool's dangling ${BIG} cover most of it (route ${route.toFixed(2)}): pass a market id with fewer dangling tokens to exercise a large route`);
    const cashBig = pos.wallet.cash;
    const sellAll = await trade(`sell ALL ${BIG} (large)`, [{ marketId: m.marketId, outcome: bigSide, side: "sell", amount: Math.floor(big.shares * 1e6) / 1e6 }]);
    const qa = sellAll.built.quotes[0];
    pos = await positions();
    const left = pos.positions.find((p) => p.marketId === m.marketId && p.side === bigSide);
    check(qa.redeemedShares > 0 && pos.wallet.cash > cashBig, `sold ${qa.amountIn} ${BIG} for ${qa.amountOut} CASH after redeeming ${qa.redeemedShares} pool shares`);
    // A route returning above par (Manifest often does) becomes extra pairs for both sides; a side's last
    // holder keeps that surplus on its dust shares, so allow a sliver rather than exactly zero.
    check(!left || left.poolValueShares < big.poolValueShares * 0.005, `pooled ${BIG} left: ${left?.poolValueShares ?? 0} of ${big.poolValueShares}`);
  }

  // ---- 6. pay with USDC ------------------------------------------------------------------------
  if (process.env.E2E_PREDICT_USDC !== "0") {
    try {
      const usdcBuy = await trade("buy with USDC", [{ marketId: m.marketId, outcome: "no", side: "buy", amount: 5 }], "USDC");
      check(usdcBuy.built.swap && usdcBuy.built.swap.cashOutMin > 0, `USDC → CASH swap (min ${usdcBuy.built.swap?.cashOutMin} CASH) then buy`);
    } catch (error) {
      log("  ✗ pay with USDC failed (fork Manifest state?):", error instanceof Error ? error.message.split("\n")[0] : error);
      if (process.env.E2E_PREDICT_USDC === "1") throw error;
    }
  }

  const activity = await client.fetchPredictActivity(owner);
  log(`Activity: ${activity.length} trades`, activity.map((t) => `${t.side} ${t.shares.toFixed(2)} ${t.outcome} @${t.price.toFixed(3)}${t.pooled ? ` pooled ${t.pooled.toFixed(2)}` : ""}`));
  check(activity.length >= 3, "activity reconstructed from chain");
  pos = await positions();
  log("Summary", pos.summary, "Vault", pos.vault);
  log("E2E PASS");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
