/**
 * Site-wide access gate (Next 16 `proxy.ts`, formerly `middleware.ts`; runs on the Node.js runtime
 * before any route renders). Every request without a valid signed `vanna_access` cookie is stopped
 * here, server-side, so the gate can't be skipped from the browser:
 *
 * - pages → the standalone gate HTML (lib/access-gate/gate-page.ts), status 401, URL unchanged, so
 *   a successful code entry just reloads the page the visitor asked for;
 * - /api/* → `401 { error: "access_required" }`.
 *
 * Always open: POST /api/access (the code check itself), GET /api/copilot/health (uptime probe), Next
 * build assets (/_next/static, /_next/image), and public/ files (logos, coins, favicon …) so the
 * gate page can render. There are no cron or server-to-server callers today; if a scheduler is ever
 * pointed at an endpoint (e.g. an hourly GET /api/farm/vaults for NAV sampling) it must be added to
 * PUBLIC_API_PATHS or send a valid cookie. See docs/ACCESS_GATE.md.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { renderGatePage } from "@/lib/access-gate/gate-page";
import { ACCESS_COOKIE_NAME, isNumericAccessCode, verifyAccessToken } from "@/lib/access-gate/token";

/** API routes reachable without the cookie (exact paths). */
const PUBLIC_API_PATHS = new Set(["/api/access", "/api/copilot/health"]);

/**
 * File extensions served from public/ (and Next metadata files). Non-API paths ending in one of
 * these pass through untouched: they are static assets, never pages, and the gate needs them.
 */
const STATIC_FILE = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|css|js|map|txt|xml|webmanifest|pdf|mp4|webm)$/i;

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname === "/api" || pathname.startsWith("/api/");

  if (isApi ? PUBLIC_API_PATHS.has(pathname) : STATIC_FILE.test(pathname)) {
    return NextResponse.next();
  }

  if (verifyAccessToken(request.cookies.get(ACCESS_COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }

  if (isApi) {
    return NextResponse.json(
      { error: "access_required", message: "Enter the access code at the site root to use this API." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return new NextResponse(
    renderGatePage({ next: pathname + request.nextUrl.search, numeric: isNumericAccessCode() }),
    {
      status: 401,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    },
  );
}

export const config = {
  // Skip Next's own build output and image optimiser outright; everything else (pages, API routes,
  // server functions, public files) reaches proxy() and is sorted out above.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
