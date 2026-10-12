import { NextResponse } from "next/server";
import { authed, readJson } from "@/lib/copilot/workflow/http";
import { submitWorkflow } from "@/lib/copilot/workflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A Predict trade sends its transactions in order, each confirmed before the next.
export const maxDuration = 120;

/** Body: { step_n, signed_tx, signed_txs? } (signed_txs: every transaction of a Predict trade, signed in one approval). The server verifies the signed transaction matches the one it built, then broadcasts. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return authed(req, async (user) => {
    const { id } = await ctx.params;
    const body = await readJson(req);
    const signedTxs = Array.isArray(body.signed_txs) ? body.signed_txs.filter((x: unknown): x is string => typeof x === "string").slice(0, 8) : undefined;
    const res = await submitWorkflow(id, { step_n: Number(body.step_n), signed_tx: typeof body.signed_tx === "string" ? body.signed_tx : "", ...(signedTxs ? { signed_txs: signedTxs } : {}) }, user);
    return NextResponse.json(res);
  });
}
