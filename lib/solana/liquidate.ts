/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `public_liquidate` for the liquidator bot: the quote math and the instruction builder.
 *
 * Ported from the deployed program (vanna-credit-layer, branch `feature/phoenix-titan`,
 * `instructions/account_manager/liquidate.rs`). Rules:
 *  - liquidatable at liquidation HF <= 1.10 (`BALANCE_TO_BORROW_THRESHOLD_WAD`);
 *  - one call repays ONE debt and seizes ONE token collateral;
 *  - close factor 50%, or the whole debt when HF <= 1 + bonus or the debt is worth <= $100;
 *  - the liquidator receives `repaid value × bonus` of collateral, bonus = min(HF, 1 + bonus_bps)
 *    (the full bonus when HF < 1); if the collateral can't cover that, it is all seized and the
 *    repay shrinks to match;
 *  - `min_seized` is the slippage guard.
 *
 * `remaining_accounts` = [venue call accounts] + [position groups] + [7 settlement accounts] +
 * [oracle segment]. Venue calls (unwinding Kamino/Phoenix positions inside the liquidation) have a
 * slot ({@link VenueUnwind}) for venue strategies to fill; none is built yet.
 */
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import { PublicKey, type AccountMeta, type TransactionInstruction } from "@solana/web3.js";
import { BN, utils } from "@coral-xyz/anchor";
import { ORACLE_PROGRAM_ID, VANNA_PROGRAM_ID } from "./config";
import { getProgram, VANNA_IDL } from "./program";
import { debtPositionPda, marginVault, protocolConfigPda, reservePda, reserveVault, walletAta } from "./pdas";
import { BALANCE_TO_BORROW_THRESHOLD_WAD, BASIS_POINTS, mulDivCeil, mulDivFloor, WAD } from "./math";
import { tokenByMint } from "./tokens";
import { wrapSolInstructions } from "./wsol";
import { simulateInstructions, type SendOptions } from "./tx";
import { buildHealthRemainingAccounts, venueScan, type BatchContext, type CollateralPosition, type DebtPositionView, type MarginSnapshot } from "./margin";
import type { AssetConfigState } from "./protocol-state";

/** Program constant `CLOSE_FACTOR_BPS`. */
export const CLOSE_FACTOR_BPS = 5_000n;
/** Program constant `FULL_LIQUIDATION_DEBT_VALUE`: a debt worth <= $100 (nano-USD) is repaid in full. */
export const FULL_LIQUIDATION_DEBT_VALUE_NANO = 100n * 1_000_000_000n;

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export interface LiquidationQuoteInput {
  /** The program's liquidation HF (collateral counted up to each asset's per-margin cap). */
  healthWad: bigint;
  /** The seized collateral's `liquidation_bonus_bps`. */
  bonusBps: number;
  /** Debt to repay, raw units, accrued (rounded up like the program). */
  debtRaw: bigint;
  /** Value of that whole debt, nano-USD. */
  debtValueNano: bigint;
  /** Collateral held in the margin vault, raw units (uncapped). */
  heldRaw: bigint;
  /** Value of that whole holding, nano-USD (uncapped). */
  heldValueNano: bigint;
  /** The most the liquidator offers to repay, raw units. */
  repay: bigint;
}

export interface LiquidationQuote {
  /** Debt the program takes from the liquidator, raw units. */
  repaid: bigint;
  /** Collateral the liquidator receives, raw units. */
  seized: bigint;
  /** The most this call may repay (close factor or full). */
  maxRepay: bigint;
  /** True when the whole debt may be repaid in this call. */
  full: boolean;
  bonusWad: bigint;
  repaidValueNano: bigint;
  seizedValueNano: bigint;
  /** seized value − repaid value, before fees and swap costs. */
  grossProfitNano: bigint;
}

