/**
 * Read-only Telegram commands: the protocol's accounts as the analytics site shows them, from the
 * bot's last loop. Only chats in `allowedChats` get an answer; nothing here can send a transaction
 * or change a setting.
 *
 *   /stats              totals, health bands, liquidatable / at risk, bad debt, wallet
 *   /risky [n]          lowest health first
 *   /liquidatable       at or below the liquidation line now
 *   /top [n]            largest debt first
 *   /account <address>  one account (margin or wallet address)
 *   /wallet             the liquidator wallet
 *   /help
 */
import { DISPLAY_BANDS, LIQUIDATION_LINE, STATUS_LABEL, summarize } from "@/lib/analytics/risk";
import { accountHref } from "@/lib/analytics/links";
import type { AccountRow } from "@/lib/analytics/types";
import { explorerUrl } from "@/lib/solana/config";
import { log } from "./log";
import { allowedChats, esc, reply, telegramApi } from "./notify";
import { getSnapshot, type BotSnapshot } from "./state";

const SITE = (process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "https://test.solana.vanna.finance").replace(/\/$/, "");
const MAX_ROWS = 15;

const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `$${Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(2)}`;
const hf = (n: number | null) => (n === null ? "∞" : n.toFixed(3));
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const siteLink = (r: AccountRow, label = short(r.address)) => `<a href="${SITE}${accountHref(r.address, "overview")}">${esc(label)}</a>`;
const ago = (at: number) => {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
};
const footer = (s: BotSnapshot) => `\n<i>As of ${ago(s.at)}${s.dryRun ? " · dry run" : ""}</i>`;
const dot = (r: AccountRow) => (r.liquidatable ? "🔴" : (r.healthFactor ?? Infinity) < DISPLAY_BANDS.critical ? "🟠" : (r.healthFactor ?? Infinity) < DISPLAY_BANDS.warning ? "🟡" : "🟢");

export function formatStats(s: BotSnapshot): string {
  const sum = summarize(s.rows);
  const bands = sum.healthBands.filter((b) => b.count > 0).map((b) => `  ${esc(b.label)}: ${b.count} · debt ${usd(b.debtUsd)}`);
  return [
    `📊 <b>Vanna accounts</b>`,
    `Accounts ${sum.total} · valued ${sum.valued} · borrowing ${sum.borrowers}`,
    `Collateral ${usd(sum.collateralUsd)} · Debt ${usd(sum.debtUsd)} · Equity ${usd(sum.equityUsd)}`,
    `Average health ${sum.averageHealth === null ? "—" : sum.averageHealth.toFixed(2)} · leverage ${sum.averageLeverage === null ? "—" : `${sum.averageLeverage.toFixed(2)}x`}`,
    ``,
    `🔴 Liquidatable now: <b>${sum.liquidatableCount}</b> · debt ${usd(sum.liquidatableDebtUsd)}`,
    `🟡 At risk (HF &lt; ${DISPLAY_BANDS.warning}): ${sum.atRiskCount} · debt ${usd(sum.atRiskDebtUsd)}`,
    `Bad debt: ${usd(sum.badDebtUsd)} in ${sum.underwaterCount} account(s)`,
    ...(bands.length ? [``, `Health bands (liquidation at ${LIQUIDATION_LINE.toFixed(2)}):`, ...bands] : []),
    ``,
    `Coverage: ${s.coverage.accountsFound} accounts from ${s.coverage.transactionsScanned} transactions${s.coverage.complete ? "" : " (scan still running)"}`,
    footer(s),
  ].join("\n");
}

export function formatList(title: string, rows: AccountRow[], s: BotSnapshot, total = rows.length): string {
  if (!rows.length) return `${title}\nNone.${footer(s)}`;
  const lines = rows
    .slice(0, MAX_ROWS)
    .map((r, i) => `${i + 1}. ${dot(r)} ${siteLink(r)} HF <b>${hf(r.healthFactor)}</b> · debt ${usd(r.debtUsd)} · coll ${usd(r.collateralUsd)}${r.venueHeld ? " · Phoenix" : ""}`);
  const more = total > MAX_ROWS ? `\n…and ${total - MAX_ROWS} more` : "";
  return `${title}\n${lines.join("\n")}${more}${footer(s)}`;
}

export function formatAccount(r: AccountRow, s: BotSnapshot): string {
  const coll = r.collateral.filter((l) => l.usd > 0 || l.amount > 0).map((l) => `  ${esc(l.symbol)} ${l.amount ? l.amount.toFixed(4) : ""} ${usd(l.usd)}`);
  const debts = r.debts.map((l) => `  ${esc(l.symbol)} ${l.amount.toFixed(4)} ${usd(l.usd)}${l.borrowApr !== null ? ` · ${(l.borrowApr * 100).toFixed(2)}% APR` : ""}`);
  return [
    `${dot(r)} <b>Account</b> ${siteLink(r, r.address)}`,
    `Owner <a href="${explorerUrl("address", r.owner)}">${short(r.owner)}</a> · ${esc(STATUS_LABEL[r.status])}`,
    `HF <b>${hf(r.healthFactor)}</b> · leverage ${r.leverage === null ? "—" : `${r.leverage.toFixed(2)}x`} · buffer ${r.bufferUsd === null ? "—" : `${usd(r.bufferUsd)} (${((r.bufferPct ?? 0) * 100).toFixed(1)}%)`}`,
    `Collateral ${usd(r.collateralUsd)} · Debt ${usd(r.debtUsd)} · Equity ${usd(r.equityUsd)}`,
    ...(coll.length ? [`Collateral:`, ...coll] : []),
    ...(debts.length ? [`Debts:`, ...debts] : []),
    ...(r.liquidatable ? [`<b>Liquidatable now.</b>`] : []),
    footer(s),
  ].join("\n");
}

