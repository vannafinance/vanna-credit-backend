/**
 * Clarification state. When the Copilot asks "Earn, margin or Kamino?", the options it offers are
 * stored server-side against the conversation, each holding the fully specified intent it stands
 * for. The browser sends back only `{pending_id, option_id}`; it never resends an amount or asset.
 * A pick is single-use and expires.
 */

import { randomUUID } from "node:crypto";
import type { AskOption, Intent } from "../intent";
import { conversationStore, type RecordStore } from "../store";
import type { ClarifyOption, CopilotUser } from "../types";

export const PENDING_TTL_MS = 10 * 60 * 1000;
const UUID = /^[a-f0-9-]{36}$/;

interface PendingRecord {
  id: string;
  expires_at: number;
  options: Array<{ id: string; label: string; apply: Intent }>;
}

export interface ConversationRecord {
  v: 1;
  subject: string;
  created_at: number;
  updated_at: number;
  pending: PendingRecord | null;
}

export const pendingDeps = {
  store: (() => {
    let s: RecordStore<ConversationRecord> | null = null;
    return () => (s ??= conversationStore<ConversationRecord>());
  })(),
  now: () => Date.now(),
};

export const isConversationId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** Stores the options and returns what the UI needs to render them. */
export async function savePending(
  conversationId: string,
  user: CopilotUser,
  options: AskOption[],
): Promise<{ pending_id: string; clarify_options: ClarifyOption[] }> {
  const now = pendingDeps.now();
  const pending: PendingRecord = {
    id: randomUUID(),
    expires_at: now + PENDING_TTL_MS,
    options: options.slice(0, 6).map((o, i) => ({ id: `opt-${i + 1}`, label: o.label, apply: o.apply })),
  };
  const store = pendingDeps.store();
  for (let i = 0; i < 5; i++) {
    const cur = await store.read(conversationId);
    if (cur && cur.value.subject !== user.subject) throw new Error("conversation_forbidden");
    const next: ConversationRecord = {
      v: 1,
      subject: user.subject,
      created_at: cur?.value.created_at ?? now,
      updated_at: now,
      pending,
    };
    if (await store.write(conversationId, cur?.version ?? null, next)) {
      return {
        pending_id: pending.id,
        clarify_options: pending.options.map((o, idx) => ({ id: o.id, label: o.label, ...(options[idx].description ? { description: options[idx].description } : {}) })),
      };
    }
  }
  throw new Error("conversation_busy");
}

/** Consumes a pick exactly once. Null when the id is unknown, expired, already used or another user's. */
export async function takePending(conversationId: string, user: CopilotUser, pendingId: string, optionId: string): Promise<Intent | null> {
  const store = pendingDeps.store();
  for (let i = 0; i < 5; i++) {
    const cur = await store.read(conversationId);
    if (!cur || cur.value.subject !== user.subject || !cur.value.pending) return null;
    const p = cur.value.pending;
    if (p.id !== pendingId || pendingDeps.now() > p.expires_at) return null;
    const option = p.options.find((o) => o.id === optionId);
    if (!option) return null;
    const next: ConversationRecord = { ...cur.value, updated_at: pendingDeps.now(), pending: null };
    if (await store.write(conversationId, cur.version, next)) return option.apply;
  }
  return null;
}
