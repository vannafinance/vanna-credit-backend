import { CTOKEN_DECIMALS, receiptsForUnderlying, type ReserveRate } from "@/lib/solana/kamino";
import { fromRaw, toRaw } from "@/lib/solana/math";

/** Estimated receipt units for this deposit, rounded down using the reserve's on-chain rate. */
export function receiptPreview(rate: ReserveRate | undefined, amount: string): string | null {
  if (!rate || rate.totalLiquidity <= 0n || rate.collateralSupply <= 0n || (!/^\d*\.?\d*$/.test(amount) || !/\d/.test(amount))) return null;
  const underlying = toRaw(amount, rate.liquidityDecimals);
  if (underlying <= 0n) return null;
  return fromRaw(receiptsForUnderlying(rate, underlying), CTOKEN_DECIMALS);
}
