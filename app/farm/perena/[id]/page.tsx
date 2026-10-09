"use client";

/** Live Perena vault page (V3 design): see components/farm/perena/perena-vault.tsx. */
import { useParams } from "next/navigation";
import { PerenaVaultPage } from "@/components/farm/perena/perena-vault";

export default function PerenaVaultRoute() {
  const params = useParams();
  return <PerenaVaultPage id={(params?.id as string) ?? ""} />;
}
