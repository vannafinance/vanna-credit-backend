import type { Metadata } from "next";
import { ApprovePlan } from "@/components/copilot/approve/approve-plan";

/**
 * /approve/<plan>: where a plan drawn through the public Vanna MCP connector (Claude, Cursor, Codex …) is reviewed,
 * approved and signed with this site's wallet connection. See components/copilot/approve/approve-plan.tsx.
 */
export const metadata: Metadata = {
  title: "Review and sign",
  description: "Approve and sign a Vanna plan with your own wallet.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ApprovePage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  return <ApprovePlan planId={planId} />;
}
