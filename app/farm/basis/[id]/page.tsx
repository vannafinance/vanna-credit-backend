"use client";

/** Live delta-neutral vault page (V3 design): see components/farm/basis/basis-vault.tsx. */
import { useParams } from "next/navigation";
import { BasisVaultPage } from "@/components/farm/basis/basis-vault";

export default function BasisVaultRoute() {
  const params = useParams();
  return <BasisVaultPage id={(params?.id as string) ?? ""} />;
}
