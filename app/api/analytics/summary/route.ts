import { jsonResponse } from "@/lib/solana/server/json";
import { persistence, readSnapshot } from "@/lib/analytics/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/summary - protocol-wide account aggregates (KPIs, distributions, concentration,
 * collateral/debt by asset) over EVERY account found, with the scan coverage and snapshot age.
 * Served from the server's last snapshot; a request never starts a scan.
 */
export async function GET() {
  const { snapshot, state } = readSnapshot();
  return jsonResponse({
    state,
    asOf: snapshot?.asOf ?? null,
    forkTime: snapshot?.forkTime ?? null,
    coverage: snapshot?.coverage ?? null,
    summary: snapshot?.summary ?? null,
    /** Where the scan state is kept so a restart resumes: firestore | file | memory. */
    persistence: { backend: persistence.backend, restoredAt: persistence.restoredAt, lastSavedAt: persistence.lastSavedAt, error: persistence.lastError },
  });
}
