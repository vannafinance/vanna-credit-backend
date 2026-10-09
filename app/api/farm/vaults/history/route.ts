/**
 * GET /api/farm/vaults/history?id=basis-eth — the vault's recorded hourly share-price observations
 * (lib/farm/nav-history.ts), oldest first. Points are only ever recorded from real fork reads by
 * GET /api/farm/vaults; an empty list means no history yet, never a reason to sample one.
 */
import { NextRequest, NextResponse } from "next/server";
import { readNav, type NavPoint } from "@/lib/farm/nav-history";
import { VAULTS } from "@/lib/solana/vault-catalogue";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const cache = new Map<string, { at: number; points: NavPoint[] }>();
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!VAULTS.some((v) => v.id === id))
    return NextResponse.json({ error: "Unknown vault" }, { status: 404 });
  const saved = cache.get(id);
  if (saved && Date.now() - saved.at < 60_000)
    return NextResponse.json({ id, points: saved.points });
  try {
    const points = await readNav(id);
    cache.set(id, { at: Date.now(), points });
    return NextResponse.json({ id, points });
  } catch {
    // Durable history can be unavailable (e.g. no store secret locally): report it as empty.
    return NextResponse.json({ id, points: [] });
  }
}
