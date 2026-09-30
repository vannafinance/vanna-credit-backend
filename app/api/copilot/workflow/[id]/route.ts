import { NextResponse } from "next/server";
import { authed } from "@/lib/copilot/workflow/http";
import { getWorkflow, toPlanView } from "@/lib/copilot/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The server-held plan, as the browser may see it (no transactions, no ids of other users). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async (user) => {
    const { id } = await ctx.params;
    return NextResponse.json({ plan: toPlanView(await getWorkflow(id, user)) });
  });
}