export function formatWallet(s: BotSnapshot): string {
  const lines = Object.entries(s.wallet).map(([k, v]) => `  ${esc(k)} ${esc(v)}`);
  return [`👛 <b>Liquidator wallet</b> <a href="${explorerUrl("address", s.liquidator)}">${short(s.liquidator)}</a>`, ...(lines.length ? lines : ["  empty"]), footer(s)].join("\n");
}

const HELP = [
  `<b>Vanna liquidator</b> (read-only)`,
  `/stats: totals, health bands, liquidatable, bad debt`,
  `/risky [n]: lowest health first`,
  `/liquidatable: at or below ${LIQUIDATION_LINE.toFixed(2)} now`,
  `/top [n]: largest debt first`,
  `/account &lt;address&gt;: one account (margin or wallet)`,
  `/wallet: the liquidator wallet`,
].join("\n");

const borrowers = (rows: AccountRow[]) => rows.filter((r) => r.valued && (r.debtUsd ?? 0) > 0);

/** The reply to one command, or null for text that isn't a command. */
export function answer(text: string, s: BotSnapshot | null): string | null {
  const [raw, ...args] = text.trim().split(/\s+/);
  if (!raw?.startsWith("/")) return null;
  const command = raw.slice(1).split("@")[0].toLowerCase();
  if (command === "help" || command === "start") return HELP;
  if (!s) return "Still starting: the first scan isn't done yet. Try again in a minute.";
  const n = Math.min(Math.max(Number(args[0]) || 10, 1), MAX_ROWS);
  switch (command) {
    case "stats":
      return formatStats(s);
    case "risky": {
      const list = borrowers(s.rows).sort((a, b) => (a.healthFactor ?? Infinity) - (b.healthFactor ?? Infinity));
      return formatList(`⚠️ <b>Lowest health</b>`, list.slice(0, n), s, list.length);
    }
    case "liquidatable": {
      const list = s.rows.filter((r) => r.liquidatable).sort((a, b) => (b.debtUsd ?? 0) - (a.debtUsd ?? 0));
      return formatList(`🔴 <b>Liquidatable now</b>`, list, s);
    }
    case "top": {
      const list = borrowers(s.rows).sort((a, b) => (b.debtUsd ?? 0) - (a.debtUsd ?? 0));
      return formatList(`🏦 <b>Largest debt</b>`, list.slice(0, n), s, list.length);
    }
    case "account": {
      const key = args[0];
      if (!key) return "Usage: /account &lt;margin or wallet address&gt;";
      const row = s.rows.find((r) => r.address === key || r.owner === key);
      return row ? formatAccount(row, s) : `No account ${esc(short(key))} among the ${s.rows.length} the bot watches.`;
    }
    case "wallet":
      return formatWallet(s);
    default:
      return `Unknown command. ${HELP}`;
  }
}

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

/**
 * Long-polls Telegram for commands until `isStopping()`. Starts after the newest pending update
 * (old messages are not answered). One process per bot token may poll: with several shards, only
 * shard 0 runs this, and it answers for the accounts in its own shard.
 */
export async function pollCommands(isStopping: () => boolean): Promise<void> {
  if (!allowedChats.size) return;
  await telegramApi("setMyCommands", {
    commands: [
      { command: "stats", description: "Totals, health bands, liquidatable, bad debt" },
      { command: "risky", description: "Lowest health first" },
      { command: "liquidatable", description: "Liquidatable now" },
      { command: "top", description: "Largest debt first" },
      { command: "account", description: "One account: /account <address>" },
      { command: "wallet", description: "The liquidator wallet" },
      { command: "help", description: "What the bot can show" },
    ],
  });
  const pending = await telegramApi<Update[]>("getUpdates", { offset: -1, timeout: 0 });
  let offset = pending?.length ? pending[pending.length - 1].update_id + 1 : 0;
  while (!isStopping()) {
    const updates = await telegramApi<Update[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 35_000);
    if (!updates) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const chat = u.message ? String(u.message.chat.id) : null;
      if (!chat || !u.message?.text || !allowedChats.has(chat)) continue;
      const text = answer(u.message.text, getSnapshot());
      if (text) {
        log("INFO", "telegram command", { chat, command: u.message.text.split(/\s+/)[0] });
        void reply(chat, text);
      }
    }
  }
}
