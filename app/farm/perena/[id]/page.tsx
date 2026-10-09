"use client";

/**
 * Live Perena vault page (V3 design): see components/farm/perena/perena-vault.tsx.
 * `?action=deposit|withdraw` opens the action panel on that tab (the Farm list's card buttons).
 */
import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { PerenaVaultPage } from "@/components/farm/perena/perena-vault";

function Route() {
  const params = useParams();
  const action = useSearchParams()?.get("action");
  return <PerenaVaultPage key={action ?? "deposit"} id={(params?.id as string) ?? ""} initial={action === "withdraw" ? "withdraw" : "deposit"} />;
}

export default function PerenaVaultRoute() {
  return (
    <Suspense>
      <Route />
    </Suspense>
  );
}