/** Mirrors the program's `settle`. Null when the program would refuse (healthy, zero amounts). */
export function quoteLiquidation(input: LiquidationQuoteInput): LiquidationQuote | null {
  const { healthWad: health, debtRaw: debt, debtValueNano: debtValue, heldRaw: held, heldValueNano: heldValue } = input;
  if (health > BALANCE_TO_BORROW_THRESHOLD_WAD) return null;
  if (debt <= 0n || debtValue <= 0n || held <= 0n || heldValue <= 0n || input.repay <= 0n) return null;

  const maxBonus = mulDivFloor(WAD, BASIS_POINTS + BigInt(input.bonusBps), BASIS_POINTS);
  const bonusWad = health < WAD ? maxBonus : min(health, maxBonus);
  const full = health <= maxBonus || debtValue <= FULL_LIQUIDATION_DEBT_VALUE_NANO;
  const maxRepay = full ? debt : mulDivCeil(debt, CLOSE_FACTOR_BPS, BASIS_POINTS);

  let repaid = min(input.repay, maxRepay);
  const repaidValue = mulDivFloor(debtValue, repaid, debt);
  const seizeValue = mulDivFloor(repaidValue, bonusWad, WAD);
  let seized = mulDivFloor(seizeValue, held, heldValue);
  if (seized > held) {
    seized = held;
    const neededValue = mulDivCeil(heldValue, WAD, bonusWad);
    repaid = min(repaid, mulDivCeil(neededValue, debt, debtValue));
  }
  if (repaid <= 0n || seized <= 0n) return null;

  const repaidValueNano = mulDivFloor(debtValue, repaid, debt);
  const seizedValueNano = mulDivFloor(heldValue, seized, held);
  return { repaid, seized, maxRepay, full, bonusWad, repaidValueNano, seizedValueNano, grossProfitNano: seizedValueNano - repaidValueNano };
}

/**
 * The program's liquidation HF from a snapshot: like the snapshot's own HF, except each token
 * collateral counts only up to its asset's `max_collateral_per_margin` (`Holding::counted`).
 */
export function liquidationHealthWad(snapshot: MarginSnapshot, assetMap: Map<number, AssetConfigState>): bigint | null {
  if (snapshot.totalDebtNano <= 0n) return null;
  let collateral = 0n;
  for (const c of snapshot.collateral) {
    if (!c.active) continue;
    const cap = assetMap.get(c.assetIndex)?.maxCollateralPerMargin ?? 0n;
    const capped = c.amountRaw > 0n && cap > 0n && cap < c.amountRaw;
    collateral += capped ? mulDivFloor(c.valueNano, cap, c.amountRaw) : c.valueNano;
  }
  return mulDivFloor(collateral, WAD, snapshot.totalDebtNano);
}

export interface LiquidationPlan {
  debt: DebtPositionView;
  collateral: CollateralPosition;
  debtAsset: AssetConfigState;
  collateralAsset: AssetConfigState;
  quote: LiquidationQuote;
}

/**
 * Every (debt, token collateral) pair the program would settle, best gross profit first.
 * `budget(mint)` caps the repay at what the liquidator holds of that debt token.
 */
export function planLiquidations(ctx: BatchContext, budget: (debtMint: PublicKey) => bigint): LiquidationPlan[] {
  const healthWad = liquidationHealthWad(ctx.snapshot, ctx.assetMap);
  if (healthWad === null) return [];
  const plans: LiquidationPlan[] = [];
  for (const debt of ctx.snapshot.debts) {
    const debtAsset = ctx.assetMap.get(debt.assetIndex);
    if (!debtAsset || debt.debtRaw <= 0n) continue;
    const repay = budget(debt.mint);
    for (const collateral of ctx.snapshot.collateral) {
      const collateralAsset = ctx.assetMap.get(collateral.assetIndex);
      // Only token collateral on the allowed list can be seized (venues are unwound, not seized).
      if (!collateralAsset || collateralAsset.kind !== "token" || !collateral.active || collateral.amountRaw <= 0n) continue;
      const quote = quoteLiquidation({
        healthWad,
        bonusBps: collateralAsset.liquidationBonusBps,
        debtRaw: debt.debtRaw,
        debtValueNano: debt.valueNano,
        heldRaw: collateral.amountRaw,
        heldValueNano: collateral.valueNano,
        repay,
      });
      if (quote) plans.push({ debt, collateral, debtAsset, collateralAsset, quote });
    }
  }
  return plans.sort((a, b) => (b.quote.grossProfitNano > a.quote.grossProfitNano ? 1 : b.quote.grossProfitNano < a.quote.grossProfitNano ? -1 : 0));
}

const writableMeta = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const readonlyMeta = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

export function eventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], getProgram().programId)[0];
}

