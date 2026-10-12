import type { AccountRow, Coverage } from "@/lib/analytics/types";

/** What the last loop saw: the Telegram commands answer from this, never from a fresh chain read. */
export interface BotSnapshot {
  at: number;
  rows: AccountRow[];
  coverage: Coverage;
  /** Wallet balances in UI units, by symbol. */
  wallet: Record<string, string>;
  liquidator: string;
  dryRun: boolean;
}

let latest: BotSnapshot | null = null;

export const setSnapshot = (snapshot: BotSnapshot) => {
  latest = snapshot;
};

export const getSnapshot = (): BotSnapshot | null => latest;
