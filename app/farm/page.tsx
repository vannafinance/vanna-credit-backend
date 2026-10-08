"use client";

/**
 * /farm — V3 Farm screen: Kamino single-asset vaults supplied from the margin account (live data),
 * the account's Kamino positions + history, and the Delta-Neutral preview (sample data, no
 * transactions). See components/farm/farm-list.tsx.
 */
import { FarmList } from "@/components/farm/farm-list";

export default function FarmPage() {
  return <FarmList />;
}
