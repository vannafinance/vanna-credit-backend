"use client";

/** Live delta-neutral vault state and margin-account transactions. */
import { useParams } from "next/navigation";
import { LiveVaultPage } from "@/components/farm/live-vault-page";

export default function BasisVaultRoute() {
  const params = useParams();
  return <LiveVaultPage id={`basis-${(params?.id as string) ?? ""}`} />;
}
