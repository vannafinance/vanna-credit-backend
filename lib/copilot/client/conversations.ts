/**
 * Conversation history kept in this browser only, as a convenience for the rail's Recents.
 *
 * It is not a record of anything that matters: plans, approvals and execution state live on
 * the server and are re-read from it. Stored here are the words and the last shape the
 * server answered with. Unsigned transactions are never written to storage, and every key is
 * scoped to the signed-in wallet so two wallets on one browser never see each other's chats.
 */

import type { ChatResponse } from "@/lib/copilot/types";

export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  /** The server's structured reply for an assistant turn. */
  response?: ChatResponse;
  /**
   * How this turn's plan ended, once it did. A reopened chat shows it stopped instead of offering to resume it:
   * the server may still list a plan as running when the user declined in the wallet and walked away.
   */
  run?: StoredRun;
}

export interface StoredRun {
  /** `declined`: the wallet prompt was rejected and the user left without signing again. */
  outcome: "completed" | "failed" | "cancelled" | "expired" | "declined";
  message: string | null;
  at: number;
}

export interface Conversation {
  /** The server's conversation id when it issued one, else a local id. */
  id: string;
  title: string;
  updatedAt: number;
  turns: Turn[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
}

const PREFIX = "vanna.copilot.conversations.v1:";
const MAX_CONVERSATIONS = 40;
const MAX_TURNS = 80;

const key = (wallet: string | null) => `${PREFIX}${wallet ?? "anonymous"}`;

function sanitize(turn: Turn): Turn {
  if (!turn.response?.unsigned_tx) return turn;
  // The wallet-ready transaction is short-lived and server-held; it must not sit in storage.
  const { unsigned_tx: _dropped, ...rest } = turn.response;
  void _dropped;
  return { ...turn, response: rest };
}

export function loadConversations(wallet: string | null): Conversation[] {
  try {
    const raw = window.localStorage.getItem(key(wallet));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as Conversation[])
      .filter((c) => c && typeof c.id === "string" && Array.isArray(c.turns))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveConversations(wallet: string | null, conversations: Conversation[]): void {
  try {
    const trimmed = [...conversations]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS)
      .map((c) => ({ ...c, turns: c.turns.slice(-MAX_TURNS).map(sanitize) }));
    window.localStorage.setItem(key(wallet), JSON.stringify(trimmed));
  } catch {
    /* storage full or blocked: history is a convenience, the chat still works */
  }
}

export function summarize(conversations: Conversation[]): ConversationSummary[] {
  return conversations.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
}

/** A chat is titled by its first question, trimmed to a line the rail can show. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || "New chat";
}

const ACTIVE_PREFIX = "vanna.copilot.active.v1:";

/**
 * The chat open in this browser tab, so leaving /copilot for another page and coming back reopens it rather than a
 * blank chat. Per tab (sessionStorage) and per wallet; a closed tab starts fresh, Recents still hold everything.
 */
export function loadActiveId(wallet: string | null): string | null {
  try {
    return window.sessionStorage.getItem(`${ACTIVE_PREFIX}${wallet ?? "anonymous"}`);
  } catch {
    return null;
  }
}

export function saveActiveId(wallet: string | null, id: string | null): void {
  try {
    const k = `${ACTIVE_PREFIX}${wallet ?? "anonymous"}`;
    if (id) window.sessionStorage.setItem(k, id);
    else window.sessionStorage.removeItem(k);
  } catch {
    /* storage blocked: the page opens a new chat, as before */
  }
}

const LOCAL = "local-";

/** An id minted in this browser before the server has issued one. */
export function newLocalId(): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${LOCAL}${rand}`;
}

export const isLocalId = (id: string) => id.startsWith(LOCAL);
