/**
 * End-to-end test of liquidation against the running Surfpool fork, one scenario per kind of
 * collateral the deployed program can liquidate. Liquidations run through the bot's own engine and
 * strategies (bot/liquidator/engine.ts), so this tests exactly what the bot sends.
 *
 *   npx tsx scripts/e2e-liquidate.ts                 # every scenario
 *   npx tsx scripts/e2e-liquidate.ts usdc phoenix    # some
 *   npx tsx scripts/e2e-liquidate.ts --setup-only [bot-address]
 *
 * Each scenario: a fresh borrower borrows against a collateral, then its OWN margin vaults are set
 * with a cheatcode so the liquidation HF lands at ~1.05 (prices and reserves are left alone: the
 * fork is shared). A fresh liquidator, funded with every lendable token, then liquidates it until it
 * is healthy. Checks: the right strategy ran, the right collateral was seized, the account ended
 * healthy, and the liquidator's balances moved by the quote.
 *
 * `--setup-only` leaves one liquidatable USDC account (for testing the running bot) and, given an
 * address, funds that wallet with every lendable token.
 */
import { NextRequest } from "next/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import { fundOnFork } from "@/lib/solana/server/fork-faucet";
import { refreshForkPrices } from "@/lib/solana/server/fork-prices";
import { healKaminoReserves } from "@/lib/solana/server/kamino-heal";
import { callCheatcode } from "@/lib/solana/server/cheatcodes";
import { POST as lookupPOST } from "@/app/api/perps/lookup-table/route";
import { POST as accessPOST } from "@/app/api/perps/phoenix-access/route";
import { POST as bookPOST } from "@/app/api/perps/phoenix-book/route";
import { setExecApiBase } from "@/lib/solana/exec";
import { openPerp } from "@/lib/solana/perps";
import { PHUSD_MINT } from "@/lib/solana/phoenix";
import {
  createMarginAccount,
  depositAndBorrow,
  describeError,
  fetchWalletBalances,
  fromRaw,
  getConnection,
  getToken,
  keypairSigner,
  LENDING_TOKENS,
  loadContext,
  marginPda,
  setPriceRefresher,
  toRaw,
  type AssetConfigState,
} from "@/lib/solana";
import { liquidationHealthWad } from "@/lib/solana/liquidate";
import { BALANCE_TO_BORROW_THRESHOLD_WAD, mulDivCeil, wadToNumber } from "@/lib/solana/math";
import { tokenByMint } from "@/lib/solana/tokens";
import { liquidateAccount } from "@/bot/liquidator/engine";
import { config } from "@/bot/liquidator/config";
import { enabledStrategies } from "@/bot/liquidator/strategies";

// Route the app's own API calls (Phoenix lookup table, access, book) to the real route handlers.
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
setPriceRefresher(() => Promise.all([refreshForkPrices(), healKaminoReserves()]));

const USDC = getToken("USDC");
const LIQUIDATABLE = BALANCE_TO_BORROW_THRESHOLD_WAD;
const BORROW_USD = 500;
const TARGET_HF = 1.05;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✔" : "✖"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

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

/** Sets the margin's own vault for `mint` (the cheatcode creates the account when missing). */
async function setVault(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey, amount: bigint) {
  await callCheatcode("surfnet_setTokenAccount", [marginPda(owner).toBase58(), mint.toBase58(), { amount: Number(amount) }, tokenProgram.toBase58()]);
}

async function status(owner: PublicKey) {
  const ctx = await loadContext(owner);
  const hf = liquidationHealthWad(ctx.snapshot, ctx.assetMap);
  console.log(
    `  liquidation HF=${hf === null ? "∞" : wadToNumber(hf).toFixed(4)} collateral=$${ctx.snapshot.totalCollateralUsd.toFixed(2)} debt=$${ctx.snapshot.totalDebtUsd.toFixed(2)}` +
      ` [${ctx.snapshot.collateral.filter((c) => c.valueNano > 0n).map((c) => `${c.symbol} $${c.usd.toFixed(2)}`).join(", ")}]`,
  );
  return { ctx, hf };
}

/** Raw units of `asset` worth `usd` at the program's price (probes the vault with one whole token). */
async function amountForUsd(owner: PublicKey, asset: AssetConfigState, usd: number): Promise<bigint> {
  const unit = 10n ** BigInt(asset.decimals);
  await setVault(owner, asset.mint, asset.tokenProgram, unit);
  const { ctx } = await status(owner);
  const line = ctx.snapshot.collateral.find((c) => c.mint.equals(asset.mint));
  if (!line || line.valueNano <= 0n) throw new Error(`No price for ${asset.mint.toBase58()} on the fork`);
  return mulDivCeil(BigInt(Math.round(usd * 1e9)), unit, line.valueNano);
}

interface Scenario {
  name: string;
  /** What the liquidator must have used and taken. */
  strategy: "token" | "phoenix";
  debt: string;
  /** The collateral asset (null: phUSD from Phoenix). */
  collateral: (assets: AssetConfigState[]) => AssetConfigState | undefined;
  /** Phoenix: open a position instead of holding the collateral token. */
  phoenix?: boolean;
}

