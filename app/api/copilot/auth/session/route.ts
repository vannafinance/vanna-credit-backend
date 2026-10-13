import { NextResponse } from "next/server";

import { getUser, renewSessionCookie } from "@/lib/copilot/auth";
import type { SessionResponse } from "@/lib/copilot/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getUser(req);
  // Opening the Copilot counts as use: the sign-in is renewed (see renewSessionCookie).
  const renewed = renewSessionCookie(user);
  const body: SessionResponse = user
    ? { authenticated: true, wallet: user.wallet, expires_at: user.expiresAt }
    : { authenticated: false, wallet: null, expires_at: null };
  const res = NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  if (renewed) res.headers.append("Set-Cookie", renewed);
  return res;
}
