import toast from "react-hot-toast";

const NON_NUMERIC_CHAR_RE = /[^0-9.]/;
// SOL has 9 decimals (lamports); USDC has 6. Accepting 9 here preserves the
// maximum precision and the transaction adapter applies each mint's decimals.
export const AMOUNT_MAX_DECIMALS = 9;
const VALID_AMOUNT_RE = /^[0-9]*\.?[0-9]{0,9}$/;

/**
 * Format a numeric amount for an editable amount field: floor to 9 decimals
 * (never round up past the source max, which would trip a
 * "> max" check / on-chain rounding) and return a clean, trailing-zero-free
 * string. Use for "Max" / percentage presets so they carry full precision and
 * stay editable — not `toFixed(2)`, which truncated real balances to 2dp.
 */
export const floorAmountToInput = (n: number): string =>
  Number.isFinite(n) && n > 0 ? String(Math.floor(n * 1e9) / 1e9) : "";

/**
 * Returns true if `value` is a valid in-progress amount string:
 * empty, or digits with at most one decimal point and at most
 * nine digits after it (SOL's maximum token precision). No letters, no
 * exponent, no sign, no other characters.
 */
export function isValidAmountInput(value: string): boolean {
  if (value === "") return true;
  return VALID_AMOUNT_RE.test(value);
}

/**
 * Validate an amount-input change. If valid, returns the string
 * so callers can pass it to their setter (KEEP it as a string — converting to a
 * Number on each keystroke turns a partial "." into NaN and drops trailing
 * decimals). If invalid, shows a single deduplicated toast and returns null.
 *
 * The toast message is tailored to the failure mode: "Only numbers allowed" for
 * letters/special chars, and a decimal-cap message past 7 fractional digits.
 */
export function validateAmountChange(raw: string): string | null {
  if (isValidAmountInput(raw)) return raw;
  if (NON_NUMERIC_CHAR_RE.test(raw)) {
    toast.error("Only numbers allowed", { id: "amount-input-validation" });
  } else {
    // Numeric but malformed — multi-dot or too many fractional digits.
    toast.error(`Max ${AMOUNT_MAX_DECIMALS} decimal places`, { id: "amount-input-validation" });
  }
  return null;
}

/**
 * Convert a validated decimal amount string to 18-decimal WAD exactly.
 * Keeping this string-based avoids floating-point rounding and preserves the
 * full Solana token precision.
 */
export function decimalAmountToWad(value: string): bigint {
  if (!value || !isValidAmountInput(value) || value === ".") return BigInt(0);
  const [wholeRaw = "0", fractionRaw = ""] = value.split(".");
  const whole = wholeRaw || "0";
  const fraction = fractionRaw.padEnd(18, "0").slice(0, 18);
  return BigInt(whole) * BigInt("1000000000000000000") + BigInt(fraction || "0");
}
