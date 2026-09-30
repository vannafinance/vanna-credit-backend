/**
 * Browser-side wrappers for the Copilot API. Typed against `lib/copilot/types.ts` only.
 *
 * Two rules shape every function here:
 *  - The body never carries a wallet, an amount or an asset for a write. Identity is the
 *    session cookie; the plan lives on the server and is approved by digest.
 *  - A server that is unreachable, or that answers with something that is not the contract,
 *    becomes an explicit `CopilotApiError` / an `error` ChatResponse. Nothing is invented.
 */

import type {
  AdvanceResponse,
  ApproveRequest,
  ChatRequest,
  ChatResponse,
  ConfirmRequest,
  ConfirmResponse,
  NonceResponse,
  PlanView,
  SessionResponse,
  SubmitRequest,
  SubmitResponse,
  VerifyRequest,
} from "@/lib/copilot/types";

export class CopilotApiError extends Error {
  /** HTTP status, or 0 when the server could not be reached at all. */
  readonly status: number;
  /** The server's machine code when it sent one (`{ error }`). */
  readonly code: string | null;
  readonly retryAfterS: number | null;

  constructor(message: string, status: number, code: string | null = null, retryAfterS: number | null = null) {
    super(message);
    this.name = "CopilotApiError";
    this.status = status;
    this.code = code;
    this.retryAfterS = retryAfterS;
  }

  get unauthenticated(): boolean {
    return this.status === 401;
  }
}

const BASE = "/api/copilot";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorFrom(res: Response, body: unknown): CopilotApiError {
  const rec = asRecord(body);
  const message =
    (typeof rec?.message === "string" && rec.message) ||
    (typeof rec?.error === "string" && rec.error) ||
    `The Copilot server answered ${res.status}.`;
  const code = typeof rec?.error === "string" ? rec.error : typeof rec?.code === "string" ? rec.code : null;
  const retry = Number(res.headers.get("retry-after"));
  return new CopilotApiError(message, res.status, code, Number.isFinite(retry) && retry > 0 ? retry : null);
}

async function request<T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<{ status: number; body: unknown; ok: boolean; res: Response }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new CopilotApiError("Could not reach the Copilot server.", 0, "unreachable");
  }
  return { status: res.status, body: await readJson(res), ok: res.ok, res };
}

async function json<T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  const { ok, body, res } = await request<T>(path, init, signal);
  if (!ok) throw errorFrom(res, body);
  if (body == null) throw new CopilotApiError("The Copilot server sent an empty reply.", res.status, "empty");
  return body as T;
}

function post<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  return json<T>(path, { method: "POST", body: JSON.stringify(payload) }, signal);
}

/** True when a payload is shaped like a ChatResponse (the route answers 401/429 in that shape too). */
function isChatResponse(body: unknown): body is ChatResponse {
  const rec = asRecord(body);
  return !!rec && typeof rec.kind === "string" && typeof rec.message === "string";
}

/**
 * POST /api/copilot. Every outcome is a ChatResponse: a 401 becomes `needs_login`, a
 * limit or an unreachable server becomes an explicit `error` with the reason, never a blank turn.
 */
export async function sendChat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  let result;
  try {
    result = await request(``, { method: "POST", body: JSON.stringify(req) }, signal);
  } catch (error) {
    if (error instanceof CopilotApiError) {
      return { kind: "error", message: "The Copilot server is not reachable right now. Nothing was sent to your wallet." };
    }
    throw error;
  }
  if (isChatResponse(result.body)) return result.body;
  if (result.status === 401) return { kind: "needs_login", message: "Sign in with your wallet to use the Copilot." };
  const err = errorFrom(result.res, result.body);
  if (result.status === 429) {
    return {
      kind: "error",
      message: err.message,
      limit: { kind: "rate", retry_after_s: err.retryAfterS, message: err.message },
    };
  }
  return { kind: "error", message: err.message };
}

// ── Auth (Sign-In-With-Solana) ───────────────────────────────────────────────

export function getSession(signal?: AbortSignal): Promise<SessionResponse> {
  return json<SessionResponse>("/auth/session", undefined, signal);
}

export function getNonce(wallet: string, signal?: AbortSignal): Promise<NonceResponse> {
  return json<NonceResponse>(`/auth/nonce?wallet=${encodeURIComponent(wallet)}`, undefined, signal);
}

export function verifyLogin(req: VerifyRequest, signal?: AbortSignal): Promise<SessionResponse> {
  return post<SessionResponse>("/auth/verify", req, signal);
}

export async function logout(): Promise<void> {
  await request("/auth/logout", { method: "POST", body: "{}" });
}

// ── Workflow (plan) ──────────────────────────────────────────────────────────

const wf = (id: string, leaf = "") => `/workflow/${encodeURIComponent(id)}${leaf}`;

export function getWorkflow(id: string, signal?: AbortSignal): Promise<PlanView> {
  return json<PlanView | { plan: PlanView }>(wf(id), undefined, signal).then((body) => ("plan" in body ? body.plan : body));
}

export function approvePlan(id: string, req: ApproveRequest, signal?: AbortSignal): Promise<{ plan: PlanView }> {
  return post<{ plan: PlanView }>(wf(id, "/approve"), req, signal);
}

export function advancePlan(id: string, signal?: AbortSignal): Promise<AdvanceResponse> {
  return post<AdvanceResponse>(wf(id, "/advance"), {}, signal);
}

export function submitStep(id: string, req: SubmitRequest, signal?: AbortSignal): Promise<SubmitResponse> {
  return post<SubmitResponse>(wf(id, "/submit"), req, signal);
}

export function confirmStep(id: string, req: ConfirmRequest, signal?: AbortSignal): Promise<ConfirmResponse> {
  return post<ConfirmResponse>(wf(id, "/confirm"), req, signal);
}
