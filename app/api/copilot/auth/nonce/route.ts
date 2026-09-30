import { NextResponse } from "next/server";

import { AuthError, issueNonce } from "@/lib/copilot/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const wallet = new URL(req.url).searchParams.get("wallet") ?? "";
  try {
    return NextResponse.json(await issueNonce(wallet), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    console.error("[copilot/auth/nonce]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "auth_unavailable", message: "Sign-in is temporarily unavailable." }, { status: 503 });
  }
}
