import type { Metadata } from "next";
import { CopilotWorkspace } from "@/components/copilot/copilot-workspace";

export const metadata: Metadata = {
  title: "Copilot",
  description: "Ask about your Vanna positions on Solana, size a plan, and run it with your own wallet.",
};

export default function CopilotPage() {
  return <CopilotWorkspace />;
}
