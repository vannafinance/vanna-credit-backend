import { NextResponse } from "next/server";

import { getUser } from "@/lib/copilot/auth";
import type { SessionResponse } from "@/lib/copilot/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getUser(req);
  const body: SessionResponse = user
    ? { authenticated: true, wallet: user.wallet, expires_at: user.expiresAt }
    : { authenticated: false, wallet: null, expires_at: null };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
