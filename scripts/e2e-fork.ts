/**
 * End-to-end test of the app's OWN service layer (lib/solana/*) against the running Surfpool fork,
 * with a fresh Keypair standing in for the browser wallet.
 *
 *   npx tsx scripts/e2e-fork.ts
 *
 * Flow: faucet 1000 of each token → supply all 5 assets to Earn → redeem part → create margin →
 * deposit USDC → borrow SOL (cross-asset) → deposit JitoSOL (collateral-only; borrowing it must be
 * refused) → dual borrow USDT + USDC → repay USDT fully (repay_all, from wallet) → partial repay USDC
 * from margin → withdraw part of the USDC collateral. Earn = the lendable pools (SOL, USDC, USDT).
 */
import { Keypair } from "@solana/web3.js";
import { fundOnFork } from "@/lib/solana/server/fork-faucet";
import { refreshForkPrices } from "@/lib/solana/server/fork-prices";
import {
  TOKENS,
  keypairSigner,
  setPriceRefresher,
  supply,
  redeem,
  fetchLenderPositions,
  fetchPoolStates,
  createMarginAccount,
  depositAndBorrow,
  repay,
  withdrawCollateral,
  fetchMarginSnapshot,
  fetchEarnHistory,
  fetchMarginHistory,
  computeEarnedInterest,
  fetchWalletBalances,
  maxBorrowUsd,
  readOnchainPrices,
  getConnection,
  describeError,
} from "@/lib/solana";

const kp = Keypair.generate();
const signer = keypairSigner(kp);
const owner = kp.publicKey;
setPriceRefresher(() => refreshForkPrices());

const fmt = (n: number | null, d = 4) => (n === null ? "∞" : n.toFixed(d));

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    const out = await fn();
    return out;
  } catch (error) {
    console.error(`✖ ${name} FAILED: ${describeError(error)}`);
    const raw = (error as { raw?: string }).raw;
    if (raw) console.error(raw.split("\n").slice(-25).join("\n"));
    throw error;
  }
}

async function printMargin(label: string) {
  const s = await fetchMarginSnapshot(owner);
  console.log(`  [${label}] HF=${fmt(s.healthFactor)} collateral=$${s.totalCollateralUsd.toFixed(2)} debt=$${s.totalDebtUsd.toFixed(2)}`);
  for (const c of s.collateral) console.log(`    collateral ${c.symbol.padEnd(8)} ${c.amount.toFixed(6).padStart(16)}  $${c.usd.toFixed(2)}${c.active ? "" : " (inactive)"}`);
  for (const d of s.debts) console.log(`    debt       ${d.symbol.padEnd(8)} ${d.debt.toFixed(6).padStart(16)}  $${d.usd.toFixed(2)}  apr=${(d.borrowApr * 100).toFixed(3)}%`);
  console.log(`    slots col=${JSON.stringify(s.raw?.collateralAssetIndexes.filter((i) => i !== 65535))} debt=${JSON.stringify(s.raw?.debtAssetIndexes.filter((i) => i !== 65535))}`);
  return s;
}

