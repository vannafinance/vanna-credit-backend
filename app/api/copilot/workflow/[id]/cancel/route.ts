import { NextResponse } from "next/server";
import { authed } from "@/lib/copilot/workflow/http";
import { cancelWorkflow } from "@/lib/copilot/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stops a plan that has nothing in flight. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async (user) => {
    const { id } = await ctx.params;
    return NextResponse.json({ plan: await cancelWorkflow(id, user) });
  });
}