/** The settlement half of a liquidation: repay one debt, seize one token collateral. */
export interface Settlement {
  debtAsset: AssetConfigState;
  collateralAsset: AssetConfigState;
  repay: bigint;
  minSeized: bigint;
}

/**
 * The venue half of a liquidation: calls the program makes AS the margin to unwind a venue
 * position (Kamino, Phoenix, ...) before settling, each reviewed by the integration's validator in
 * `CallMode::Liquidation` (no tokens out, no new venue). Built by a venue strategy; nothing builds
 * one yet, so this path has not run against the program.
 */
export interface VenueUnwind {
  venueAsset: PublicKey;
  integration: PublicKey;
  targetProgram: PublicKey;
  validator: PublicKey;
  calls: Array<{ data: Buffer; accounts: AccountMeta[] }>;
  /** Accounts the validator agent reads, after the oracle segment. */
  validatorAccounts?: AccountMeta[];
  /** Extra assets the calls move tokens into (priced and their vaults writable). */
  touched?: AssetConfigState[];
}

export interface LiquidateRequest {
  settle?: Settlement;
  venue?: VenueUnwind;
}

/**
 * `remaining_accounts` = [venue call accounts] + [position groups] + [settlement (7, only when
 * repaying)] + [oracle segment] + [validator segment (venue calls only)].
 */
export function liquidateRemainingAccounts(ctx: BatchContext, liquidator: PublicKey, req: LiquidateRequest): AccountMeta[] {
  const { settle, venue } = req;
  const priced: AssetConfigState[] = [...(venue?.touched ?? [])];
  const writable: PublicKey[] = (venue?.touched ?? []).map((a) => marginVault(ctx.margin, a.mint, a.tokenProgram));
  if (settle) {
    const reserve = reservePda(settle.debtAsset.mint);
    priced.push(settle.debtAsset, settle.collateralAsset);
    writable.push(reserve, debtPositionPda(ctx.margin, reserve), marginVault(ctx.margin, settle.collateralAsset.mint, settle.collateralAsset.tokenProgram));
  }
  const positions = buildHealthRemainingAccounts(ctx.margin, ctx.model, ctx.assetMap, {}, priced, { venue: venueScan(ctx), writable });
  const oracleAt = positions.findIndex((m) => m.pubkey.equals(ORACLE_PROGRAM_ID));
  if (oracleAt === -1) throw new Error("Position accounts have no oracle segment");
  const settlement: AccountMeta[] = settle
    ? [
        readonlyMeta(settle.debtAsset.mint),
        writableMeta(reserveVault(settle.debtAsset.mint, settle.debtAsset.tokenProgram)),
        writableMeta(walletAta(liquidator, settle.debtAsset.mint, settle.debtAsset.tokenProgram)),
        readonlyMeta(settle.debtAsset.tokenProgram),
        readonlyMeta(settle.collateralAsset.mint),
        writableMeta(walletAta(liquidator, settle.collateralAsset.mint, settle.collateralAsset.tokenProgram)),
        readonlyMeta(settle.collateralAsset.tokenProgram),
      ]
    : [];
  const callAccounts = (venue?.calls ?? []).flatMap((c) => c.accounts.map((a) => ({ ...a, isSigner: false })));
  const validatorSegment = venue ? [readonlyMeta(venue.validator), ...(venue.validatorAccounts ?? []).map((a) => readonlyMeta(a.pubkey))] : [];
  return [...callAccounts, ...positions.slice(0, oracleAt), ...settlement, ...positions.slice(oracleAt), ...validatorSegment];
}

export async function liquidateIx(ctx: BatchContext, liquidator: PublicKey, req: LiquidateRequest): Promise<TransactionInstruction> {
  const { settle, venue } = req;
  if (!settle && !venue?.calls.length) throw new Error("A liquidation needs a repay or venue calls");
  const calls = (venue?.calls ?? []).map((c) => ({ data: c.data, accountCount: c.accounts.length }));
  return getProgram()
    .methods.publicLiquidate(calls, new BN((settle?.repay ?? 0n).toString()), new BN((settle?.minSeized ?? 0n).toString()))
    .accountsStrict({
      liquidator,
      protocolConfig: protocolConfigPda(),
      marginAccount: ctx.margin,
      venueAsset: venue?.venueAsset ?? null,
      integration: venue?.integration ?? null,
      targetProgram: venue?.targetProgram ?? null,
      validator: venue?.validator ?? null,
      eventAuthority: eventAuthorityPda(),
      program: getProgram().programId,
    } as any)
    .remainingAccounts(liquidateRemainingAccounts(ctx, liquidator, req))
    .instruction();
}

