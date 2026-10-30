/**
 * What the bot tells Telegram, and how often. Liquidations are always sent; problems are sent once
 * per hour per subject (an account, a token) so a stuck condition doesn't flood the group.
 * Heartbeats stay in the logs; a daily summary goes to Telegram.
 */
import { explorerUrl } from "@/lib/solana/config";
import { esc, notify } from "./notify";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const usd = (n: number) => `$${n.toFixed(2)}`;
const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;
const accountLink = (margin: string) => `<a href="${explorerUrl("address", margin)}">${short(margin)}</a>`;

let mode = "";
const day = { since: Date.now(), liquidations: 0, profitUsd: 0, failures: 0 };

export function online(info: { liquidator: string; dryRun: boolean; strategies: string[]; shard: string }) {
  mode = info.dryRun ? "[DRY RUN] " : "";
  return notify(
    `🟢 ${mode}<b>Liquidator online</b>\n` +
      `Wallet ${accountLink(info.liquidator)} · shard ${esc(info.shard)} · strategies ${esc(info.strategies.join(", "))}\n` +
      (info.dryRun ? "Dry run: it reports what it would liquidate and sends nothing." : "Live: it sends liquidations."),
  );
}

export function stopping(signal: string) {
  return notify(`⚪ ${mode}<b>Liquidator stopping</b> (${esc(signal)})`);
}

export function liquidated(s: { margin: string; signature: string; strategy: string; profitUsd: number; summary: Record<string, unknown>; healthFactor: number | null }) {
  day.liquidations++;
  day.profitUsd += s.profitUsd;
  return notify(
    `✅ <b>Liquidated</b> ${accountLink(s.margin)} · HF ${s.healthFactor?.toFixed(4) ?? "?"}\n` +
      `${esc(s.strategy)}: repay ${esc(s.summary.debt)}, seize ${esc(s.summary.collateral)} · profit ≈ <b>${usd(s.profitUsd)}</b>\n` +
      `<a href="${explorerUrl("tx", s.signature)}">transaction</a>`,
  );
}

export function wouldLiquidate(s: { margin: string; strategy: string; profitUsd: number; summary: Record<string, unknown>; healthFactor: number | null }) {
  return notify(
    `🔎 [DRY RUN] <b>Would liquidate</b> ${accountLink(s.margin)} · HF ${s.healthFactor?.toFixed(4) ?? "?"}\n` +
      `${esc(s.strategy)}: repay ${esc(s.summary.debt)}, seize ${esc(s.summary.collateral)} · profit ≈ ${usd(s.profitUsd)}`,
    { key: `dry:${s.margin}`, everyMs: HOUR },
  );
}

export function cannotRepay(margin: string, healthFactor: number | null, missing: string[]) {
  return notify(
    `🔴 ${mode}<b>Cannot repay</b> ${accountLink(margin)} · HF ${healthFactor?.toFixed(4) ?? "?"}\n` +
      `The wallet holds no ${esc(missing.join(", "))}. Top it up so the bot can repay this debt.`,
    { key: `repay:${margin}`, everyMs: HOUR },
  );
}

export function noStrategy(margin: string, healthFactor: number | null, venueHeld: boolean) {
  return notify(
    `🟠 ${mode}<b>Liquidatable, no strategy can act</b> ${accountLink(margin)} · HF ${healthFactor?.toFixed(4) ?? "?"}` +
      (venueHeld ? "\nIts collateral is in a venue (Kamino / Phoenix unwind is not supported yet)." : ""),
    { key: `nostrategy:${margin}`, everyMs: HOUR },
  );
}

export function liquidationFailed(margin: string, error: string) {
  day.failures++;
  return notify(`🔴 ${mode}<b>Liquidation failed</b> ${accountLink(margin)}\n<code>${esc(error.slice(0, 300))}</code>`, {
    key: `failed:${margin}`,
    everyMs: HOUR,
  });
}

/** Error text without the long account lists RPC errors carry ("failed to get info for accounts A,B,C…"). */
const shortError = (error: string) =>
  error
    .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}(?:,[1-9A-HJ-NP-Za-km-z]{32,44})+/g, (list) => {
      const keys = list.split(",");
      return `${keys[0].slice(0, 4)}… (+${keys.length - 1} more)`;
    })
    .slice(0, 300);

export function loopFailed(error: string, inARow: number) {
  return notify(`🔴 ${mode}<b>Loop failing</b>: ${inARow} times in a row, it is not checking accounts\n<code>${esc(shortError(error))}</code>`, { key: "loop", everyMs: HOUR });
}

export function loopRecovered(after: number) {
  return notify(`🟢 ${mode}<b>Loop recovered</b> after ${after} failed attempts`, { key: "loop-ok", everyMs: HOUR });
}

/** `lowSol`: the SOL balance when it is under the minimum; `emptyTokens`: borrowable tokens the wallet holds none of. */
export function walletLow(lowSol: number | null, emptyTokens: string[]) {
  const parts = [lowSol !== null ? `SOL only ${lowSol.toFixed(4)} (fees)` : "", emptyTokens.length ? `no ${emptyTokens.join(", ")} (their debts can't be repaid)` : ""];
  return notify(`🟠 ${mode}<b>Liquidator wallet low</b>: ${esc(parts.filter(Boolean).join(" · "))}`, {
    key: `wallet:${lowSol !== null}:${emptyTokens.join(",")}`,
    everyMs: HOUR,
  });
}

/** Once a day: what happened since the last summary. Called every heartbeat. */
export function dailySummary(s: { known: number; liquidatable: number; wallet: Record<string, string> }) {
  if (Date.now() - day.since < DAY) return Promise.resolve();
  const text =
    `📊 ${mode}<b>Liquidator, last 24h</b>\n` +
    `${day.liquidations} liquidation(s), profit ≈ ${usd(day.profitUsd)}, ${day.failures} failure(s)\n` +
    `${s.known} accounts watched, ${s.liquidatable} liquidatable now\n` +
    `Wallet: ${esc(Object.entries(s.wallet).map(([k, v]) => `${k} ${v}`).join(", ") || "empty")}`;
  Object.assign(day, { since: Date.now(), liquidations: 0, profitUsd: 0, failures: 0 });
  return notify(text);
}
