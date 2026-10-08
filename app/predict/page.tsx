import type { Metadata } from "next";
import { PredictList } from "@/components/predict/predict-list";

export const metadata: Metadata = { title: "Predict" };

/** Predict (BETA) — UI-only preview: sample events, in-memory interactions, no transactions. */
export default function PredictPage() {
  return <PredictList />;
}
