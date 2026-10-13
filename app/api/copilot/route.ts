import { NextResponse } from "next/server";
import { getUser, renewSessionCookie } from "@/lib/copilot/auth";
import { handleChat } from "@/lib/copilot";
import { debugAllowed, withDebugTrace } from "@/lib/copilot/debug";
import { guarded, readJson } from "@/lib/copilot/workflow/http";
import type { ChatRequest } from "@/lib/copilot/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One chat turn. The body carries a message, an optional conversation id, short text history and a
 * clarification pick. It never carries a wallet, an amount to execute or a transaction: identity is
 * the signed session cookie, and everything executable lives in the server-held plan.
 */
export async function POST(req: Request) {
  return guarded(req, async () => {
    const body = await readJson(req);
    const user = await getUser(req);
    const chat: ChatRequest = {
      message: typeof body.message === "string" ? body.message : "",
      conversation_id: typeof body.conversation_id === "string" ? body.conversation_id : null,
      history: Array.isArray(body.history) ? (body.history as ChatRequest["history"]) : null,
      surface: body.surface === "assistant" ? "assistant" : "copilot",
      clarify:
        body.clarify && typeof body.clarify === "object" && typeof (body.clarify as Record<string, unknown>).pending_id === "string" && typeof (body.clarify as Record<string, unknown>).option_id === "string"
          ? (body.clarify as ChatRequest["clarify"])
          : null,
    };
    const input = { req: chat, user, requestId: req.headers.get("x-request-id") ?? undefined };
    // Dev-only (NODE_ENV!=="production", COPILOT_DEBUG_FACTS=1, header x-copilot-debug: 1): return the MCP facts the turn used.
    const traced = debugAllowed() && req.headers.get("x-copilot-debug") === "1";
    const out = traced ? await withDebugTrace(() => handleChat(input)) : null;
    const res = out ? out.value : await handleChat(input);
    const headers: Record<string, string> = {};
    if (res.limit?.retry_after_s) headers["Retry-After"] = String(res.limit.retry_after_s);
    const status = res.kind === "needs_login" ? 401 : res.limit ? 429 : 200;
    // A chat turn counts as use: the sign-in is renewed (see renewSessionCookie).
    const renewed = renewSessionCookie(user);
    if (renewed) headers["Set-Cookie"] = renewed;
    return NextResponse.json(out ? { ...res, debug: out.trace } : res, { status, headers });
  });
}
