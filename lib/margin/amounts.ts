/**
 * Pure amount / risk math shared by the margin UI (Leverage, Repay, Transfer tabs, positions
 * table) — and by the verification script that proves this exact math against the fork.
 *
 * Every "max" figure is derived from the account-wide health rule in lib/solana/margin.ts
 * (HF = Σ collateral USD / Σ debt USD, liquidatable at HF <= 1.10) with the UI safety buffer
 * {@link SAFE_HEALTH_FACTOR} (1.15), so the strict on-chain `HF > 1.10` check holds with margin.
 * Borrowed tokens land in the margin vault and COUNT AS COLLATERAL, so a borrow raises both sides
 * of the ratio: projected HF after depositing E and borrowing B = (C + E + B) / (D + B).
 *
 * Nothing here reads the chain or browser storage — callers pass the snapshot / price figures in.
 */
import { SAFE_HEALTH_FACTOR, LIQUIDATION_HEALTH_FACTOR } from "@/lib/solana/config";
import { maxBorrowUsd, maxLeverage, maxLeverageFor, maxWithdrawUsd } from "@/lib/solana/margin";
import { findToken, TOKENS } from "@/lib/solana/tokens";

export { SAFE_HEALTH_FACTOR, LIQUIDATION_HEALTH_FACTOR };

/** Sentinel the stores use for an infinite HF (collateral, no debt). */
export const HF_INFINITY = 999;

/** Extra headroom the service wraps / requires for a repay_all (interest accrued before landing). */
export const REPAY_ALL_BUFFER = 0.002; // 0.2% — matches REPAY_ALL_BUFFER_BPS in lib/solana/margin.ts

/** SOL kept in the wallet for fees (mirrors SOL_FEE_RESERVE_LAMPORTS = 0.05 SOL). */
export const SOL_FEE_RESERVE_UI = 0.05;

/**
 * Fixed display ceiling for the margin leverage slider. The account's safe selectable
 * leverage may be lower, but deposits must never change the displayed 1x–10x scale.
 */
export const LEVERAGE_SLIDER_CAP = 10;

/** Max leverage for a brand-new deposit at the UI safety buffer: h / (h − 1) ≈ 7.67x at 1.15. */
export const FRESH_ACCOUNT_MAX_LEVERAGE = maxLeverage(SAFE_HEALTH_FACTOR);

/** Registry decimals for a symbol (9 when unknown — never used for an unknown token in practice). */
export function tokenDecimals(symbol: string): number {
  return findToken(symbol)?.decimals ?? 9;
}

/** Floor to `decimals` places. */
export function floorTo(value: number, decimals: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const scale = 10 ** decimals;
  // The small epsilon absorbs float noise like 0.29999999999 → 0.3 before flooring.
  return Math.floor(value * scale + 1e-6) / scale;
}

/**
 * A plain decimal string (no exponent) floored to the token's decimals — safe to hand to the
 * service layer (`toRaw` truncates extra digits anyway, but flooring here keeps the displayed
 * value identical to what is sent). Empty string for non-positive input.
 */
export function toTokenAmountString(value: number, symbol: string): string {
  const d = tokenDecimals(symbol);
  const floored = floorTo(value, d);
  if (floored <= 0) return "";
  return floored.toFixed(d).replace(/\.?0+$/, "");
}

/** Wallet balance that can actually be deposited: SOL keeps the fee reserve. */
export function spendableWalletAmount(symbol: string, walletBalance: number): number {
  const token = findToken(symbol);
  if (!Number.isFinite(walletBalance) || walletBalance <= 0) return 0;
  if (token?.isNative) return Math.max(0, walletBalance - SOL_FEE_RESERVE_UI);
  return walletBalance;
}

/** USD value of the given per-symbol amounts at the given prices (unknown price → 0). */
export function usdOf(items: { symbol: string; amount: number }[], prices: Record<string, number>): number {
  return items.reduce((sum, i) => sum + (Number(i.amount) || 0) * (prices[i.symbol] ?? 0), 0);
}

export interface AccountTotals {
  /** Σ collateral USD in the margin vaults (borrowed tokens included). */
  collateralUsd: number;
  /** Σ debt USD. */
  debtUsd: number;
}

