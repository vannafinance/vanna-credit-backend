import { redirect } from "next/navigation";
import PerpsClient from "@/components/perps/perps-client";
import { DEFAULT_PERP_PAIR, PERP_PAIRS } from "@/components/perps/perps-format";

export default async function PerpsPairPage({ params }: { params: Promise<{ pair: string }> }) {
  const { pair } = await params;
  const marketKey = PERP_PAIRS[pair.toLowerCase()];
  if (!marketKey) redirect(`/trade/perps/${DEFAULT_PERP_PAIR}`);
  return <PerpsClient marketKey={marketKey} />;
}
