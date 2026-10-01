/**
 * Shared plumbing for the Copilot's POST routes: identity from the signed session cookie only,
 * same-origin + JSON-only (a cookie-authenticated POST must not be forgeable from another site),
 * bounded bodies, and uniform error mapping. Wallet identity is never read from the body.
 */

import { NextResponse } from "next/server";
import { getUser } from "../auth";
import { LimitContentionError } from "../limits";
import type { CopilotUser } from "../types";
import { WorkflowError } from "./types";

const MAX_BODY_BYTES = 24_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser callers and same-origin GET-style fetches omit it
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) throw new HttpError(415, "Send application/json.");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "That request is too large.");
  try {
    const parsed = text ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
}

/** Same-origin check and uniform error mapping, without requiring a session (the chat route answers `needs_login` itself). */
export async function guarded(req: Request, fn: () => Promise<NextResponse | Response>): Promise<NextResponse | Response> {
  try {
    if (!sameOrigin(req)) throw new HttpError(403, "Cross-site requests are not allowed.");
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: "request_rejected", message: e.message }, { status: e.status, headers: e.headers });
    if (e instanceof LimitContentionError) {
      return NextResponse.json(
        { error: "rate_limited", message: `The service is busy. Try again in ${e.retry_after_s}s.`, limit: { kind: "rate", retry_after_s: e.retry_after_s, message: "busy" } },
        { status: 429, headers: { "Retry-After": String(e.retry_after_s) } },
      );
    }
    if (e instanceof WorkflowError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    console.error("[copilot] route failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "internal", message: "Something went wrong on my side. Nothing was sent." }, { status: 500 });
  }
}

/** Runs `fn` for an authenticated, same-origin caller. */
export async function authed(req: Request, fn: (user: CopilotUser) => Promise<NextResponse | Response>): Promise<NextResponse | Response> {
  return guarded(req, async () => {
    const user = await getUser(req);
    if (!user) return NextResponse.json({ error: "needs_login", message: "Sign in with your wallet to continue." }, { status: 401 });
    return fn(user);
  });
}
