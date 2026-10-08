"use client";

/**
 * /farm/basis/:id — delta-neutral (basis) vault page. UI preview with sample vault data; no
 * transactions. See components/farm/basis/basis-vault.tsx.
 */
import { useParams } from "next/navigation";
import { BasisVaultPage } from "@/components/farm/basis/basis-vault";

export default function BasisVaultRoute() {
  const params = useParams();
  return <BasisVaultPage id={(params?.id as string) ?? ""} />;
}
