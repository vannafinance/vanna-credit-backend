/**
 * POST /api/access — checks a submitted access code and, when it matches ACCESS_CODE, sets the
 * signed httpOnly `vanna_access` cookie that `proxy.ts` requires on every other request.
 *
 * Accepts JSON `{ code }` (the gate page's script) → `200 { ok: true }` / `401 { ok: false, error }`
 * / `429 { ok: false, error }`, or a classic form post (`code`, `next`; the gate's no-JS path) →
 * 303 redirect to `next` on success, otherwise the gate HTML with an error. Always exempt from the
 * gate (see proxy.ts). Rate limited per IP and per instance (lib/access-gate/rate-limit.ts).
 * See docs/ACCESS_GATE.md.
 */
import { NextResponse } from "next/server";

import { renderGatePage, safeNextPath } from "@/lib/access-gate/gate-page";
import {
  ACCESS_GLOBAL_MAX_ATTEMPTS,
  ACCESS_MAX_ATTEMPTS,
  ACCESS_WINDOW_MS,
  clientIp,
  createRateLimiter,
} from "@/lib/access-gate/rate-limit";
import {
  ACCESS_COOKIE_NAME,
  ACCESS_TTL_SECONDS,
  createAccessToken,
  isNumericAccessCode,
  isValidAccessCode,
} from "@/lib/access-gate/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Module-level so counters survive across requests on this instance.
const perIp = createRateLimiter(ACCESS_MAX_ATTEMPTS, ACCESS_WINDOW_MS);
const allClients = createRateLimiter(ACCESS_GLOBAL_MAX_ATTEMPTS, ACCESS_WINDOW_MS);

const NO_STORE = { "Cache-Control": "no-store" } as const;
const WRONG_CODE = "That code isn’t right. Please try again.";

function setAccessCookie(res: NextResponse) {
  res.cookies.set({
    name: ACCESS_COOKIE_NAME,
    value: createAccessToken(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_TTL_SECONDS,
  });
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  const isForm =
    contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data");

  let code: unknown;
  let next = "/";
  try {
    if (isForm) {
      const form = await req.formData();
      code = form.get("code");
      next = safeNextPath(form.get("next"));
    } else {
      const body = (await req.json()) as { code?: unknown };
      code = body?.code;
    }
  } catch {
    code = undefined;
  }

  const failure = (status: number, error: string, extraHeaders: Record<string, string> = {}) =>
    isForm
      ? new NextResponse(renderGatePage({ error, next, numeric: isNumericAccessCode() }), {
          status,
          headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE, ...extraHeaders },
        })
      : NextResponse.json({ ok: false, error }, { status, headers: { ...NO_STORE, ...extraHeaders } });

  // Count every attempt before checking the code; a correct code clears this IP's counter below.
  const ip = clientIp(req.headers);
  const ipLimit = perIp.hit(ip);
  const globalLimit = allClients.hit("*");
  if (!ipLimit.allowed || !globalLimit.allowed) {
    const retry = Math.max(ipLimit.allowed ? 0 : ipLimit.retryAfterSeconds, globalLimit.allowed ? 0 : globalLimit.retryAfterSeconds);
    const minutes = Math.max(1, Math.ceil(retry / 60));
    return failure(429, `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, {
      "Retry-After": String(retry),
    });
  }

  if (!isValidAccessCode(code)) return failure(401, WRONG_CODE);

  perIp.reset(ip);
  const res = isForm
    ? // Relative Location: req.url's host can be the container's internal address behind Cloud Run.
      new NextResponse(null, { status: 303, headers: { Location: next, ...NO_STORE } })
    : NextResponse.json({ ok: true }, { headers: NO_STORE });
  setAccessCookie(res);
  return res;
}
