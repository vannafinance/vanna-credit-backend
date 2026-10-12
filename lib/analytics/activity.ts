/**
 * Plain-language wording for one margin-account history row (decoded from the program's own events by
 * lib/solana/history). Pure: no fetching, nothing invented - a row that has no amount says only what happened.
 */
import type { MarginHistoryRow } from "@/lib/solana/history";

export type ActivityTone = "ok" | "warn" | "danger" | "accent" | "neutral";

export interface ActivityItem {
  signature: string;
  /** Unix seconds. */
  time: number;
  type: MarginHistoryRow["type"];
  title: string;
  detail: string;
  tone: ActivityTone;
  /** Health factor reported by the program after the action, when it reports one. */
  healthFactor: number | null;
}

const pretty = (v: string): string => {
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : v;
};
const amt = (r: MarginHistoryRow) => (r.symbol && r.amount && Number(r.amount.replace(/,/g, "")) !== 0 ? `${pretty(r.amount)} ${r.symbol}` : r.symbol || "");

export function describeActivity(r: MarginHistoryRow): ActivityItem {
  const a = amt(r);
  let title: string, detail = a, tone: ActivityTone = "neutral";
  switch (r.type) {
    case "create": title = "Margin account opened"; detail = ""; tone = "accent"; break;
    case "deposit": title = "Deposited"; detail = a ? `${a} as collateral` : "collateral"; tone = "ok"; break;
    case "withdraw": title = "Withdrew"; detail = a ? `${a} of collateral` : "collateral"; tone = "warn"; break;
    case "borrow": title = "Borrowed"; tone = "warn"; break;
    case "repay": title = "Repaid"; tone = "ok"; break;
    case "liquidation": title = "Liquidated"; detail = a ? `${a} of collateral seized` : ""; tone = "danger"; break;
    case "open-debt": title = "Opened a debt position"; break;
    case "close-debt": title = "Closed a debt position"; break;
    case "close-collateral": title = "Closed a collateral position"; break;
    case "swap": title = "Swapped"; detail = `${a}${r.toSymbol ? ` for ${r.toAmount ? `${pretty(r.toAmount)} ` : ""}${r.toSymbol}` : ""}${r.via ? ` via ${r.via}` : ""}`; break;
    case "farm-deposit": title = "Deposited to Kamino"; tone = "ok"; break;
    case "farm-withdraw": title = "Withdrew from Kamino"; break;
    case "perp-open": title = "Funded Phoenix perps"; break;
    case "perp-order": title = "Phoenix perps order"; detail = ""; break;
    case "perp-settle": title = "Settled Phoenix perps"; break;
    default: title = "Account activity"; detail = ""; break;
  }
  return { signature: r.signature, time: Math.floor(r.timestamp / 1000), type: r.type, title, detail: detail.trim(), tone, healthFactor: r.healthFactor ?? null };
}
