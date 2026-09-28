/**
 * Exact client-side ports of the on-chain math in
 * `vanna-credit-layer/programs/vanna_lending/src/math/{interest,shares,health}.rs`.
 * Everything runs on bigint so projected debt / shares match the program to the unit.
 */

export const WAD = 1_000_000_000_000_000_000n;
const HALF_WAD = WAD / 2n;
export const BASIS_POINTS = 10_000n;
/** Average Gregorian year (365.2425 days) — the annualization basis of the borrow-rate curve. */
export const SECONDS_PER_YEAR = 31_556_952n;
/** Internal USD precision (nano-USD). */
export const USD_VALUE_DECIMALS = 9;
/** healthy = collateral / debt > 1.10 (equality is unhealthy). */
export const BALANCE_TO_BORROW_THRESHOLD_WAD = 1_100_000_000_000_000_000n;
/** Minimum first-deposit shares (first-depositor inflation guard). */
export const MIN_INITIAL_SHARES = 1_000n;

export interface RateCurve {
  linearCoeffWad: bigint;
  jumpCoeffWad: bigint;
  rateMultiplierWad: bigint;
}

/** The reserve fields the math needs (decoded Reserve account, bigint-normalised). */
export interface ReserveMathState {
  accountedLiquidityAssets: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  borrowIndexWad: bigint;
  accruedProtocolFees: bigint;
  lastUpdateTimestamp: bigint;
  reserveFactorBps: bigint;
  rateCurve: RateCurve;
}

export function mulDivFloor(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("mulDivFloor: division by zero");
  return (a * b) / denominator;
}

export function mulDivCeil(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("mulDivCeil: division by zero");
  const product = a * b;
  return product === 0n ? 0n : (product + denominator - 1n) / denominator;
}

/**
 * Utilization rate: the share of the pool's assets currently lent out, as a WAD fraction.
 *
 * utilization = total_borrows / (liquidity + total_borrows)        (0 when the pool is empty)
 */
export function utilizationWad(accountedLiquidityAssets: bigint, totalBorrowAssets: bigint): bigint {
  const gross = accountedLiquidityAssets + totalBorrowAssets;
  if (gross === 0n) return 0n;
  return mulDivFloor(totalBorrowAssets, WAD, gross);
}

/** `base^exp` for a WAD-scaled `base`, by square-and-multiply with each step rounded half-up. */
function wadPow(base: bigint, exp: number): bigint {
  const wadMulRound = (a: bigint, b: bigint) => (a * b + HALF_WAD) / WAD;
  if (base === 0n) return exp === 0 ? WAD : 0n;
  let result = exp % 2 === 1 ? base : WAD;
  let e = Math.floor(exp / 2);
  let b = base;
  while (e > 0) {
    b = wadMulRound(b, b);
    if (e % 2 === 1) result = wadMulRound(result, b);
    e = Math.floor(e / 2);
  }
  return result;
}

/**
 * Borrow interest rate per second (WAD) at utilization `u`.
 *
 * borrow_rate = rate_multiplier * (u * linear_coeff + u^32 * linear_coeff + u^64 * jump_coeff) / SECONDS_PER_YEAR
 */
export function borrowRatePerSecondWad(curve: RateCurve, utilWad: bigint): bigint {
  const linearTerm = mulDivFloor(utilWad, curve.linearCoeffWad, WAD);
  const steepTerm = mulDivFloor(wadPow(utilWad, 32), curve.linearCoeffWad, WAD);
  const jumpTerm = mulDivFloor(wadPow(utilWad, 64), curve.jumpCoeffWad, WAD);
  const polynomial = linearTerm + steepTerm + jumpTerm;
  return mulDivFloor(curve.rateMultiplierWad, polynomial, SECONDS_PER_YEAR * WAD);
}

/**
 * Annual borrow rate (fraction, e.g. 0.052 = 5.2%) at utilization `u`, straight from the
 * curve: annual = multiplier × (linear × (u + u^32) + jump × u^64). Computed from the
 * per-second rate the program actually accrues with, so the display matches accrual.
 */
export function annualBorrowRate(curve: RateCurve, utilWad: bigint): number {
  const perSecond = borrowRatePerSecondWad(curve, utilWad);
  return Number((perSecond * SECONDS_PER_YEAR * 1_000_000_000n) / WAD) / 1e9;
}

