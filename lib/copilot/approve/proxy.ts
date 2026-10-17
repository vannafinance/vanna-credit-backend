/**
 * Server side of the approve page (/approve/<plan>): a narrow proxy to the public MCP connector's plan API.
 *
 * An AI client (Claude, Cursor, Codex …) connected to the public MCP gets a plan link on this site. The page signs with
 * the site's own wallet connection; every decision stays on the MCP, which holds the plan and checks everything again:
 * the approval is a signature by the plan's wallet over the plan's digest, prepare/submit need the run token that
 * approval returned to this browser, and a signed transaction must be byte-identical to the MCP's own build.
 *
 * This proxy adds no authority of its own. It only:
 *  - forwards the five plan endpoints (view, approve, next, submit, cancel) for a well-formed plan id, nothing else;
 *  - requires same-origin POSTs (the `guarded` wrapper) and caps body size;
 *  - forwards the page's run token (`X-Plan-Token`) and, with PLAN_PROXY_SECRET, the caller's address so the MCP's
 *    per-address limit counts each user rather than this server;
 *  - never caches, never logs plan ids.
 */

import { NextResponse } from "next/server";
import { copilotConfig } from "@/lib/copilot/config";

export const PLAN_ACTIONS = ["approve", "next", "submit", "cancel"] as const;
export type PlanAction = (typeof PLAN_ACTIONS)[number];

const PLAN_ID = /^[A-Za-z0-9_-]{20,80}$/;
const MAX_BODY_BYTES = 16_000; // a signed v0 transaction is at most ~1.7 KB of base64
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

export function isPlanId(id: string): boolean {
  return PLAN_ID.test(id);
}

function json(payload: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(payload, { status, headers: NO_STORE });
}

/** The address the user connected from: the entry Cloud Run's front end appended (the right-most one). */
export function clientIp(req: Request): string {
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1] ?? "";
}

function upstreamBase(): string | null {
  const base = copilotConfig.mcpPlanApiUrl;
  if (!base) return null;
  try {
    const url = new URL(base);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) return null;
    if (copilotConfig.isProduction && local) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Forward one plan call to the MCP and hand its answer back unchanged (status and JSON body). */
export async function proxyPlan(req: Request, planId: string, action: PlanAction | null): Promise<NextResponse> {
  if (!isPlanId(planId)) return json({ error: "not_found", message: "This plan link is not valid." }, 404);
  const base = upstreamBase();
  if (!base) return json({ error: "not_available", message: "Approvals are not available on this site right now." }, 503);

  const method = action ? "POST" : "GET";
  let body: string | undefined;
  if (method === "POST") {
    body = await req.text();
    if (body.length > MAX_BODY_BYTES) return json({ error: "invalid_request", message: "That request is too large." }, 413);
    if (body) {
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      } catch {
        return json({ error: "invalid_request", message: "The request body is not valid JSON." }, 400);
      }
    }
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = (req.headers.get("x-plan-token") ?? "").slice(0, 128);
  if (token) headers["X-Plan-Token"] = token;
  const secret = copilotConfig.planProxySecret;
  if (secret) {
    headers["X-Vanna-Proxy-Secret"] = secret;
    const ip = clientIp(req);
    if (ip) headers["X-Vanna-Client-Ip"] = ip.slice(0, 64);
  }

  const path = `/api/plan/${encodeURIComponent(planId)}${action ? `/${action}` : ""}`;
  let upstream: Response;
  try {
    upstream = await fetch(`${base}${path}`, {
      method,
      headers,
      body: method === "POST" ? body || "{}" : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(copilotConfig.mcpTimeoutMs * 2),
    });
  } catch {
    return json({ error: "unavailable", message: "The Vanna signing service did not answer. Nothing was sent; try again." }, 502);
  }
  const data = await upstream.json().catch(() => null);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return json({ error: "unavailable", message: "The Vanna signing service gave an unexpected answer. Nothing was sent." }, 502);
  }
  const extra: Record<string, string> = {};
  const retry = upstream.headers.get("retry-after");
  if (retry && /^\d{1,4}$/.test(retry)) extra["Retry-After"] = retry;
  return NextResponse.json(data, { status: upstream.status, headers: { ...NO_STORE, ...extra } });
}
