import type { Metadata } from "next";
import { PredictEventPage } from "@/components/predict/event-page";

export const metadata: Metadata = { title: "Predict" };

/**
 * Predict (BETA) event page. Route id = `<eventId>[~<marketId>[~yes|no]]`. UI-only preview:
 * keyed by id so arriving on another event resets the panel (Buy, default amount), as the design.
 */
export default async function PredictEventRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PredictEventPage key={id} id={id} />;
}
