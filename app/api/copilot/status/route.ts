import { NextResponse } from "next/server";
import { authed, readJson } from "@/lib/copilot/workflow/http";
import { statusLinesFor } from "@/lib/copilot/status-lines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Progress lines for the chat's "working" row, worded by the model for this prompt. Cosmetic: it never reads or
 * changes a plan, and every failure answers with no lines.
 */
export async function POST(req: Request) {
  return authed(req, async (user) => {
    const body = await readJson(req);
    const message = typeof body.message === "string" ? body.message : "";
    return NextResponse.json({ lines: await statusLinesFor(user, message) });
  });
}
