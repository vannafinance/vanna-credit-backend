/** User-facing normalization for wallet, Solana RPC, and Anchor program errors. */
import { VANNA_PROGRAM_ID, JUPITER_V6_PROGRAM_ID } from "@/lib/solana/config";

const VANNA_ID = VANNA_PROGRAM_ID.toBase58();
const JUPITER_ID = JUPITER_V6_PROGRAM_ID.toBase58();

const PROGRAM_ERRORS = [
  "Signer is not authorized to perform this action", "Signer is not the pending admin",
  "Treasury address is invalid", "Operating mode is invalid", "This action is currently paused",
  "This action is not allowed for the reserve", "An account does not match the expected PDA",
  "An account bump is invalid", "The asset mint is invalid", "The token program is invalid",
  "The vault authority is invalid", "The share mint authority is invalid",
  "Token-2022 extensions are not supported", "This asset is not enabled as collateral",
  "This asset is not enabled for borrowing", "The reserve supply cap would be exceeded",
  "The margin collateral cap would be exceeded", "The reserve borrow cap would be exceeded",
  "The reserve does not have enough available liquidity", "The margin account does not have enough collateral",
  "The lender does not have enough vault shares", "The result exceeded the selected slippage limit",
  "The margin account already has the maximum number of active assets", "The asset is already active",
  "Required collateral or debt accounts are missing", "The oracle account owner is invalid",
  "The oracle price feed does not match this asset", "The oracle price is stale; wait for a fresh update and retry",
  "The oracle returned an invalid price", "The oracle confidence interval is too wide",
  "The requested borrow would make the health factor unsafe", "This position is healthy and cannot be liquidated",
  "The repay amount exceeds the liquidation close factor", "The margin account still has outstanding debt",
  "The margin account still has open positions", "The calculation overflowed", "The calculation underflowed",
  "The calculation attempted to divide by zero", "The on-chain clock moved backwards",
  "The reserve accounting invariant failed", "Amount must be greater than zero",
  "The transaction contains duplicate role accounts", "This reserve is already registered",
  "The risk parameters are invalid", "The interest-rate model is invalid",
  "The amount is below the minimum initial supply", "The collateral position is not empty",
  "The debt position is not empty", "The collateral vault is not empty",
] as const;

const compact = (raw: string | undefined) => (raw ?? "").replace(/\s+/g, " ").trim();
const isCancel = (text: string) => ["user rejected", "rejected by user", "user denied", "user declined", "cancelled", "canceled"]
  .some((needle) => text.includes(needle));
/** Wallet / fee shortfalls only — not program strings like "does not have enough liquidity". */
const isWalletInsufficient = (text: string) =>
  text.includes("insufficient funds") ||
  text.includes("insufficient lamports") ||
  text.includes("insufficient sol") ||
  text.includes("attempt to debit an account but found no record of a prior credit") ||
  (text.includes("insufficient") && (text.includes("wallet") || text.includes("balance") || text.includes("fee")));
const isInsufficient = (text: string) =>
  isWalletInsufficient(text) ||
  ((text.includes("insufficient") || text.includes("not enough")) && !text.includes("liquidity") && !text.includes("collateral") && !text.includes("vault shares"));

/**
 * Which program actually raised a "custom program error" code, plus the
 * code itself. A composite transaction CPIs into several programs (Jupiter,
 * Kamino, ...) that each define their OWN 6000-series error enum — the same
 * numeric code can mean something completely unrelated depending on which
 * program threw it (e.g. Vanna's 6001 is "Signer is not the pending admin";
 * Jupiter's 6001 is "SlippageToleranceExceeded"). Full simulation logs are
 * chronological and a CPI failure propagates outward, so later "Program
 * <outer> failed: custom program error: <same code>" lines are just echoes
 * of the same value under Vanna's own program ID — the FIRST such line in
 * the text is always the innermost, true origin.
 */
function failingProgram(text: string): { programId: string; code: number } | null {
  const match = text.match(/Program\s+([1-9A-HJ-NP-Za-km-z]{32,44})\s+failed:\s*custom program error:\s*(0x[0-9a-f]+|\d+)/i);
  if (match) return { programId: match[1], code: Number.parseInt(match[2], 16) || Number(match[2]) };
  const named = text.match(/error number:\s*(\d+)/i);
  if (named) return { programId: VANNA_ID, code: Number(named[1]) };
  // No program-ID context at all (e.g. a bare simulation error) — assume
  // it's Vanna's own, since that is the only case this pattern used to cover.
  const hex = text.match(/custom program error:\s*0x([0-9a-f]+)/i);
  if (hex) return { programId: VANNA_ID, code: Number.parseInt(hex[1], 16) };
  const decimal = text.match(/custom program error:\s*(\d+)/i);
  return decimal ? { programId: VANNA_ID, code: Number(decimal[1]) } : null;
}

/** Only meaningful for codes attributed to Vanna's own program — see `failingProgram`. */
function anchorCode(text: string): number | null {
  const failure = failingProgram(text);
  return failure && failure.programId === VANNA_ID ? failure.code : null;
}

const JUPITER_ERRORS: Record<number, string> = {
  6001: "The swap's price moved beyond your slippage tolerance before it executed",
  6000: "No swap route was available for this pair",
};

function programMessage(text: string): string | null {
  const failure = failingProgram(text);
  if (!failure) return null;
  const { programId, code } = failure;
  if (programId === VANNA_ID) {
    const message = PROGRAM_ERRORS[code - 6000];
    return message ? `${message} (program error ${code}).` : `The program rejected the transaction (error ${code}).`;
  }
  if (programId === JUPITER_ID) {
    const message = JUPITER_ERRORS[code];
    return message ? `${message}. Please retry.` : `The swap route rejected the transaction (Jupiter error ${code}). Please retry.`;
  }
  return `A dependent program rejected the transaction (error ${code}).`;
}

