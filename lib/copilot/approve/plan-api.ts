/**
 * Browser client for the approve page: the site's own proxy (/api/copilot/plan/*) to the public MCP's plan API.
 *
 * Shapes are the MCP's (`mcp_server/planning/engine.py` view / build_next / submit). The run token the approval
 * returns is kept for this tab only (sessionStorage) and sent as `X-Plan-Token`; a copied link without it can view or
 * cancel the plan, never run it.
 */

export type McpStepState =
  | "pending" | "built" | "submitting" | "submitted" | "confirmed" | "skipped" | "failed" | "uncertain" | "expired";

export interface McpPlanStep {
  index: number;
  label: string;
  state: McpStepState;
  kind: string;
  amount: string | null;
  asset: string | null;
  usd: number | null;
  notes: string[];
  signature: string | null;
  error: string | null;
}

export interface McpPlanView {
  plan_id: string;
  kind: string;
  wallet: string;
  summary: string;
  status: string;
  digest: string;
  hf_floor: number;
  warnings: string[];
  simulation: { hf_before: number | null; hf_after: number | null } | null;
  approve_within_seconds: number;
  steps: McpPlanStep[];
  site?: string;
  approval_message: string | null;
  resume_message: string | null;
  run_token?: string;
}

export interface McpNext {
  ok?: boolean;
  done?: boolean;
  skipped?: boolean;
  waiting?: boolean;
  reason?: string;
  step?: number;
  label?: string;
  batch?: boolean;
  risk?: { reasons?: string[] } | null;
  notes?: string[];
  transactions?: { id: string; unsignedTransaction: string; purpose?: string }[];
  plan?: McpPlanView;
}

export class PlanApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "PlanApiError";
  }
}

export function planApi(planId: string) {
  const base = `/api/copilot/plan/${encodeURIComponent(planId)}`;
  const key = `vanna-plan-token:${planId}`;
  let token: string | null = null;
  try { token = sessionStorage.getItem(key); } catch { /* storage blocked: the wallet re-confirms instead */ }

  function keep(t: string | undefined) {
    if (!t) return;
    token = t;
    try { sessionStorage.setItem(key, t); } catch { /* kept in memory */ }
  }

  async function call<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body) headers["Content-Type"] = "application/json";
    if (token) headers["X-Plan-Token"] = token;
    const res = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "same-origin",
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = typeof data.message === "string" ? data.message : `Request failed (${res.status}).`;
      throw new PlanApiError(typeof data.error === "string" ? data.error : "error", message, res.status);
    }
    return data as T;
  }

  return {
    hasToken: () => !!token,
    view: () => call<McpPlanView>(""),
    async approve(wallet: string, signature: string) {
      const r = await call<McpPlanView>("/approve", { wallet, signature });
      keep(r.run_token);
      return r;
    },
    next: () => call<McpNext>("/next", {}),
    submit: (txId: string, signed: string) => call<{ plan?: McpPlanView }>("/submit", { tx_id: txId, signed }),
    cancel: () => call<McpPlanView>("/cancel", {}),
  };
}
