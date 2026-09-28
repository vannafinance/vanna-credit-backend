"use client";

import { AddressBadge } from "@/components/ui/address-badge";

interface MarginAccountAddressProps {
  /** Margin account PDA address. When null, the component renders nothing. */
  address: string | null;
  className?: string;
  /**
   * Kept for call-site compatibility — the badge always links into the local Surfpool fork via
   * explorer.solana.com's custom-cluster mode (see `explorerUrl` in lib/solana/config).
   */
  network?: "devnet" | "mainnet-beta" | "testnet";
}

/**
 * Thin label wrapper around {@link AddressBadge} for a margin account address.
 * Renders an "Account:"-prefixed, copyable badge with an explorer link, and
 * short-circuits to null when no address is available so callers can mount it
 * unconditionally.
 */
export const MarginAccountAddress = ({
  address,
  className = "",
  network = "mainnet-beta",
}: MarginAccountAddressProps) => {
  if (!address) return null;

  return (
    <AddressBadge
      address={address}
      label="Account:"
      network={network}
      className={className}
    />
  );
};