/**
 * Max leverage the slider may offer.
 *  - WB (fresh deposit of `depositUsd`): borrow B satisfies (C + E + B) / (D + B) >= h,
 *    leverage = 1 + B / E  (→ 7.67x for a fresh account at h = 1.15).
 *  - MB (borrow against `depositUsd` of collateral ALREADY in the vault): B <= maxBorrowUsd(C, D),
 *    leverage = 1 + B / sized.
 * With nothing entered yet the fresh-account figure is shown. Floored to 2 decimals so the
 * selected value can never overshoot the true limit; capped at {@link LEVERAGE_SLIDER_CAP}.
 */
export function maxLeverageForInput(depositUsd: number, account: AccountTotals, mode: "WB" | "MB"): number {
  let lev: number;
  if (!(depositUsd > 0)) {
    lev = FRESH_ACCOUNT_MAX_LEVERAGE;
  } else if (mode === "WB") {
    lev = maxLeverageFor(depositUsd, account.collateralUsd, account.debtUsd, SAFE_HEALTH_FACTOR);
  } else {
    lev = 1 + maxBorrowUsd(account.collateralUsd, account.debtUsd, SAFE_HEALTH_FACTOR, true) / depositUsd;
  }
  return Math.max(1, Math.min(LEVERAGE_SLIDER_CAP, floorTo(lev, 2)));
}

/** Max additional borrow USD after depositing `depositUsd` (0 in MB mode), at the safety buffer. */
export function maxBorrowUsdAfterDeposit(depositUsd: number, account: AccountTotals): number {
  return maxBorrowUsd(account.collateralUsd + Math.max(0, depositUsd), account.debtUsd, SAFE_HEALTH_FACTOR, true);
}

/** Borrow USD implied by a leverage multiplier on `sizedUsd` of equity: sized × (leverage − 1). */
export function borrowUsdForLeverage(sizedUsd: number, leverage: number): number {
  return Math.max(0, sizedUsd * (leverage - 1));
}

/**
 * Splits a USD borrow across 1..n assets (equal USD shares) and converts to token amounts floored
 * to each token's decimals. Unknown price → that slot gets "" (nothing is sent for it).
 */
export function splitBorrowUsd(totalUsd: number, symbols: string[], prices: Record<string, number>): { symbol: string; amount: string }[] {
  if (!symbols.length) return [];
  const share = Math.max(0, totalUsd) / symbols.length;
  return symbols.map((symbol) => {
    const price = prices[symbol] ?? 0;
    return { symbol, amount: price > 0 ? toTokenAmountString(share / price, symbol) : "" };
  });
}

/** HF after hypothetical USD changes: (C + E + B) / (D + B). Returns HF_INFINITY with no debt. */
export function projectedHealthFactor(account: AccountTotals, change: { addCollateralUsd?: number; addBorrowUsd?: number; removeCollateralUsd?: number; repayUsd?: number }): number {
  const b = Math.max(0, change.addBorrowUsd ?? 0);
  const collateral = Math.max(0, account.collateralUsd + (change.addCollateralUsd ?? 0) + b - (change.removeCollateralUsd ?? 0));
  const debt = Math.max(0, account.debtUsd + b - (change.repayUsd ?? 0));
  if (debt <= 1e-9) return HF_INFINITY;
  return collateral / debt;
}

/** Liquidation buffer: collateral USD above the 1.10 line, C − 1.10·D (floored at 0). */
export function liquidationBufferUsd(collateralUsd: number, debtUsd: number): number {
  return Math.max(0, collateralUsd - debtUsd * LIQUIDATION_HEALTH_FACTOR);
}

/**
 * Max tokens of `symbol` withdrawable to the wallet while HF stays >= 1.15:
 * min(vault balance, maxWithdrawUsd(C, D) / price), floored to the token's decimals.
 * With no debt the whole vault balance is withdrawable (even with no price).
 */
