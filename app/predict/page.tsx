import type { Metadata } from "next";
import { PredictList } from "@/components/predict/predict-list";

export const metadata: Metadata = { title: "Predict" };

/** Predict: World.xyz prediction markets on the fork, with shares earning in Vanna's USDC pool. */
export default function PredictPage() {
  return <PredictList />;
}