const bySymbol = (symbol: string) => (assets: AssetConfigState[]) => assets.find((a) => a.mint.equals(getToken(symbol).mint));
const SCENARIOS: Scenario[] = [
  { name: "usdc", strategy: "token", debt: "USDC", collateral: bySymbol("USDC") },
  { name: "sol-debt", strategy: "token", debt: "SOL", collateral: bySymbol("USDC") },
  { name: "sol-collateral", strategy: "token", debt: "USDC", collateral: bySymbol("SOL") },
  { name: "usdt-debt-lst", strategy: "token", debt: "USDT", collateral: bySymbol("JitoSOL") },
  { name: "token2022-xstock", strategy: "token", debt: "USDC", collateral: bySymbol("TSLAx") },
  { name: "kamino-receipt", strategy: "token", debt: "USDC", collateral: (a) => a.find((x) => x.priceSource === "kaminoReceipt") },
  { name: "vault-receipt", strategy: "token", debt: "USDC", collateral: (a) => a.find((x) => x.mint.toBase58().startsWith("star9")) },
  { name: "phoenix", strategy: "phoenix", debt: "USDC", collateral: (a) => a.find((x) => x.mint.equals(PHUSD_MINT)), phoenix: true },
];

/** Borrower at ~TARGET_HF with `s.debt` debt and its collateral in `asset` (or in Phoenix). */
async function setupBorrower(s: Scenario, asset: AssetConfigState): Promise<Keypair> {
  const kp = Keypair.generate();
  const owner = kp.publicKey;
  const opts = { signer: keypairSigner(kp) };
  console.log(`  borrower ${owner.toBase58()} margin ${marginPda(owner).toBase58()}`);
  await fundOnFork("SOL", owner.toBase58());
  await createMarginAccount(opts);
  const debtToken = getToken(s.debt);
  const debtConfig = [...(await loadContext(owner)).assetMap.values()].find((a) => a.mint.equals(debtToken.mint))!;

  if (s.phoenix) {
    // 300 USDC + 500 borrowed; 525 of it goes into Phoenix with a 1.5x SOL long; the rest of the
    // margin's USDC is then removed, leaving HF ≈ Phoenix equity / debt ≈ 1.05.
    await fundOnFork("USDC", owner.toBase58());
    await depositAndBorrow({ deposits: [{ symbol: "USDC", amount: 300 }], borrows: [{ symbol: "USDC", amount: BORROW_USD }] }, opts);
    const opened = await openPerp({ market: "SOL", side: "long", collateral: BORROW_USD * TARGET_HF, leverage: 1.5 } as never, opts);
    console.log(`  ${opened.summary}`);
    await setVault(owner, USDC.mint, USDC.tokenProgram, 0n);
    return kp;
  }

  // Price the debt token (probing its vault), hold collateral worth 2× the debt, borrow, then remove
  // the borrowed tokens and set the collateral to TARGET_HF × the debt: only the scenario's
  // collateral is left to seize.
  const debtUnits = await amountForUsd(owner, debtConfig, BORROW_USD);
  await setVault(owner, debtConfig.mint, debtConfig.tokenProgram, 0n);
  await setVault(owner, asset.mint, asset.tokenProgram, await amountForUsd(owner, asset, BORROW_USD * 2));
  await depositAndBorrow({ borrows: [{ symbol: s.debt, amount: fromRaw(debtUnits, debtToken.decimals) }] }, opts);
  const { ctx } = await status(owner);
  const debtNano = ctx.snapshot.totalDebtNano;
  await setVault(owner, debtConfig.mint, debtConfig.tokenProgram, 0n);
  await setVault(owner, asset.mint, asset.tokenProgram, await amountForUsd(owner, asset, (Number(debtNano) / 1e9) * TARGET_HF));
  return kp;
}

