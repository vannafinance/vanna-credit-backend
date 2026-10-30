/**
 * Vanna liquidator bot: finds margin accounts at or below the liquidation line (HF <= 1.10) and
 * liquidates them with `public_liquidate`, funded by the bot's own wallet (no pool).
 *
 *   npx tsx bot/liquidator/index.ts
 *
 * Each loop:
 *  1. discovery: the analytics registry finds margin accounts from the program's own transactions
 *     (incremental; `getProgramAccounts` is rate-limited on the fork);
 *  2. valuation: every account in this bot's shard is valued with the analytics math (the
 *     program's wad HF); liquidatable ones go lowest HF first, then largest debt;
 *  3. per account, per round: every enabled strategy proposes an action, the most profitable one
 *     above MIN_PROFIT_USD is simulated and sent, then the after-liquidation hooks run; repeat
 *     until the account is healthy (partial liquidations repay at most 50% per call).
 *
 * Extending: new kinds of liquidation are strategies (bot/liquidator/strategies), follow-up work
 * is hooks (bot/liquidator/hooks.ts). This loop does not change for either.
 */
import type { Keypair } from "@solana/web3.js";
import { coverage, knownMargins, lastActivityTime, tick } from "@/lib/analytics/server/registry";
import { forgetVaults, loadSharedContext, readAccountRows, setVaultProbeTtl } from "@/lib/analytics/server/accounts";
import { refreshForkPrices } from "@/lib/solana/server/fork-prices";
import { SOLANA_RPC_URL } from "@/lib/solana/config";
import { describeError } from "@/lib/solana/errors";
import { findToken, tokenByMint } from "@/lib/solana/tokens";
import { fromRaw } from "@/lib/solana/math";
import { setPriceRefresher } from "@/lib/solana/price-refresh";
import { config } from "./config";
import * as alerts from "./alerts";
import { HOOKS } from "./hooks";
import { log } from "./log";
import { telegramEnabled } from "./notify";
import { shardOf } from "./shard";
import { lastTelegramPoll, superviseCommands } from "./commands";
import { topUpOnFork } from "./fork-faucet";
import { liquidateAccount } from "./engine";
import { dueMargins, markDue, prune, record, trackedRows } from "./scheduler";
import { setSnapshot } from "./state";
import { enabledStrategies, type LiquidationStrategy } from "./strategies";
import { loadKeypair, readWallet } from "./wallet";

const cooldownUntil = new Map<string, number>();
/** Newest program-transaction time already acted on, per margin. */
const seenActivity = new Map<string, number>();
let stopping = false;

