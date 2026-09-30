import { NextResponse } from "next/server";

import { AuthError, createSession, sessionCookieHeader, verifyLogin } from "@/lib/copilot/auth";
import type { SessionResponse, VerifyRequest } from "@/lib/copilot/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Partial<VerifyRequest> | null;
  if (!body || typeof body.wallet !== "string" || typeof body.message !== "string" || typeof body.signature !== "string") {
    return NextResponse.json({ error: "invalid_request", message: "wallet, message and signature are required." }, { status: 400 });
  }
  try {
    const user = await verifyLogin({ wallet: body.wallet, message: body.message, signature: body.signature });
    const session = createSession(user.wallet);
    const res = NextResponse.json<SessionResponse>(
      { authenticated: true, wallet: user.wallet, expires_at: session.expiresAt },
      { headers: { "Cache-Control": "no-store" } },
    );
    res.headers.append("Set-Cookie", sessionCookieHeader(session));
    return res;
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    console.error("[copilot/auth/verify]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "auth_unavailable", message: "Sign-in is temporarily unavailable." }, { status: 503 });
  }
}
