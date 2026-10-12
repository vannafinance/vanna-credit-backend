import { jsonResponse } from "@/lib/solana/server/json";
import { readPredictPools } from "@/lib/predict/pool-analytics.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/analytics/predict-pools - every Predict outcome pool and where its money sits (cached ~20 s server-side). */
export async function GET() {
  try {
    return jsonResponse(await readPredictPools());
  } catch (error) {
    console.warn("Prediction pools read failed:", error instanceof Error ? error.message : error);
    return jsonResponse({ error: "Prediction pools read failed" }, { status: 502 });
  }
}
