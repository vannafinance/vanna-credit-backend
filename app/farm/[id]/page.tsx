"use client";

/**
 * /farm/:id — V3 Kamino vault page (supply from the margin account, withdraw, details).
 * See components/farm/kamino-vault.tsx.
 */
import { useParams } from "next/navigation";
import { KaminoVault } from "@/components/farm/kamino-vault";

export default function FarmDetailPage() {
  const params = useParams();
  return <KaminoVault id={(params?.id as string) ?? ""} />;
}
