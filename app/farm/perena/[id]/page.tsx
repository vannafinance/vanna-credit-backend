"use client";
import { useParams } from "next/navigation";
import { LiveVaultPage } from "@/components/farm/live-vault-page";
export default function PerenaVaultRoute() {
  const params = useParams();
  return <LiveVaultPage id={`perena-${params?.id ?? ""}`} />;
}
