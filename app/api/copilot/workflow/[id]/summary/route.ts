import { NextResponse } from "next/server";
import { authed } from "@/lib/copilot/workflow/http";
import { completionOf } from "@/lib/copilot/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** The reply for a completed plan (Gemini's words, kept on the plan once written). Refused until it has completed. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async (user) => {
    const { id } = await ctx.params;
    return NextResponse.json({ completion: await completionOf(id, user) });
  });
}
