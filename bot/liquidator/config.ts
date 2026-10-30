/** Bot settings, all from the environment (see bot/liquidator/README.md). */
const env = (name: string, fallback: string) => process.env[name]?.trim() || fallback;
const num = (name: string, fallback: number) => {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

export const config = {
  /** Sends nothing unless explicitly "false": a new deployment starts by only logging what it would do. */
  dryRun: env("DRY_RUN", "true") !== "false",
  pollMs: num("POLL_MS", 15_000),
  /** This bot's shard; every bot of a deployment uses the same count and a different index. */
  shardIndex: num("BOT_SHARD_INDEX", 0),
  shardCount: Math.max(1, num("BOT_SHARD_COUNT", 1)),
  /** Skip a liquidation whose gross profit (bonus) is below this, USD. */
  minProfitUsd: num("MIN_PROFIT_USD", 1),
  /** `min_seized` allowance under the quoted seize. */
  slippageBps: num("SLIPPAGE_BPS", 50),
  /** `min_seized` allowance when venue calls run first (a close realizes PnL at the fill price). */
  venueSlippageBps: num("VENUE_SLIPPAGE_BPS", 200),
  /** Partial liquidations repay at most 50% per call: try at most this many calls per account per loop. */
  maxRoundsPerAccount: num("MAX_ROUNDS_PER_ACCOUNT", 5),
  /** After a failed send, leave the account alone for this long. */
  failureCooldownMs: num("FAILURE_COOLDOWN_MS", 120_000),
  /** After a round that found nothing worth doing (below min profit, no strategy, dry run), re-plan the account after this long. */
  skipCooldownMs: num("SKIP_COOLDOWN_MS", 60_000),
  /** Telegram "loop failing" alert after this many failed loops in a row (one failure is usually a passing RPC hiccup). */
  loopFailuresToAlert: Math.max(1, num("LOOP_FAILURES_TO_ALERT", 3)),
  /** How long a full probe of an account's vaults is trusted. A vault the bot hasn't probed can only
   * add collateral (it can't hide a liquidatable account); new activity or a PositionHealthy answer
   * re-probes the account at once. */
  vaultProbeTtlMs: num("VAULT_PROBE_TTL_MS", 6 * 60 * 60_000),
  /** Fork only: rewrite the fork's price accounts before liquidating (the fork has no live pusher). */
  forkPriceRefresh: env("FORK_PRICE_REFRESH", "true") === "true",
  /** FORK ONLY: refill every borrowable token from the fork's cheatcodes when it runs low. Never on mainnet. */
  forkAutoFaucet: env("FORK_AUTO_FAUCET", "false") === "true",
  /** Refill a token whose balance falls under this many units… */
  forkFaucetMin: num("FORK_FAUCET_MIN", 100_000),
  /** …up to this many units. */
  forkFaucetTarget: num("FORK_FAUCET_TARGET", 1_000_000),
  /** Warn when the wallet holds less SOL than this (fees, rent for new token accounts). */
  minSolBalance: num("MIN_SOL_BALANCE", 0.05),
  /** Comma-separated strategy names to enable (default: all registered). */
  strategies: env("STRATEGIES", "").split(",").map((s) => s.trim()).filter(Boolean),
};

export type BotConfig = typeof config;
