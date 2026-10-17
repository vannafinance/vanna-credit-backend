import { NextResponse } from "next/server";
import { guarded } from "@/lib/copilot/workflow/http";
import { PLAN_ACTIONS, proxyPlan, type PlanAction } from "@/lib/copilot/approve/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** approve | next | submit | cancel for an MCP-connector plan; same-origin only. See lib/copilot/approve/proxy.ts. */
export async function POST(req: Request, ctx: { params: Promise<{ planId: string; action: string }> }) {
  return guarded(req, async () => {
    const { planId, action } = await ctx.params;
    if (!(PLAN_ACTIONS as readonly string[]).includes(action)) {
      return NextResponse.json({ error: "not_found", message: "Unknown plan action." }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return proxyPlan(req, planId, action as PlanAction);
  });
}
