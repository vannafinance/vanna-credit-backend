/**
 * Dev-only turn tracing for the prompt suite (scripts/copilot-prompt-suite.ts).
 *
 * Active ONLY when NODE_ENV !== "production", no K_SERVICE, COPILOT_DEBUG_FACTS=1 AND the request
 * carries `x-copilot-debug: 1`. It records every MCP tool result the brain fetched during one chat
 * turn, the router source/intent and the LLM tokens, and the chat route returns them under `debug`.
 * It never changes behaviour; with the flag off every function here is a no-op.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface DebugTrace {
  mcp: Array<{ tool: string; action: string | null; ok: boolean; args: unknown; result: unknown }>;
  notes: Record<string, unknown>;
}

const g = globalThis as unknown as { __copilotDebugAls?: AsyncLocalStorage<DebugTrace> };
const als = (g.__copilotDebugAls ??= new AsyncLocalStorage<DebugTrace>());

export function debugAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && !process.env.K_SERVICE && process.env.COPILOT_DEBUG_FACTS === "1";
}

export function withDebugTrace<T>(fn: () => Promise<T>): Promise<{ value: T; trace: DebugTrace }> {
  const trace: DebugTrace = { mcp: [], notes: {} };
  return als.run(trace, async () => ({ value: await fn(), trace }));
}

export function debugMcp(tool: string, args: Record<string, unknown>, ok: boolean, result: unknown): void {
  const t = als.getStore();
  if (t && t.mcp.length < 60) t.mcp.push({ tool, action: typeof args.action === "string" ? args.action : null, ok, args, result });
}

export function debugNote(key: string, value: unknown): void {
  const t = als.getStore();
  if (t) t.notes[key] = value;
}
