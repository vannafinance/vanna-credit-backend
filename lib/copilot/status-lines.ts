/**
 * The short progress lines the chat shows while a reply is being worked out ("Reading your margin account…"),
 * worded by the model for the user's own prompt instead of one fixed "Working…".
 *
 * Cosmetic only. The lines describe what the Copilot is about to look at; they never state a result, an amount or a
 * figure, and nothing here touches a plan, a quote or a transaction. Any failure returns no lines and the chat is
 * unaffected. The call is small (a few hundred tokens), counted against the wallet's daily token budget, and has its
 * own per-minute window so it cannot be used to run the model outside the chat's limits.
 */

import { copilotConfig } from "./config";
import { consumeWindow, recordTokens, tokensUsedToday } from "./limits";
import type { CopilotUser } from "./types";
import { getLlm, llmConfigured } from "./vertex";

const MAX_MESSAGE_CHARS = 600;
const MAX_LINES = 4;
const MAX_LINE_CHARS = 48;
const STATUS_TIMEOUT_MS = 6_000;

const STATUS_SCHEMA = {
  type: "OBJECT",
  properties: {
    lines: {
      type: "ARRAY",
      description: "Three or four progress lines, in the order the work happens.",
      items: { type: "STRING" },
    },
  },
  required: ["lines"],
} as const;

const STATUS_SYSTEM = `You write the short progress lines an assistant shows while it works on a request in Vanna, a Solana app for lending (Earn), margin accounts (deposit, borrow, repay, withdraw, leverage), swaps and Kamino farms.
Given the user's message, return 3 or 4 lines that say what the assistant is doing for THAT request, in order.
Each line: a present-participle phrase of at most 6 words, ending with "…". Examples: "Reading your margin account…", "Checking the SOL price…", "Sizing the borrow against your health floor…".
Rules:
- Describe actions only, never results or conclusions.
- No numbers, amounts, prices, percentages or dates. Asset names (SOL, USDC) are fine.
- Never say anything was done, sent, signed, approved or executed.
- No advice and no questions.
- Write in the language of the user's message.
- If the message is unclear or off-topic, write lines about reading and understanding the request.`;

/** Lines that break the rules (figures, claims, long) are dropped rather than shown. */
export function cleanStatusLines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    let line = item.replace(/\s+/g, " ").trim();
    if (!line || /\d/.test(line)) continue;
    if (/\b(done|sent|signed|approved|executed|completed|confirmed)\b/i.test(line)) continue;
    if (line.length > MAX_LINE_CHARS) continue;
    if (!/(…|\.\.\.)$/.test(line)) line = `${line.replace(/[.!]+$/, "")}…`;
    out.push(line.replace(/\.\.\.$/, "…"));
    if (out.length === MAX_LINES) break;
  }
  return out;
}

export async function statusLinesFor(user: CopilotUser, message: string): Promise<string[]> {
  const text = message.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!text || !llmConfigured()) return [];
  if ((await tokensUsedToday(user)) >= copilotConfig.dailyTokenCap) return [];
  const window = await consumeWindow(`status:${user.subject}`, copilotConfig.rateChatPerMin, 60_000);
  if (!window.ok) return [];
  try {
    const res = await getLlm().generate({
      system: STATUS_SYSTEM,
      user: text,
      responseSchema: STATUS_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 400,
      thinkingLevel: "LOW",
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (res.tokens > 0) await recordTokens(user, res.tokens).catch(() => undefined);
    if (!res.text) return [];
    const parsed = JSON.parse(res.text) as { lines?: unknown };
    return cleanStatusLines(parsed.lines);
  } catch {
    return [];
  }
}
