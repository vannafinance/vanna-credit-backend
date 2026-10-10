import { NextResponse } from "next/server";

import { clearSessionCookie, getUser, revokeSessions } from "@/lib/copilot/auth";
import type { SessionResponse } from "@/lib/copilot/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Void the session server-side too (every device of this wallet), not just this browser's cookie.
  const user = await getUser(req);
  if (user) await revokeSessions(user.wallet);
  const res = NextResponse.json<SessionResponse>({ authenticated: false }, { headers: { "Cache-Control": "no-store" } });
  res.headers.append("Set-Cookie", clearSessionCookie());
  return res;
}
