import { NextResponse } from "next/server";
import { authed, readJson } from "@/lib/copilot/workflow/http";
import { confirmWorkflow } from "@/lib/copilot/workflow";
import { forgetWallet } from "@/lib/copilot/investigation/read-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Body: { step_n }. Idempotent poll of the chain; only a confirmed signature marks a step done. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async (user) => {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const res = await confirmWorkflow(id, { step_n: Number(body.step_n) }, user);
    // Balances and positions may have just changed: the next answer reads them again.
    forgetWallet(user.wallet);
    return NextResponse.json(res);
  });
}
