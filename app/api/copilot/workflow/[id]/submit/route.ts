import { NextResponse } from "next/server";
import { authed, readJson } from "@/lib/copilot/workflow/http";
import { submitWorkflow } from "@/lib/copilot/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Body: { step_n, signed_tx }. The server verifies the signed transaction matches the one it built, then broadcasts. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async (user) => {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const res = await submitWorkflow(id, { step_n: Number(body.step_n), signed_tx: typeof body.signed_tx === "string" ? body.signed_tx : "" }, user);
    return NextResponse.json(res);
  });
}
