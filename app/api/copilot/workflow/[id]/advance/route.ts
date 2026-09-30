import { NextResponse } from "next/server";
import { authed } from "@/lib/copilot/workflow/http";
import { advanceWorkflow } from "@/lib/copilot/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Building a step calls the MCP (simulation, price keeper) and can take a while.
export const maxDuration = 60;

/** Claims the next step (exactly once), re-checks live data, builds it through the MCP. No body. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async (user) => {
    const { id } = await ctx.params;
    return NextResponse.json(await advanceWorkflow(id, user, { requestId: req.headers.get("x-request-id") ?? undefined }));
  });
}
