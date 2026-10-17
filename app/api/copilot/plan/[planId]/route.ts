import { guarded } from "@/lib/copilot/workflow/http";
import { proxyPlan } from "@/lib/copilot/approve/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An MCP-connector plan as the approve page shows it (no transactions). See lib/copilot/approve/proxy.ts. */
export async function GET(req: Request, ctx: { params: Promise<{ planId: string }> }) {
  return guarded(req, async () => {
    const { planId } = await ctx.params;
    return proxyPlan(req, planId, null);
  });
}
