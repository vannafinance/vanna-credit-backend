/**
 * Read-only check: the batch analytics reader must agree with the site's own per-account
 * `fetchMarginSnapshot` (the figures the Margin page shows). No signatures, no writes, no scanning:
 * it uses the accounts already saved in .local/analytics/state.json plus any wallets you pass.
 *   npx tsx scripts/analytics-parity.ts [maxAccounts] [wallet ...]
 */
import { loadEnvConfig } from "@next/env";
import { readFileSync } from "node:fs";

async function main() {
  loadEnvConfig(process.cwd(), true);
  const { PublicKey } = await import("@solana/web3.js");
  const { loadSharedContext, readAccountRows } = await import("../lib/analytics/server/accounts");
  const { fetchMarginSnapshot } = await import("../lib/solana/margin");
  const { marginPda } = await import("../lib/solana/pdas");

  const limit = Number(process.argv[2] ?? 8);
  const extra = process.argv.slice(3);
  let saved: Array<[string, string]> = [];
  try { saved = JSON.parse(readFileSync(".local/analytics/state.json", "utf8")).registry.margins; } catch { /* no saved scan: only the wallets given */ }
  const pick = [...extra.map((o) => [marginPda(new PublicKey(o)).toBase58(), o] as [string, string]), ...saved.slice(0, limit)];
  const ctx = { ...(await loadSharedContext()), allowStale: true }; // compare arithmetic; freshness is policy
  console.log(`allowed collateral tokens: ${ctx.collateralAssets.map((a) => a.assetIndex).join(",")}`);
  const rows = await readAccountRows(ctx, pick.map(([address, owner]) => ({ address, owner })));
  let bad = 0;
  for (const r of rows) {
    const snap = await fetchMarginSnapshot(new PublicKey(r.owner));
    const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 5e-4)); // two reads a moment apart: prices and the fork clock tick
    // The site's reader values a stale-priced collateral at $0; this one (allowStale) keeps its value, so such accounts differ by design.
    if (snap.stalePrices.length) { console.log(`SKIP ${r.owner.slice(0, 8)}… the site's snapshot has stale prices (${snap.stalePrices.join(",")}): C=${snap.totalCollateralUsd} vs batch ${r.collateralUsd}`); continue; }
    const ok = close(r.collateralUsd, snap.totalCollateralUsd) && close(r.debtUsd, snap.totalDebtUsd) && close(r.healthFactor, snap.healthFactor);
    console.log(`${ok ? "OK  " : "DIFF"} ${r.owner.slice(0, 8)}… batch C=${r.collateralUsd} D=${r.debtUsd} HF=${r.healthFactor} | snapshot C=${snap.totalCollateralUsd} D=${snap.totalDebtUsd} HF=${snap.healthFactor}`);
    if (!ok) bad++;
  }
  console.log(bad ? `${bad} mismatches` : "parity OK");
  process.exitCode = bad ? 1 : 0;
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