async function loop(keypair: Keypair, strategies: LiquidationStrategy[]) {
  const started = Date.now();
  await tick();
  const shared = await loadSharedContext();
  if (config.forkAutoFaucet) {
    const borrowable = [...shared.assets.values()].filter((a) => a.kind === "token" && a.borrowEnabled);
    await topUpOnFork(keypair.publicKey, borrowable, await readWallet(keypair.publicKey), config.forkFaucetMin, config.forkFaucetTarget).catch((error) =>
      log("ERROR", "fork faucet failed", { error: describeError(error).slice(0, 300) }),
    );
  }
  const mine = knownMargins().filter((m) => shardOf(m.address, config.shardCount) === config.shardIndex);
  // Only accounts that are due are read from chain (scheduler.ts); the rest are re-valued in memory.
  prune(new Set(mine.map((m) => m.address)));
  // An account with a new program transaction (a deposit, swap, borrow…) may hold a token we
  // haven't probed: probe all its vaults on this read.
  for (const m of mine) {
    const at = lastActivityTime(m.address);
    if (at === null || at <= (seenActivity.get(m.address) ?? 0)) continue;
    if (seenActivity.has(m.address)) {
      forgetVaults(m.address);
      markDue(m.address);
    }
    seenActivity.set(m.address, at);
  }
  const due = dueMargins(mine, shared);
  const rows = await readAccountRows(shared, due);
  record(rows, shared);
  const now = Date.now();
  const liquidatable = rows
    .filter((r) => r.liquidatable && (cooldownUntil.get(r.address) ?? 0) <= now)
    .sort((a, b) => (a.healthFactor ?? 0) - (b.healthFactor ?? 0) || (b.debtUsd ?? 0) - (a.debtUsd ?? 0));

  for (const row of liquidatable) {
    if (stopping) break;
    try {
      const results = await liquidateAccount(row, keypair, strategies, config, () => stopping);
      // Nothing worth doing (dust below MIN_PROFIT_USD, no strategy, or a dry run): don't re-plan it every loop.
      const last = results[results.length - 1]?.outcome;
      if (last && last !== "liquidated" && last !== "healthy") cooldownUntil.set(row.address, Date.now() + config.skipCooldownMs);
    } catch (error) {
      if (/PositionHealthy|healthy and is not eligible/i.test(describeError(error))) {
        // The program sees collateral we don't (a vault we haven't probed): not a failure. Probe all
        // of the account's vaults on the next read.
        forgetVaults(row.address);
        markDue(row.address);
        cooldownUntil.set(row.address, Date.now() + config.skipCooldownMs);
        log("INFO", "program says healthy, re-probing the account's vaults", { margin: row.address });
        continue;
      }
      cooldownUntil.set(row.address, Date.now() + config.failureCooldownMs);
      log("ERROR", "liquidation failed", { margin: row.address, error: describeError(error).slice(0, 500) });
      void alerts.liquidationFailed(row.address, describeError(error));
    }
  }

  const wallet = await readWallet(keypair.publicKey);
  if (wallet.sol < config.minSolBalance) log("WARNING", "liquidator SOL balance low", { sol: wallet.sol });
  // Every token users can borrow is a token the bot may have to repay: hold some of each.
  const borrowable = [...shared.assets.values()].filter((a) => a.kind === "token" && a.borrowEnabled);
  const empty = borrowable.filter((a) => wallet.balance(a.mint) === 0n).map((a) => tokenByMint(a.mint)?.symbol ?? a.mint.toBase58());
  if (empty.length) log("WARNING", "wallet holds none of some borrowable tokens: their debts cannot be repaid", { tokens: empty });
  if (wallet.sol < config.minSolBalance || empty.length) void alerts.walletLow(wallet.sol < config.minSolBalance ? wallet.sol : null, empty);
  const held = Object.fromEntries(
    Object.entries(wallet.bySymbol)
      .filter(([, v]) => v > 0n)
      .map(([symbol, v]) => [symbol, fromRaw(v, findToken(symbol)?.decimals ?? 0)]),
  );
  void alerts.dailySummary({ known: knownMargins().length, liquidatable: liquidatable.length, wallet: held });
  setSnapshot({ at: Date.now(), rows: trackedRows(), coverage: coverage(), wallet: held, liquidator: keypair.publicKey.toBase58(), dryRun: config.dryRun });
  log("INFO", "heartbeat", {
    known: knownMargins().length,
    shard: `${config.shardIndex}/${config.shardCount}`,
    inShard: mine.length,
    readThisLoop: due.length,
    telegramPollSecondsAgo: telegramEnabled && lastTelegramPoll() ? Math.round((Date.now() - lastTelegramPoll()) / 1000) : null,
    liquidatable: liquidatable.length,
    coverage: coverage(),
    wallet: held,
    ms: Date.now() - started,
  });
}

async function main() {
  const keypair = loadKeypair();
  const strategies = enabledStrategies(config.strategies);
  if (config.forkPriceRefresh) setPriceRefresher(() => refreshForkPrices());
  setVaultProbeTtl(config.vaultProbeTtlMs);
  log("INFO", "liquidator starting", {
    ...config,
    liquidator: keypair.publicKey.toBase58(),
    rpc: new URL(SOLANA_RPC_URL).host,
    strategies: strategies.map((s) => s.name),
    hooks: HOOKS.map((h) => h.name),
    telegram: telegramEnabled,
  });
  void alerts.online({
    liquidator: keypair.publicKey.toBase58(),
    dryRun: config.dryRun,
    strategies: strategies.map((s) => s.name),
    shard: `${config.shardIndex}/${config.shardCount}`,
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log("INFO", `received ${signal}, stopping after this account`);
      if (!stopping) void alerts.stopping(signal);
      stopping = true;
    });
  }
  // Read-only Telegram commands, answered from the last loop's snapshot. One poller per bot token.
  if (telegramEnabled && config.shardIndex === 0) {
    superviseCommands(() => stopping);
  }
  // One failed loop is usually the fork's RPC failing a read for a moment (it fetches unknown
  // accounts from mainnet and can be rate-limited); the next loop recovers. Alert only when the
  // loop keeps failing.
  let failedInARow = 0;
  while (!stopping) {
    try {
      await loop(keypair, strategies);
      if (failedInARow >= config.loopFailuresToAlert) void alerts.loopRecovered(failedInARow);
      failedInARow = 0;
    } catch (error) {
      failedInARow++;
      log(failedInARow >= config.loopFailuresToAlert ? "ERROR" : "WARNING", "loop failed", { inARow: failedInARow, error: describeError(error).slice(0, 500) });
      if (failedInARow === config.loopFailuresToAlert) void alerts.loopFailed(describeError(error), failedInARow);
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
  log("INFO", "liquidator stopped");
}

main().catch((error) => {
  log("ERROR", "fatal", { error: describeError(error) });
  process.exit(1);
});
