import { NextResponse } from "next/server";

import { clearSessionCookie } from "@/lib/copilot/auth";
import type { SessionResponse } from "@/lib/copilot/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json<SessionResponse>({ authenticated: false }, { headers: { "Cache-Control": "no-store" } });
  res.headers.append("Set-Cookie", clearSessionCookie());
  return res;
}
