import { recordNav } from "@/lib/farm/nav-history";
import { NextRequest, NextResponse } from "next/server";
import { VAULTS } from "@/lib/solana/vault-catalogue";
import { readLiveVault, type LiveVault } from "@/lib/solana/vault-state";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const cache = new Map<string, { at: number; row: LiveVault }>();
const pending = new Map<string, Promise<LiveVault>>();
function read(id: string) {
  const saved = cache.get(id);
  if (saved && Date.now() - saved.at < 15_000)
    return Promise.resolve(saved.row);
  const running = pending.get(id);
  if (running) return running;
  const request = readLiveVault(VAULTS.find((v) => v.id === id)!)
    .then(async (row) => {
      if (
        row.available &&
        !row.stale &&
        row.sharePriceUsd &&
        (row.navUsd ?? 0) > 1
      ) {
        try {
          const history = await recordNav(row.id, row.sharePriceUsd);
          row.apy7 = history.apy7;
          row.apy30 = history.apy30;
        } catch {
          /* Durable history can be unavailable without blocking current NAV. */
        }
      }
      cache.set(id, { at: Date.now(), row });
      return row;
    })
    .finally(() => pending.delete(id));
  pending.set(id, request);
  return request;
}
export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (id && !VAULTS.some((v) => v.id === id))
    return NextResponse.json({ error: "Unknown vault" }, { status: 404 });
  return NextResponse.json(
    await Promise.all((id ? [id] : VAULTS.map((v) => v.id)).map(read)),
  );
}
