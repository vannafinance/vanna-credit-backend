/**
 * Perena's own product copy for the two Perena vaults Vanna integrates (from app.perena.org/earn),
 * plus the logo / banner files in public/logos-v3. USD* Protected is not integrated and not listed.
 */
export interface PerenaInfo {
  /** Who the product is for. */
  audience: string;
  description: string;
  tags: string[];
  /** Icon key (components/v3/icons.tsx) and card banner. */
  icon: string;
  banner: string;
  /** Vanna-specific note on how the integration behaves. */
  vannaNote: string;
}

export const PERENA_TRANSPARENCY_URL = "https://app.perena.org/transparency";

export const PERENA_INFO: Record<string, PerenaInfo> = {
  "perena-usdstar": {
    audience: "For most depositors",
    description: "Deposit your USDC and watch it grow automatically.",
    tags: ["Solana", "No lockup"],
    icon: "USD*",
    banner: "/logos-v3/perena-usdstar-banner.webp",
    vannaNote: "Deposits and withdrawals settle in USDC inside your Vanna margin account; the USD* receipt counts toward its health factor.",
  },
  "perena-junior": {
    audience: "For high risk tolerance depositors",
    description:
      "Earn more in good times, but your capital takes the hit first in bad times. Withdrawal: Instant (1% fee) or 7-day cooldown (0.5% fee).",
    tags: ["Solana", "T+7"],
    icon: "USD* Junior",
    banner: "/logos-v3/perena-junior-banner.webp",
    vannaNote: "Vanna withdraws through Perena's instant path, so every Vanna withdrawal pays the 1% fee (the 7-day cooldown is not used).",
  },
};
