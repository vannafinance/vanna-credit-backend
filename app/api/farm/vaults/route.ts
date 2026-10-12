import { basisDepositPrices, basisLaunchedAt, sinceLaunchReturn } from "@/lib/solana/server/basis-apy";
import { forkUnixTimestamp, getConnection } from "@/lib/solana/connection";
import { eventApy } from "@/lib/farm/yield";
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
      row.apyHistoryStatus = row.available && !row.stale ? "collecting" : "unavailable";
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
          row.apy7Source = row.apy7 !== null ? "history" : null;
          row.apy30Source = row.apy30 !== null ? "history" : null;
        } catch {
          row.apyHistoryStatus = "unavailable";
        }
      }
      if (id.startsWith("basis-") && row.available && !row.stale && row.sharePriceUsd && (row.navUsd ?? 0) > 1 && (row.apy7 === null || row.apy30 === null)) {
        const points = await basisDepositPrices(VAULTS.find(v => v.id === id)!);
        const current = { at: Date.now(), price: row.sharePriceUsd };
        const seven = eventApy(points, current, 7);
        const thirty = eventApy(points, current, 30);
        if (row.apy7 === null && seven) {
          row.apy7 = seven.value;
          row.apy7Source = "deposit-event";
          row.apy7BaselineAt = seven.baselineAt;
        }
        if (row.apy30 === null && thirty) {
          row.apy30 = thirty.value;
          row.apy30Source = "deposit-event";
          row.apy30BaselineAt = thirty.baselineAt;
        }
      }
      // Basis: realized return since launch (share price from 1.0), raw and un-annualised, with the
      // days behind it. Shown beside the funding estimate until a 7-day baseline exists; never
      // annualised, because a few days on a small NAV make one rebalance cost read as a huge APY.
      if (id.startsWith("basis-") && row.available && row.sharePriceUsd) {
        const def = VAULTS.find((v) => v.id === id)!;
        const [launched, now] = await Promise.all([basisLaunchedAt(def), forkUnixTimestamp(getConnection()).then(Number).catch(() => Math.floor(Date.now() / 1000))]);
        row.launchedAt = launched ? launched * 1000 : null;
        const since = launched ? sinceLaunchReturn(row.sharePriceUsd, now - launched) : null;
        row.returnSinceLaunchPct = since?.returnPct ?? null;
        row.sinceLaunchDays = since?.days ?? null;
      }
      if (row.apy7 !== null) row.apyHistoryStatus = "available";
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