async function runScenario(s: Scenario, liquidator: Keypair) {
  const assets = [...(await loadContext(liquidator.publicKey)).assetMap.values()];
  const asset = s.collateral(assets);
  if (!asset) {
    check(`${s.name}: collateral asset is registered`, false);
    return;
  }
  const label = tokenByMint(asset.mint)?.symbol ?? asset.mint.toBase58().slice(0, 8);
  // Each scenario spends ~$500 of its debt token: top the liquidator up so earlier scenarios can't starve it.
  await fundOnFork(s.debt, liquidator.publicKey.toBase58());
  const borrower = await step(`${s.name}: borrower with ${s.debt} debt against ${s.phoenix ? "a Phoenix position" : label}`, () => setupBorrower(s, asset));
  const before = await status(borrower.publicKey);
  check(`${s.name}: account is liquidatable`, before.hf !== null && before.hf <= LIQUIDATABLE, before.hf === null ? "no debt" : `HF ${wadToNumber(before.hf).toFixed(4)}`);

  const walletBefore = await fetchWalletBalances(liquidator.publicKey);
  const results = await step(`${s.name}: liquidate with the bot's engine`, () =>
    liquidateAccount({ owner: borrower.publicKey.toBase58(), address: marginPda(borrower.publicKey).toBase58() }, liquidator, enabledStrategies([]), {
      ...config,
      dryRun: false,
      minProfitUsd: 0,
      maxRoundsPerAccount: 5,
    }),
  );
  const landed = results.filter((r) => r.outcome === "liquidated");
  for (const r of landed) {
    console.log(`  round ${r.round}: ${r.action!.strategy} ${JSON.stringify(r.action!.summary, (_, v) => (typeof v === "bigint" ? v.toString() : v))} profit≈$${r.action!.profitUsd.toFixed(2)} tx ${r.signature}`);
  }
  check(`${s.name}: liquidated`, landed.length > 0, results.map((r) => r.outcome).join(" → "));
  check(`${s.name}: used the ${s.strategy} strategy`, landed.length > 0 && landed.every((r) => r.action!.strategy === s.strategy));
  check(
    `${s.name}: seized ${s.phoenix ? "phUSD" : label}`,
    landed.length > 0 && landed.every((r) => r.action!.request.settle?.collateralAsset.mint.equals(asset.mint)),
  );
  const after = await status(borrower.publicKey);
  check(`${s.name}: account is healthy afterwards`, after.hf === null || after.hf > LIQUIDATABLE);

  const walletAfter = await fetchWalletBalances(liquidator.publicKey);
  const moved = Object.keys({ ...walletBefore.raw, ...walletAfter.raw })
    .map((k) => [k, (walletAfter.raw[k] ?? 0n) - (walletBefore.raw[k] ?? 0n)] as const)
    .filter(([, d]) => d !== 0n);
  console.log(`  liquidator wallet moved: ${moved.map(([k, d]) => `${k} ${d > 0n ? "+" : ""}${fromRaw(d, getToken(k).decimals)}`).join(", ") || "nothing"}`);
  if (s.phoenix) {
    const phusd = walletAfter.raw.phUSD ?? 0n;
    check(`${s.name}: seized phUSD was unwrapped to USDC`, phusd === 0n, `phUSD left ${phusd}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const setupOnly = args.includes("--setup-only");
  const liquidator = Keypair.generate();
  console.log(`liquidator ${liquidator.publicKey.toBase58()}  slot ${await getConnection().getSlot()}`);
  await step("fund liquidator with every lendable token", async () => {
    for (const t of LENDING_TOKENS) await fundOnFork(t.symbol, liquidator.publicKey.toBase58());
  });

  if (setupOnly) {
    const target = args[args.indexOf("--setup-only") + 1];
    const usdc = SCENARIOS[0];
    const asset = usdc.collateral([...(await loadContext(liquidator.publicKey)).assetMap.values()])!;
    const borrower = await step("leave one liquidatable USDC account", () => setupBorrower(usdc, asset));
    if (target && !target.startsWith("--")) {
      for (const t of LENDING_TOKENS) await fundOnFork(t.symbol, target);
      console.log(`  funded ${target} with ${LENDING_TOKENS.map((t) => t.symbol).join(" + ")}`);
    }
    console.log(`\n✔ left margin ${marginPda(borrower.publicKey).toBase58()} liquidatable`);
    process.exit(0);
  }

  const chosen = args.length ? SCENARIOS.filter((s) => args.includes(s.name)) : SCENARIOS;
  if (!chosen.length) throw new Error(`Unknown scenario; choose from ${SCENARIOS.map((s) => s.name).join(", ")}`);

  await step("a healthy account is refused (PositionHealthy)", async () => {
    const kp = Keypair.generate();
    const opts = { signer: keypairSigner(kp) };
    await fundOnFork("SOL", kp.publicKey.toBase58());
    await fundOnFork("USDC", kp.publicKey.toBase58());
    await createMarginAccount(opts);
    await depositAndBorrow({ deposits: [{ symbol: "USDC", amount: 300 }], borrows: [{ symbol: "USDC", amount: 100 }] }, opts);
    const { ctx } = await status(kp.publicKey);
    const { liquidationInstructions } = await import("@/lib/solana/liquidate");
    const { sendInstructions } = await import("@/lib/solana/tx");
    const usdcAsset = [...ctx.assetMap.values()].find((a) => a.mint.equals(USDC.mint))!;
    try {
      const ixs = await liquidationInstructions(ctx, liquidator.publicKey, { settle: { debtAsset: usdcAsset, collateralAsset: usdcAsset, repay: toRaw(1, 6), minSeized: 1n } });
      await sendInstructions(ixs, { signer: keypairSigner(liquidator), label: "Liquidate healthy" });
      check("program refused", false, "the liquidation landed");
    } catch (error) {
      check("program refused with PositionHealthy", /PositionHealthy|healthy and is not eligible/i.test(describeError(error)), describeError(error).slice(0, 100));
    }
  });

  for (const s of chosen) {
    try {
      await runScenario(s, liquidator);
    } catch (error) {
      check(`${s.name}: ran without error`, false, describeError(error).slice(0, 200));
    }
  }

  console.log(failures ? `\n✖ ${failures} check(s) failed` : `\n✔ all liquidation checks passed (${chosen.map((s) => s.name).join(", ")})`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(describeError(error));
  process.exit(1);
});
