import { NextResponse } from "next/server";

import { copilotConfig } from "@/lib/copilot/config";
import { mcpListTools } from "@/lib/copilot/mcp-client";
import type { BrainHealth } from "@/lib/copilot/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function llmAuth(): BrainHealth["llm"]["auth"] {
  if (process.env.K_SERVICE) return "attached_service_account";
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return "service_account";
  if (process.env.GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES || process.env.GOOGLE_AUTH_WORKLOAD_IDENTITY) return "workload_identity";
  return "unknown";
}

async function pingVertex(): Promise<boolean> {
  const { GoogleGenAI } = await import("@google/genai");
  const client = new GoogleGenAI({
    vertexai: true,
    project: copilotConfig.googleCloudProject,
    location: copilotConfig.googleCloudLocation,
  });
  const res = await client.models.generateContent({
    model: copilotConfig.vertexModel,
    contents: "Reply with the single word: ok",
    config: { maxOutputTokens: 8 },
  });
  return typeof res.text === "string";
}

/** GET /api/copilot/health; `?probe=1` also pings Vertex and lists MCP tools. No secrets are returned. */
export async function GET(req: Request) {
  const probe = new URL(req.url).searchParams.get("probe") === "1";
  const storeKind: BrainHealth["store"]["kind"] = copilotConfig.firestoreProject ? "firestore" : "local_file";
  const storeReady = storeKind === "firestore" || !copilotConfig.isProduction;

  const health: BrainHealth = {
    status: "ok",
    chain: "solana",
    llm: { provider: "vertex", model: copilotConfig.vertexModel, auth: llmAuth() },
    mcp: { base_url: copilotConfig.mcpBaseUrl, auth: copilotConfig.mcpAuthMode === "none" ? "none" : "workos_m2m" },
    store: {
      kind: storeKind,
      project: copilotConfig.firestoreProject || null,
      database: copilotConfig.firestoreProject ? copilotConfig.firestoreDatabase : null,
    },
    auth: { siws: copilotConfig.sessionSecret.length >= 32 && !!copilotConfig.authDomain },
  };
  if (!storeReady || !health.auth.siws) health.status = "degraded";

  if (probe) {
    try {
      health.mcp.tools = (await mcpListTools()).length;
      health.mcp.reachable = true;
    } catch {
      health.mcp.reachable = false;
      health.status = "degraded";
    }
    let vertexOk = false;
    try {
      vertexOk = await pingVertex();
    } catch {
      vertexOk = false;
    }
    if (!vertexOk) health.status = "degraded";
  }
  return NextResponse.json(health, { headers: { "Cache-Control": "no-store" } });
}
