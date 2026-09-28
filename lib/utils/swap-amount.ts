/** Default Solana token precision used for % / MAX math when decimals unknown. */
export const TOKEN_DECIMALS = 9;
const DEFAULT_BASE = BigInt(10 ** TOKEN_DECIMALS);
/** Leave 1 base unit on MAX / 100% so transfers never exceed on-chain balance. */
const DEFAULT_MAX_BUFFER_UNITS = BigInt(1);

/** Parse a human token amount string into base units (floor fractional digits). */
export function parseTokenAmountToBaseUnits(
  amount: string,
  decimals = TOKEN_DECIMALS,
): bigint {
  const s = amount.replace(/,/g, "").trim();
  if (!s || s === ".") return BigInt(0);
  const negative = s.startsWith("-");
  const cleaned = negative ? s.slice(1) : s;
  const [whole, frac = ""] = cleaned.split(".");
  const fracPadded = frac.slice(0, decimals).padEnd(decimals, "0");
  const base = BigInt(10 ** decimals);
  const units = BigInt(whole || "0") * base + BigInt(fracPadded || "0");
  return negative ? -units : units;
}

/** @deprecated Prefer parseTokenAmountToBaseUnits — kept for call-site parity. */
export function parseTokenAmountToStroops(
  amount: string,
  decimals = TOKEN_DECIMALS,
): bigint {
  return parseTokenAmountToBaseUnits(amount, decimals);
}

/** Format base units as a human amount (no trailing zeros). */
export function baseUnitsToAmountString(
  units: bigint,
  decimals = TOKEN_DECIMALS,
): string {
  if (units <= BigInt(0)) return "0";
  const base = BigInt(10 ** decimals);
  const whole = units / base;
  const frac = units % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

/** @deprecated Prefer baseUnitsToAmountString */
export function stroopsToAmountString(
  stroops: bigint,
  decimals = TOKEN_DECIMALS,
): string {
  return baseUnitsToAmountString(stroops, decimals);
}

/** Max swappable amount from a balance string (never rounds up). */
export function getMaxSwappableBalance(
  balanceStr: string,
  bufferUnits = DEFAULT_MAX_BUFFER_UNITS,
  decimals = TOKEN_DECIMALS,
): string {
  let units = parseTokenAmountToBaseUnits(balanceStr, decimals);
  if (units > bufferUnits) units -= bufferUnits;
  else units = BigInt(0);
  return baseUnitsToAmountString(units, decimals);
}

/** Amount for a balance % (100% uses the same safe max as MAX button). */
export function amountFromBalancePercent(
  balanceStr: string,
  pct: number,
  bufferUnits = DEFAULT_MAX_BUFFER_UNITS,
  decimals = TOKEN_DECIMALS,
): string {
  let total = parseTokenAmountToBaseUnits(balanceStr, decimals);
  if (pct >= 100) {
    if (total > bufferUnits) total -= bufferUnits;
    else total = BigInt(0);
  } else if (pct > 0) {
    total = (total * BigInt(Math.floor(pct))) / BigInt(100);
  } else {
    total = BigInt(0);
  }
  return baseUnitsToAmountString(total, decimals);
}

/** Floor a JS number to base units and back (avoids float overshoot on MAX). */
export function floorAmountToBaseUnits(
  amount: number,
  decimals = TOKEN_DECIMALS,
): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return BigInt(0);
  const base = Number(10 ** decimals);
  return BigInt(Math.floor(amount * base + 1e-9));
}

export function capAmountToMaxBalance(
  amount: number,
  balanceStr: string,
  bufferUnits = DEFAULT_MAX_BUFFER_UNITS,
  decimals = TOKEN_DECIMALS,
): number {
  const maxStr = getMaxSwappableBalance(balanceStr, bufferUnits, decimals);
  const maxUnits = parseTokenAmountToBaseUnits(maxStr, decimals);
  const reqUnits = floorAmountToBaseUnits(amount, decimals);
  const use = reqUnits > maxUnits ? maxUnits : reqUnits;
  return Number(use) / Number(10 ** decimals);
}