/**
 * Annual supply rate: borrow rate × utilization × (1 − reserve_factor).
 */
export function annualSupplyRate(curve: RateCurve, utilWad: bigint, reserveFactorBps: bigint): number {
  const borrow = annualBorrowRate(curve, utilWad);
  const u = Number((utilWad * 1_000_000_000n) / WAD) / 1e9;
  const keep = 1 - Number(reserveFactorBps) / Number(BASIS_POINTS);
  return borrow * u * keep;
}

export interface AccrualResult {
  newTotalBorrowAssets: bigint;
  newAccruedProtocolFees: bigint;
  newBorrowIndexWad: bigint;
  interestAccrued: bigint;
}

/**
 * Brings a reserve's debt current to `now` (the fork Clock's unix_timestamp — never Date.now()).
 *
 * growth         = borrow_rate * elapsed_seconds
 * interest       = ceil(total_borrows * growth)                  (rounded in lenders' favor)
 * protocol_fee   = floor(interest * reserve_factor_bps / 10_000)
 * total_borrows' = total_borrows + interest
 * borrow_index'  = borrow_index * total_borrows' / total_borrows
 */
export function accrue(reserve: ReserveMathState, now: bigint): AccrualResult {
  let elapsed = now - reserve.lastUpdateTimestamp;
  // The program errors on a timestamp regression; client-side we just don't project backwards.
  if (elapsed < 0n) elapsed = 0n;
  if (elapsed === 0n || reserve.totalBorrowAssets === 0n) {
    return {
      newTotalBorrowAssets: reserve.totalBorrowAssets,
      newAccruedProtocolFees: reserve.accruedProtocolFees,
      newBorrowIndexWad: reserve.borrowIndexWad,
      interestAccrued: 0n,
    };
  }
  const util = utilizationWad(reserve.accountedLiquidityAssets, reserve.totalBorrowAssets);
  const ratePerSecond = borrowRatePerSecondWad(reserve.rateCurve, util);
  const growthWad = ratePerSecond * elapsed;
  const interest = mulDivCeil(reserve.totalBorrowAssets, growthWad, WAD);
  const protocolFee = mulDivFloor(interest, reserve.reserveFactorBps, BASIS_POINTS);
  const newTotalBorrowAssets = reserve.totalBorrowAssets + interest;
  let newBorrowIndexWad = mulDivFloor(reserve.borrowIndexWad, newTotalBorrowAssets, reserve.totalBorrowAssets);
  if (newBorrowIndexWad < WAD) newBorrowIndexWad = WAD;
  return {
    newTotalBorrowAssets,
    newAccruedProtocolFees: reserve.accruedProtocolFees + protocolFee,
    newBorrowIndexWad,
    interestAccrued: interest,
  };
}

/** Returns a copy of the reserve with interest accrued to `now`. */
export function projectReserve<T extends ReserveMathState>(reserve: T, now: bigint): T {
  const a = accrue(reserve, now);
  return {
    ...reserve,
    totalBorrowAssets: a.newTotalBorrowAssets,
    accruedProtocolFees: a.newAccruedProtocolFees,
    borrowIndexWad: a.newBorrowIndexWad,
    lastUpdateTimestamp: now > reserve.lastUpdateTimestamp ? now : reserve.lastUpdateTimestamp,
  };
}

// ---------------------------------------------------------------------------------------------
// shares.rs
// ---------------------------------------------------------------------------------------------

/** lender_total_assets = liquidity + total_borrows - accrued_protocol_fees */
export function lenderTotalAssets(r: Pick<ReserveMathState, "accountedLiquidityAssets" | "totalBorrowAssets" | "accruedProtocolFees">): bigint {
  return r.accountedLiquidityAssets + r.totalBorrowAssets - r.accruedProtocolFees;
}

/** available_cash = max(liquidity - accrued_protocol_fees, 0) */
export function availableLenderCash(r: Pick<ReserveMathState, "accountedLiquidityAssets" | "accruedProtocolFees">): bigint {
  const v = r.accountedLiquidityAssets - r.accruedProtocolFees;
  return v > 0n ? v : 0n;
}

