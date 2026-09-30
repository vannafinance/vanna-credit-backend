import { NextResponse } from "next/server";
import { authed, readJson } from "@/lib/copilot/workflow/http";
import { approveWorkflow } from "@/lib/copilot/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Body: { digest }. Approval is bound to the plan's digest and expires 5 minutes after creation. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async (user) => {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const plan = await approveWorkflow(id, typeof body.digest === "string" ? body.digest : "", user);
    return NextResponse.json({ plan });
  });
}