async function main() {
  console.log(`e2e wallet: ${owner.toBase58()}`);
  console.log(`slot: ${await getConnection().getSlot()}`);

  await step("faucet 1000 of each token", async () => {
    for (const t of TOKENS) {
      const r = await fundOnFork(t.symbol, owner.toBase58());
      console.log(`  +${r.added} ${r.symbol} → balance ${r.balance}`);
    }
  });

  const prices = await step("refresh fork prices (price keeper)", async () => {
    const r = await refreshForkPrices();
    for (const p of r) console.log(`  ${p.symbol.padEnd(8)} $${p.usd.toFixed(4)} (${p.source}) → ${p.account}`);
    const onchain = await readOnchainPrices(getConnection());
    return Object.fromEntries(Object.entries(onchain).map(([k, v]) => [k, v?.usd ?? 0]));
  });

  const supplyAmounts: Record<string, number> = { SOL: 50, USDC: 500, USDT: 500 };
  await step("supply the Earn pools (SOL, USDC, USDT)", async () => {
    for (const t of TOKENS.filter((x) => x.lendable)) {
      const { signature } = await supply(t.symbol, supplyAmounts[t.symbol], { signer });
      console.log(`  supply ${supplyAmounts[t.symbol]} ${t.symbol}: ${signature}`);
    }
  });

  await step("redeem part (200 USDC worth + 10 SOL worth)", async () => {
    const a = await redeem("USDC", { assetsUi: 200 }, { signer });
    console.log(`  redeem USDC shares=${a.sharesRaw}: ${a.signature}`);
    const b = await redeem("SOL", { assetsUi: 10 }, { signer });
    console.log(`  redeem SOL shares=${b.sharesRaw}: ${b.signature}`);
    const pos = await fetchLenderPositions(owner);
    for (const p of Object.values(pos)) console.log(`  position ${p.symbol.padEnd(8)} shares=${p.shares} value=${p.assets}`);
    const pools = await fetchPoolStates();
    for (const p of Object.values(pools)) console.log(`  pool ${p.token.symbol.padEnd(8)} supplied=${p.totalSupplied} borrowed=${p.totalBorrowed} util=${(p.utilization * 100).toFixed(2)}% borrowApr=${(p.borrowApr * 100).toFixed(3)}% supplyApr=${(p.supplyApr * 100).toFixed(4)}%`);
  });

  await step("create margin account", async () => {
    const r = await createMarginAccount({ signer });
    console.log(`  margin ${r.address}: ${r.signature}`);
  });

  await step("deposit 500 USDC collateral", async () => {
    const r = await depositAndBorrow({ deposits: [{ symbol: "USDC", amount: 500 }] }, { signer });
    console.log(`  deposit: ${r.signature}`);
    await printMargin("after deposit");
  });

  await step("cross-asset borrow: SOL against USDC (~$300)", async () => {
    const solAmount = (300 / prices.SOL).toFixed(6);
    const r = await depositAndBorrow({ borrows: [{ symbol: "SOL", amount: solAmount }] }, { signer });
    console.log(`  borrow ${solAmount} SOL: ${r.signature}`);
    await printMargin("after SOL borrow");
  });

  await step("deposit JitoSOL as collateral; borrowing JitoSOL must be refused", async () => {
    const d = await depositAndBorrow({ deposits: [{ symbol: "JitoSOL", amount: 1 }] }, { signer });
    console.log(`  deposit 1 JitoSOL: ${d.signature}`);
    try {
      await depositAndBorrow({ borrows: [{ symbol: "JitoSOL", amount: 0.1 }] }, { signer });
      throw new Error("JitoSOL borrow unexpectedly succeeded");
    } catch (error) {
      const msg = describeError(error);
      if (!/collateral-only/.test(msg)) throw error;
      console.log(`  refused as expected: ${msg}`);
    }
  });

  await step("dual borrow USDT + USDC in one tx", async () => {
    const r = await depositAndBorrow({ borrows: [{ symbol: "USDT", amount: 100 }, { symbol: "USDC", amount: 100 }] }, { signer });
    console.log(`  borrow 100 USDT + 100 USDC: ${r.signature}`);
    const s = await printMargin("after dual borrow");
    console.log(`  UI max additional borrow (USD, HF>=1.15): $${maxBorrowUsd(s.totalCollateralUsd, s.totalDebtUsd).toFixed(2)}`);
  });

  await step("repay USDT fully (repay_all, from wallet) + close debt position", async () => {
    const r = await repay({ symbol: "USDT", all: true, source: "wallet" }, { signer });
    console.log(`  repay all USDT: ${r.signature}`);
    await printMargin("after USDT repay_all");
  });

  await step("partial repay USDC from margin vault", async () => {
    const s = await fetchMarginSnapshot(owner);
    const debt = s.debts.find((d) => d.symbol === "USDC")!;
    const half = (debt.debt / 2).toFixed(6);
    const r = await repay({ symbol: "USDC", amount: half, source: "margin" }, { signer });
    console.log(`  repay ${half} USDC from margin: ${r.signature}`);
    await printMargin("after partial USDC repay");
  });

  await step("withdraw 100 USDC collateral", async () => {
    const r = await withdrawCollateral({ symbol: "USDC", amount: 100 }, { signer });
    console.log(`  withdraw: ${r.signature}`);
    await printMargin("final");
  });

  await step("history (event-decoded)", async () => {
    const earn = await fetchEarnHistory(owner);
    console.log(`  earn rows=${earn.rows.length} complete=${earn.complete}`);
    for (const r of earn.rows) console.log(`    ${r.type.padEnd(8)} ${r.amount} ${r.symbol} ${r.signature.slice(0, 12)}…`);
    const positions = await fetchLenderPositions(owner);
    const earned = computeEarnedInterest(earn, positions);
    for (const e of Object.values(earned)) console.log(`    earned ${e.symbol.padEnd(8)} net=${e.netDeposited} earned=${e.earned}${e.reason ? ` (${e.reason})` : ""}`);
    const margin = await fetchMarginHistory(owner);
    console.log(`  margin rows=${margin.rows.length} complete=${margin.complete}`);
    for (const r of margin.rows) console.log(`    ${r.type.padEnd(12)} ${r.amount} ${r.symbol}${r.healthFactor !== undefined ? ` hf=${r.healthFactor}` : ""} ${r.signature.slice(0, 12)}…`);
    const w = await fetchWalletBalances(owner);
    console.log(`  wallet: ${Object.entries(w.ui).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  });

  console.log("\n✔ e2e complete");
}

main().catch(() => process.exit(1));