/** shares = floor(assets * total_supply_shares / lender_total_assets)   (1:1 for the first deposit) */
export function assetsToSupplySharesDown(assets: bigint, totalShareSupply: bigint, lenderTotalAssetsBefore: bigint): bigint {
  if (totalShareSupply === 0n || lenderTotalAssetsBefore === 0n) return assets;
  return mulDivFloor(assets, totalShareSupply, lenderTotalAssetsBefore);
}

/** assets = floor(shares * lender_total_assets / total_supply_shares) */
export function supplySharesToAssetsDown(shares: bigint, totalShareSupply: bigint, lenderTotal: bigint): bigint {
  if (totalShareSupply === 0n) return 0n;
  return mulDivFloor(shares, lenderTotal, totalShareSupply);
}

/** Inverse of supplySharesToAssetsDown, rounded up: shares needed to receive `assets`. */
export function assetsToSupplySharesUp(assets: bigint, totalShareSupply: bigint, lenderTotal: bigint): bigint {
  if (lenderTotal === 0n) return 0n;
  return mulDivCeil(assets, totalShareSupply, lenderTotal);
}

/** borrow_shares = ceil(assets * total_borrow_shares / total_borrows)   (1:1 for the first borrow) */
export function assetsToDebtSharesUp(assets: bigint, totalBorrowShares: bigint, totalBorrowAssets: bigint): bigint {
  if (totalBorrowShares === 0n || totalBorrowAssets === 0n) return assets;
  return mulDivCeil(assets, totalBorrowShares, totalBorrowAssets);
}

/** debt = ceil(borrow_shares * total_borrows / total_borrow_shares) */
export function debtSharesToAssetsUp(borrowShares: bigint, totalBorrowShares: bigint, totalBorrowAssets: bigint): bigint {
  if (totalBorrowShares === 0n) return 0n;
  return mulDivCeil(borrowShares, totalBorrowAssets, totalBorrowShares);
}

// ---------------------------------------------------------------------------------------------
// health.rs
// ---------------------------------------------------------------------------------------------

/**
 * USD value of a raw token amount, in nano-USD.
 * value = token_amount * price * 10^(price_exponent - token_decimals + USD_VALUE_DECIMALS)
 * Round collateral down, debt up.
 */
export function normalizeTokenValue(amount: bigint, price: bigint, exponent: number, decimals: number, roundUp: boolean): bigint {
  if (price <= 0n) throw new Error("invalid price");
  const base = amount * price;
  const netExp = exponent - decimals + USD_VALUE_DECIMALS;
  if (netExp >= 0) return base * 10n ** BigInt(netExp);
  const factor = 10n ** BigInt(-netExp);
  return roundUp ? (base + factor - 1n) / factor : base / factor;
}

/** health_factor = collateral * WAD / debt (null = infinite, no debt). */
export function healthFactorWad(collateralNanoUsd: bigint, debtNanoUsd: bigint): bigint | null {
  if (debtNanoUsd === 0n) return null;
  return mulDivFloor(collateralNanoUsd, WAD, debtNanoUsd);
}

// ---------------------------------------------------------------------------------------------
// unit helpers
// ---------------------------------------------------------------------------------------------

/** Exact decimal-string → raw base units (no float). Truncates extra fraction digits. */
export function toRaw(amount: string | number, decimals: number): bigint {
  const text = typeof amount === "number" ? numberToPlainString(amount) : amount.trim();
  if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") throw new Error(`Invalid amount "${amount}"`);
  const [whole, fraction = ""] = text.split(".");
  const raw = `${whole || "0"}${fraction.padEnd(decimals, "0").slice(0, decimals)}`.replace(/^0+(?=\d)/, "");
  return BigInt(raw || "0");
}

/** Raw base units → exact decimal string (trailing zeros trimmed). */
export function fromRaw(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Raw → JS number (display only). */
export function rawToNumber(raw: bigint, decimals: number): number {
  return Number(fromRaw(raw, decimals));
}

/** Avoids scientific notation for small/large floats before decimal parsing. */
function numberToPlainString(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid amount ${value}`);
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

/** WAD bigint → JS number. */
export function wadToNumber(wad: bigint): number {
  return Number((wad * 1_000_000n) / WAD) / 1e6;
}