function common(raw: string | undefined, fallback: string): string {
  const text = compact(raw);
  if (!text) return fallback;
  const lower = text.toLowerCase();
  if (isCancel(lower)) return "Transaction cancelled by user.";
  // Backpack's own injected provider throws this internal error (instead of opening its
  // unlock popup) when the extension is locked and asked to sign — a known Backpack quirk,
  // not something this app's own code can trigger the popup around. Solflare/Phantom
  // reliably self-prompt instead, so this is worth naming Backpack specifically.
  if (lower.includes("userkeyring not found") || (lower.includes("invariant violation") && lower.includes("keyring")))
    return "Your Backpack wallet is locked. Please open the Backpack extension, enter your password to unlock it, then retry.";
  if (lower.includes("block height exceeded") || lower.includes("blockhash not found") || lower.includes("transactionexpired"))
    return "The transaction expired before confirmation. Please retry; a fresh blockhash will be used.";
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests"))
    return "Solana RPC is temporarily rate-limited. Please wait a moment and retry.";
  // CPI programs have their own error-number namespaces. Prefer their actual
  // Anchor message over interpreting every 6000-series code as a Vanna error.
  const anchorMessage = text.match(/Error Message: (.*?)(?:Program [1-9A-HJ-NP-Za-km-z]{32,44} |$)/i);
  if (anchorMessage) return anchorMessage[1].trim();
  if (/computationalbudgetexceeded|comput(e|ational).*budget.*exceeded|exceeded.*c[ou]mpute|exceeded CUs meter/i.test(text))
    return "Transaction exceeded its compute budget. Please retry with the updated transaction builder.";
  // A generic Solana runtime failure inside a called program (most often a stack/compute
  // overrun or an unhandled panic several CPI hops deep, e.g. inside Kamino's own klend
  // program) — there's no clean Anchor "Error Message:" line to extract for this one, and
  // dumping the raw simulation log (which can run to hundreds of lines) is not
  // user-facing. A retry is the right next step either way: fork account state that
  // caused a transient panic often resolves itself, and a real compute shortfall needs
  // the same "try again" action from the user regardless of which program tripped it.
  if (lower.includes("programfailedtocomplete") || lower.includes("program failed to complete"))
    return "The transaction failed inside a program it called (this can be a transient issue on a forked network). Please retry — if it keeps happening, let support know.";
  const mapped = programMessage(text);
  if (mapped) return mapped;
  if (lower.includes("simulation failed")) return text.length > 700 ? `${text.slice(0, 700)}…` : text;
  if (lower.includes("signature verification failed")) return "Wallet signature verification failed. Please reconnect and retry.";
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

export const normalizeContractError = (raw: string | undefined, fallback = "Transaction failed. Please try again.") => common(raw, fallback);

export function normalizeSupplyError(raw: string | undefined, asset: string): string {
  if (isInsufficient(compact(raw).toLowerCase())) return `Insufficient ${asset} balance for this supply.`;
  return common(raw, `Failed to supply ${asset}. Please try again.`);
}

export function normalizeWithdrawError(raw: string | undefined, asset: string): string {
  if (isInsufficient(compact(raw).toLowerCase())) return `Insufficient v${asset} shares for this withdrawal.`;
  return common(raw, `Failed to withdraw ${asset}. Please try again.`);
}

export function normalizeDepositCollateralError(raw: string | undefined): string {
  const text = compact(raw);
  const lower = text.toLowerCase();
  // Prefer mapped program errors (e.g. "does not have enough available liquidity")
  // over the generic wallet-fee toast — those used to false-match on "not enough".
  const mapped = programMessage(text);
  if (mapped) return mapped;
  if (isWalletInsufficient(lower)) {
    return "Insufficient wallet balance for this deposit. Keep enough SOL for transaction fees.";
  }
  return common(raw, "Deposit and borrow failed. Please try again.");
}

export function normalizeTransferCollateralError(
  raw: string | undefined,
  asset: string,
  opts: { maxSafe?: number; isFullWithdraw?: boolean; maxExecutableWithdraw?: number; solBuffer?: number } = {},
): string {
  const text = compact(raw);
  const lower = text.toLowerCase();
  if (lower.includes("health") || anchorCode(text) === 6030) {
    return typeof opts.maxSafe === "number" && opts.maxSafe > 0
      ? `Withdrawal blocked by risk limits. Max transferable now: ${opts.maxSafe.toFixed(2)} ${asset}.`
      : "Withdrawal blocked by risk limits. Repay some debt first.";
  }
  if (isInsufficient(lower)) return `Insufficient ${asset} collateral for this transfer.`;
  return common(raw, "Transfer failed. Please try again.");
}

export function normalizeRepayError(raw: string | undefined, asset: string): string {
  const text = compact(raw);
  if (isInsufficient(text.toLowerCase()) || anchorCode(text) === 6019)
    return `Insufficient ${asset} balance in the margin account to repay this amount.`;
  return common(raw, "Repay failed. Please try again.");
}

export function normalizeCreateAccountError(raw: string): string {
  const lower = compact(raw).toLowerCase();
  if (lower.includes("account not found") || isInsufficient(lower) || lower.includes("fee"))
    return "Wallet does not have enough SOL for the transaction fee. Use the Faucet and retry.";
  return common(raw, "Failed to create margin account. Please try again.");
}