export function maxWithdrawTokens(input: { symbol: string; vaultAmount: number; price: number } & AccountTotals): number {
  const vault = Math.max(0, input.vaultAmount || 0);
  if (!(input.debtUsd > 0)) return vault;
  if (!(input.price > 0)) return 0;
  const usd = maxWithdrawUsd(input.collateralUsd, input.debtUsd, SAFE_HEALTH_FACTOR);
  return floorTo(Math.min(vault, usd / input.price), tokenDecimals(input.symbol));
}

export interface RepayCheck {
  ok: boolean;
  /** Tokens the source must hold (debt + buffer for a full repay). */
  required: number;
  /** Tokens the source holds. */
  available: number;
  reason: string | null;
}

/**
 * Pre-check a repay against its source, mirroring lib/solana/margin.ts `repay`:
 * a full repay (repay_all) needs debt × (1 + 0.2%) in the source; a partial needs the amount.
 * From margin, the source is the vault balance of that token — borrowed SOL sitting in the vault
 * is slightly LESS than the accrued debt, so a full repay from margin is often short and the user
 * should repay from the wallet (or top the vault up) instead.
 */
export function checkRepaySource(input: {
  symbol: string;
  source: "margin" | "wallet";
  all: boolean;
  amount: number;
  debt: number;
  vaultAmount: number;
  walletAmount: number;
}): RepayCheck {
  const target = input.all ? input.debt : Math.min(input.amount, input.debt);
  const required = input.all || target >= input.debt ? input.debt * (1 + REPAY_ALL_BUFFER) : target;
  const available = input.source === "margin" ? Math.max(0, input.vaultAmount) : spendableWalletAmount(input.symbol, input.walletAmount);
  if (!(target > 0)) return { ok: false, required, available, reason: null };
  if (available + 1e-12 < required) {
    const where = input.source === "margin" ? "margin account" : "wallet";
    const fix = input.source === "margin" ? " Repay from your wallet, or repay a smaller amount." : " Top up your wallet or repay a smaller amount.";
    return {
      ok: false,
      required,
      available,
      reason: `Your ${where} holds ${formatAmount(available, input.symbol)} ${input.symbol}, less than the ${formatAmount(required, input.symbol)} ${input.symbol} needed${input.all || target >= input.debt ? " (debt + 0.2% accrual buffer)" : ""}.${fix}`,
    };
  }
  return { ok: true, required, available, reason: null };
}

const formatAmount = (n: number, symbol: string) => {
  const d = Math.min(6, tokenDecimals(symbol));
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
};

export interface MarginHistoryLike {
  type: string;
  symbol: string;
  amount: string;
}

/**
 * Accrued interest per borrowed symbol from decoded on-chain history (newest first):
 * debt_now = Σ borrowed + interest − Σ repaid (incl. liquidation repayments) since the debt
 * position was last opened, so interest = debt_now − Σ borrowed + Σ repaid.
 * Returns null for a symbol whose `open-debt` event is not in the scanned history (unknown
 * cost basis — never reported as 0 or as the whole debt).
 */
export function accruedInterestBySymbol(rows: MarginHistoryLike[], debts: Record<string, number>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [symbol, debt] of Object.entries(debts)) {
    let borrowed = 0;
    let repaid = 0;
    let opened = false;
    for (const row of rows) {
      if (row.symbol !== symbol) continue;
      if (row.type === "open-debt") {
        opened = true;
        break; // rows are newest first — everything before this belongs to an older position
      }
      const amt = Number(row.amount) || 0;
      if (row.type === "borrow") borrowed += amt;
      else if (row.type === "repay" || row.type === "liquidation") repaid += amt;
    }
    out[symbol] = opened ? Math.max(0, debt - borrowed + repaid) : null;
  }
  return out;
}

/** Leverage = gross collateral / net equity (1x with no debt, 0 when equity is gone). */
export function accountLeverage(collateralUsd: number, debtUsd: number): number {
  const equity = collateralUsd - debtUsd;
  if (!(debtUsd > 0.000001)) return collateralUsd > 0 ? 1 : 0;
  if (!(equity > 0)) return 0;
  return collateralUsd / equity;
}

/** Registry symbols (for iteration without importing the whole registry at call sites). */
export const MARGIN_SYMBOLS: readonly string[] = TOKENS.map((t) => t.symbol);
