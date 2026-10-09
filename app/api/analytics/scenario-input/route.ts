import { jsonResponse } from "@/lib/solana/server/json";
import { readSnapshot } from "@/lib/analytics/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/scenario-input — the verified baseline the What-if Calculator runs on: the
 * collateral and debt lines of every account that could be valued, plus the ones left out and why.
 * Fetched only when the calculator opens. The calculator itself runs in the browser and writes nothing.
 */
export async function GET() {
  const { snapshot, state } = readSnapshot();
  if (!snapshot) return jsonResponse({ state, baseline: null });
  const covered = snapshot.rows.filter((r) => r.valued && !r.venueHeld);
  return jsonResponse({
    state,
    baseline: {
      asOf: snapshot.asOf,
      forkTime: snapshot.forkTime,
      coverage: snapshot.coverage,
      covered: covered.map((r) => ({ owner: r.owner, address: r.address, collateral: r.collateral, debts: r.debts, collateralUsd: r.collateralUsd, debtUsd: r.debtUsd })),
      excluded: snapshot.rows.filter((r) => !(r.valued && !r.venueHeld)).map((r) => ({ owner: r.owner, address: r.address, reasons: r.reasons, venueHeld: r.venueHeld })),
    },
  });
}
