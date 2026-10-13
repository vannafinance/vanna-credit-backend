/**
 * Telegram alerts: send-only (the bot takes no commands from Telegram; its wallet holds funds).
 *
 * Configured by TELEGRAM_BOT_TOKEN (or TELEGRAM_BOT_TOKEN_PATH, a file holding it) and
 * TELEGRAM_CHAT_ID. Without both, alerts are a no-op and the bot runs as before.
 *
 * Messages are sent one at a time (Telegram allows ~20 a minute per group), a `key` sends the same
 * alert at most once per `everyMs`, and a failed send is logged and dropped: alerts never stop or
 * slow down liquidations.
 */
import { readFileSync } from "node:fs";
import { log } from "./log";

const MIN_GAP_MS = 3_000;

function readToken(): string | null {
  const path = process.env.TELEGRAM_BOT_TOKEN_PATH;
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? (path ? readFileSync(path, "utf8") : "")).trim();
  return token || null;
}

const token = readToken();
const chatId = process.env.TELEGRAM_CHAT_ID?.trim() || null;
export const telegramEnabled = Boolean(token && chatId);
/** Chats allowed to use the read-only commands: the alert chat plus TELEGRAM_ALLOWED_CHATS (comma-separated ids). */
export const allowedChats = new Set([chatId, ...(process.env.TELEGRAM_ALLOWED_CHATS ?? "").split(",")].map((c) => c?.trim()).filter((c): c is string => Boolean(c)));

const lastSent = new Map<string, number>();
let queue: Promise<void> = Promise.resolve();

/** Escapes text for Telegram's HTML parse mode. */
export const esc = (text: unknown) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Queues an HTML message. With `key`, the same alert is sent at most once per `everyMs`
 * (default 1 hour), e.g. "cannot repay" for one account.
 */
export function notify(html: string, opts: { key?: string; everyMs?: number } = {}): Promise<void> {
  if (!telegramEnabled) return Promise.resolve();
  if (opts.key) {
    const now = Date.now();
    if (now - (lastSent.get(opts.key) ?? 0) < (opts.everyMs ?? 3_600_000)) return Promise.resolve();
    lastSent.set(opts.key, now);
  }
  return reply(chatId!, html);
}

/** Queues an HTML message to one chat (alerts go to TELEGRAM_CHAT_ID; command replies to the asking chat). */
export function reply(chat: string, html: string): Promise<void> {
  if (!token) return Promise.resolve();
  // A send that never settles must not block every message behind it: give up on it after 20 s.
  const bounded = () => Promise.race([send(chat, html), new Promise<void>((resolve) => setTimeout(resolve, 20_000))]);
  queue = queue.then(bounded).then(() => new Promise((resolve) => setTimeout(resolve, MIN_GAP_MS)));
  return queue;
}

/** Calls a Telegram Bot API method. Never throws with the URL: it holds the token. Never hangs: a call
 * that has not settled `timeoutMs` + 5 s after it started resolves to null (a stalled socket once left
 * the command poller waiting forever). */
export function telegramApi<T>(method: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<T | null> {
  if (!token) return Promise.resolve(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      log("WARNING", `telegram ${method} timed out`, { afterMs: timeoutMs + 5_000 });
      resolve(null);
    }, timeoutMs + 5_000);
  });
  return Promise.race([callApi<T>(method, body, timeoutMs), deadline]).finally(() => clearTimeout(timer));
}

async function callApi<T>(method: string, body: Record<string, unknown>, timeoutMs: number): Promise<T | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!json.ok) {
      log("WARNING", `telegram ${method} failed`, { status: res.status, description: json.description });
      return null;
    }
    return json.result ?? null;
  } catch (error) {
    log("WARNING", `telegram ${method} failed`, { error: error instanceof Error ? error.name : "Error" });
    return null;
  }
}

async function send(chat: string, html: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { description?: string };
      log("WARNING", "telegram send failed", { status: res.status, description: body.description });
    }
  } catch (error) {
    // Never log the error object itself: a fetch error can carry the URL, and the URL holds the token.
    log("WARNING", "telegram send failed", { error: error instanceof Error ? error.name : "Error" });
  }
}
