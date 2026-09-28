import { VANNA_IDL } from "./program";

/**
 * Turns raw Solana/Anchor failures into a short human message while keeping the raw text
 * (including simulation logs) available for debugging.
 */
export class VannaTxError extends Error {
  /** Program logs from the failed simulation, when available. */
  logs: string[];
  /** Anchor error name (e.g. "HealthFactorTooLow") when one could be decoded. */
  code?: string;
  /** Full raw error text (simulation err JSON + logs). */
  raw: string;
  constructor(message: string, opts: { logs?: string[]; code?: string; raw?: string } = {}) {
    super(message);
    this.name = "VannaTxError";
    this.logs = opts.logs ?? [];
    this.code = opts.code;
    this.raw = opts.raw ?? message;
  }
}

type IdlError = { code: number; name: string; msg?: string };
const PROGRAM_ERRORS: IdlError[] = ((VANNA_IDL as unknown as { errors?: IdlError[] }).errors ?? []);
const BY_CODE = new Map(PROGRAM_ERRORS.map((e) => [e.code, e]));
const BY_NAME = new Map(PROGRAM_ERRORS.map((e) => [e.name, e]));

/** Friendlier copy for the errors a user can actually hit. */
const FRIENDLY: Record<string, string> = {
  HealthFactorTooLow: "This would push your health factor to or below 1.10. Reduce the amount.",
  StalePrice: "Oracle price is stale. Prices were refreshed; please retry.",
  InsufficientLiquidity: "The pool does not have enough available liquidity for this amount.",
  InsufficientCollateral: "Your margin account does not hold that much of this asset.",
  IncompletePositionAccounts: "Position accounts were incomplete (the account changed). Please retry.",
  BelowMinimumInitialSupply: "The first supply to a pool must be at least 1,000 base units.",
  SlippageExceeded: "The result moved beyond your slippage bound. Please retry.",
  TooManyAssets: "Your margin account already holds the maximum number of assets.",
  CollateralCapExceeded: "This deposit exceeds the per-account collateral cap for this asset.",
  BorrowCapExceeded: "This borrow exceeds the pool's borrow cap.",
  SupplyCapExceeded: "This supply exceeds the pool's supply cap.",
  ProtocolActionPaused: "This action is currently paused by the protocol.",
  OutstandingDebt: "This position still has outstanding debt.",
  ZeroAmount: "Amount must be greater than zero.",
};

/** Finds the Anchor error in logs / error text and returns `{ name, message }`. */
export function decodeProgramError(text: string): { name: string; message: string } | null {
  const anchor = /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: ([^\n]+?)\.?(?:\n|$)/.exec(text);
  if (anchor) {
    const name = anchor[1];
    return { name, message: FRIENDLY[name] ?? anchor[3] };
  }
  const custom = /custom program error: (0x[0-9a-f]+)/i.exec(text) ?? /"Custom":(\d+)/.exec(text);
  if (custom) {
    const code = custom[1].startsWith("0x") ? parseInt(custom[1], 16) : Number(custom[1]);
    const entry = BY_CODE.get(code);
    if (entry) return { name: entry.name, message: FRIENDLY[entry.name] ?? entry.msg ?? entry.name };
    if (code === 1) return { name: "InsufficientFunds", message: "Insufficient token balance for this transfer." };
  }
  for (const [name, entry] of BY_NAME) {
    if (text.includes(name)) return { name, message: FRIENDLY[name] ?? entry.msg ?? name };
  }
  return null;
}

const USER_REJECTED = /user rejected|rejected the request|user denied|denied by the user|user cancel|4001/i;

/** Short user-facing message for any thrown value. */
export function describeError(error: unknown, fallback = "Transaction failed"): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (!text) return fallback;
  if (USER_REJECTED.test(text)) return "Transaction was rejected in your wallet.";
  if (error instanceof VannaTxError && error.code) return error.message;
  const decoded = decodeProgramError(error instanceof VannaTxError ? error.raw : text);
  if (decoded) return decoded.message;
  if (/insufficient lamports|insufficient funds for fee|Attempt to debit an account but found no record of a prior credit/i.test(text)) {
    return "Not enough SOL to pay for this transaction. Use the faucet to top up.";
  }
  if (/Blockhash not found|block height exceeded/i.test(text)) return "Transaction expired before it landed. Please retry.";
  // First line only — the rest is usually the log dump.
  return text.split("\n")[0].slice(0, 300) || fallback;
}
