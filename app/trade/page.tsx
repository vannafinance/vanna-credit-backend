import { redirect } from "next/navigation";

/** /trade has no page of its own — Spot swap is the only trade surface. */
export default function TradePage() {
  redirect("/trade/spot");
}
