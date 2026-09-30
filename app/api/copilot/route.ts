import { NextResponse } from "next/server";
import { getUser } from "@/lib/copilot/auth";
import { handleChat } from "@/lib/copilot";
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
    const res = await handleChat({ req: chat, user, requestId: req.headers.get("x-request-id") ?? undefined });
    const headers: Record<string, string> = {};
    if (res.limit?.retry_after_s) headers["Retry-After"] = String(res.limit.retry_after_s);
    const status = res.kind === "needs_login" ? 401 : res.limit ? 429 : 200;
    return NextResponse.json(res, { status, headers });
  });
}
