/**
 * Plain-language text for things the code (not the model) decides: failures, refusals, pauses.
 * Numbers are formatted here for display only; they are never parsed back into an amount.
 */

import { MCPError } from "./mcp-client";

export function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Up to 4 decimals, trailing zeros dropped, thousands separators. Takes the MCP's decimal string when it has one. */
export function fmtAmount(v: string | number, symbol?: string): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return symbol ? `${v} ${symbol}` : String(v);
  let s = n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (s === "-0") s = "0"; // a dust-sized negative (interest rounding) must not read "-0"
  return symbol ? `${s} ${symbol}` : s;
}

/** A health factor as a person reads it: a ratio to two decimals, "no debt" when null. */
export function fmtHf(hf: number | null | undefined): string {
  if (hf === undefined) return "unavailable";
  if (hf === null) return "no debt";
  return hf.toFixed(2);
}

export function fmtPct(v: string | number): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `${n.toFixed(2)}%`;
}

/** A Kamino/fraction APY (0.0674) as a percentage string. */
export function fmtFractionPct(v: string | number): string {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return `${(n * 100).toFixed(2)}%`;
}

const SIM_PATTERNS: Array<[RegExp, string]> = [
  [/insufficient funds|InsufficientFunds|0x1\b/i, "Your wallet does not hold enough of that asset (or enough SOL for fees) for this action."],
  [/StalePrice|0x178b|stale_price|price_unavailable/i, "A price feed is stale right now, so the program refuses to use it. Try again in a minute."],
  [/6024|0x1788|stale[_ ]pool|stale[_ ]bin|AccountNotEnoughKeys|\b3005\b/i, "The swap route's pool data looks out of date on this test network, so the route failed its simulation. Try again in a moment, or try a smaller amount."],
  [/SlippageToleranceExceeded|0x1771|6001/i, "The swap price moved past the allowed slippage. Try again for a fresh quote."],
  [/would breach|HealthFactor|0x1790|unhealthy/i, "The action would push the account below the protocol's health limit."],
  [/account_not_found|AccountNotInitialized|3012/i, "You do not have a margin account yet."],
  [/transaction_too_large/i, "That swap route is too large for one transaction. Try a smaller amount."],
  [/asset_not_offered/i, "That asset is not offered for this action."],
  [/insufficient pool liquidity/i, "The pool does not have enough available liquidity for that."],
  [/borrow_cap|supply_cap|cap exceeded/i, "That would exceed the pool's cap."],
];

const RAW_RUNTIME_ERROR = /TransactionError|InstructionError|Custom\(|ProgramFailedToComplete|custom program error|Tagged\(/i;

/** One short human sentence for a failed simulation/MCP error (the raw reason can be a screen of logs). */
export function humanizeFailure(reason: string | null | undefined): string {
  const r = (reason ?? "").trim();
  if (!r) return "The action could not be prepared.";
  for (const [re, text] of SIM_PATTERNS) if (re.test(r)) return text;
  const firstLine = r.split("\n").find((l) => l.trim()) ?? r;
  // A raw runtime error ("TransactionErrorInstructionError((6, Custom(...)))") means nothing to a user.
  if (RAW_RUNTIME_ERROR.test(firstLine)) {
    return "The network rejected this step when it was simulated. Try again in a moment, or try a smaller amount.";
  }
  return firstLine.length > 220 ? `${firstLine.slice(0, 217)}...` : firstLine;
}

export function humanizeMcpError(err: unknown): { code: string; message: string; retryable: boolean } {
  if (err instanceof MCPError) {
    const code = err.code ?? "mcp_error";
    if (code === "account_not_found") return { code, message: "You do not have a margin account yet. Say \"open a margin account\" to create one.", retryable: false };
    if (code === "rate_limited" || err.httpStatus === 429) return { code: "rate_limited", message: "The data service is busy. Try again in a few seconds.", retryable: true };
    if (code === "asset_not_offered") return { code, message: humanizeFailure(err.message), retryable: false };
    if (code === "price_unavailable" || code === "stale_price") return { code, message: "A price is unavailable right now, so I cannot give you a safe number. Try again shortly.", retryable: true };
    if (code === "unpricable_position") return { code, message: "One of the positions on your account cannot be priced right now, so I will not report a partial number.", retryable: true };
    return { code, message: humanizeFailure(err.message), retryable: err.retryable };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "unavailable", message: `I could not reach live data: ${message.slice(0, 160)}`, retryable: true };
}

export const CONCEPTS: Record<string, string> = {
  health_factor:
    "Your health factor (HF) is your margin collateral's USD value divided by your debt's USD value. Above 1.10 the protocol leaves you alone; at or below 1.10 your account can be liquidated. The Copilot keeps every action at 1.15 or above, and with no debt there is no health factor.",
  liquidation:
    "Liquidation is whole-account: when HF falls to 1.10 or below, a liquidator can repay all your debt and take all your collateral. I can tell you whether you are close, but I never execute a liquidation. Repaying debt or adding collateral raises your HF.",
  leverage:
    "Leverage here means borrowing a stable asset (USDC or USDT) against your collateral, swapping it into the asset you want more of, and keeping that as collateral. \"2x\" means exposure of twice your equity. The Copilot sizes it so your health factor stays at or above 1.15 even if the swap fills at its worst allowed price.",
  collateral:
    "Collateral is what you deposit into your margin account (SOL, USDC, USDT, JitoSOL, JupSOL or Kamino receipts). Borrowed funds also sit in the margin account and count as collateral. You can only withdraw collateral while your health factor stays safe.",
  earn:
    "Earn is the Vanna lending pool: supply SOL, USDC or USDT and earn the pool's supply rate, redeemable any time there is available liquidity. It is separate from your margin account.",
  farm:
    "Farm supplies a single asset to Kamino lend from your margin balance and gives you a Kamino receipt token (kSOL, kUSDC, ...) that still counts as collateral. Redeeming converts it back.",
  margin:
    "Your margin account is one account per wallet. You deposit collateral, borrow SOL, USDC or USDT against it, and repay or withdraw. Borrowing is limited by your health factor.",
  general:
    "Vanna on Solana lets you earn on SOL/USDC/USDT, borrow against collateral in a margin account, swap with Jupiter, and farm on Kamino. Everything is built for your own wallet to sign.",
};