/**
 * The full instruction list for one liquidation: open the liquidator's collateral account, wrap
 * SOL when SOL is the debt, liquidate, and unwrap SOL the liquidator received or had left over.
 */
export async function liquidationInstructions(ctx: BatchContext, liquidator: PublicKey, req: LiquidateRequest): Promise<TransactionInstruction[]> {
  const out: TransactionInstruction[] = [];
  const suffix: TransactionInstruction[] = [];
  const { settle } = req;
  if (settle) {
    const { debtAsset, collateralAsset } = settle;
    if (tokenByMint(debtAsset.mint)?.isNative) {
      const wrap = await wrapSolInstructions(liquidator, settle.repay);
      out.push(...wrap.instructions);
      if (!wrap.existed) suffix.push(createCloseAccountInstruction(wrap.ata, liquidator, liquidator));
    }
    const destination = walletAta(liquidator, collateralAsset.mint, collateralAsset.tokenProgram);
    out.push(createAssociatedTokenAccountIdempotentInstruction(liquidator, destination, liquidator, collateralAsset.mint, collateralAsset.tokenProgram));
    if (tokenByMint(collateralAsset.mint)?.isNative && suffix.length === 0) {
      suffix.push(createCloseAccountInstruction(destination, liquidator, liquidator));
    }
  }
  out.push(await liquidateIx(ctx, liquidator, req));
  return [...out, ...suffix];
}

/**
 * The `repay` to offer: the quoted repay plus a small buffer, within the liquidator's budget. Debt
 * accrues interest between quote and landing, and the program takes `min(repay, max_repay)`, so
 * offering a little more repays a full liquidation completely instead of leaving dust.
 */
export function repayWithBuffer(quote: LiquidationQuote, budget: bigint, bufferBps = 10): bigint {
  return min(budget, quote.repaid + mulDivCeil(quote.repaid, BigInt(bufferBps), BASIS_POINTS) + 1n);
}

/** `min_seized` with a slippage allowance (prices can move between quote and landing). */
export function withSlippage(seized: bigint, slippageBps: number): bigint {
  return mulDivFloor(seized, BASIS_POINTS - BigInt(slippageBps), BASIS_POINTS);
}

/** Anchor's `emit_cpi!` tag (`EVENT_IX_TAG`, the u64 0x1d9acb512ea545e4 little-endian): the first 8 bytes of the self-CPI that carries an event. */
const EVENT_IX_TAG = Buffer.from("e445a52e51cb9a1d", "hex");
const COLLATERAL_SEIZED = Buffer.from(
  (VANNA_IDL as unknown as { events: Array<{ name: string; discriminator: number[] }> }).events.find((e) => e.name === "CollateralSeized")!.discriminator,
);
/** `CollateralSeized` layout: margin_account, liquidator, mint (3 × 32 bytes), then amount (u64). */
const SEIZED_AMOUNT_AT = 8 + 8 + 3 * 32;

/**
 * The collateral the program would really seize, read from a simulation's `CollateralSeized` event
 * (`emit_cpi!` events are in the inner instructions, not the logs). The quote values collateral
 * with the app's prices, which can differ from the program's oracle (receipt tokens especially), so
 * `min_seized` is set from this instead. Null when the simulation emits no seize (venue-only call).
 */
export async function simulateSeized(instructions: TransactionInstruction[], opts: SendOptions): Promise<bigint | null> {
  const simulation = await simulateInstructions(instructions, opts);
  for (const inner of simulation.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      if (!("data" in ix) || typeof ix.data !== "string" || String(ix.programId) !== VANNA_PROGRAM_ID.toBase58()) continue;
      const data = Buffer.from(utils.bytes.bs58.decode(ix.data));
      if (data.length < SEIZED_AMOUNT_AT + 8 || !data.subarray(0, 8).equals(EVENT_IX_TAG) || !data.subarray(8, 16).equals(COLLATERAL_SEIZED)) continue;
      return data.readBigUInt64LE(SEIZED_AMOUNT_AT);
    }
  }
  return null;
}
