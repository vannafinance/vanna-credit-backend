/**
 * "Deposit 100 USDC in margin and borrow SOL 3x against it": a borrow whose amount is a LEVERAGE TARGET.
 *
 * The user (or the model reading the user) states the multiple; this module turns it into an exact borrow amount from
 * live prices, the way `sizeLever` does for a lever. Neither the user nor the model ever supplies the number.
 *
 * Leverage here is the product's own definition (portfolio view): gross collateral / equity. The borrowed token stays in
 * the margin account as collateral, so reaching N x on a base equity B means borrowing (N - 1) x B of value. The base is
 * what the user pointed at: the deposits made earlier in the same request ("against that USDC"); with no deposit in the
 * request it is the account's current equity. The result is checked against the health floor before anything is
 * drawn, and refused with the highest multiple that does hold it.
 */

import { copilotConfig } from "../config";
import { fmtAmount, fmtHf, fmtUsd } from "../explain";
import type { Asset, WriteIntent } from "../intent";
import { loadFreshPrice, loadHealth, poolAvailable, POOL_HEADROOM, type HealthResult, type ReadCtx } from "../mcp-facts";
import type { StepSpec } from "../plan";
import { debugMcp } from "../debug";
import { hfAfter, maxBorrowUsd, usdToUnits } from "../risk";

export type LevBorrowResult = { ok: true; amount: string; notes: string[] } | { ok: false; message: string };

const isDecimal = (v: string | null): v is string => !!v && /^\d+(?:\.\d+)?$/.test(v);

export async function sizeLevBorrow(w: WriteIntent, earlier: StepSpec[], ctx: ReadCtx, floor: number): Promise<LevBorrowResult> {
  const asset = w.asset;
  if (!asset || w.amount?.kind !== "lev") return { ok: false, message: "Which asset do you want to borrow?" };
  const multiple = w.amount.multiple;

  const deposits = earlier.filter((s) => s.kind === "write" && s.op === "deposit" && s.asset);
  const readable = deposits.filter((s) => isDecimal(s.amount));
  if (readable.length !== deposits.length) {
    return { ok: false, message: 'To size the leverage I need the exact amount you are depositing. Say how much to deposit (not "all" or a percentage) and I will size the borrow.' };
  }

  const healthR = await loadHealth(ctx);
  if (healthR.kind === "unavailable" || healthR.kind === "malformed") {
    return { ok: false, message: "I couldn't read your account data, so I can't size a leveraged borrow right now. Try again in a minute." };
  }
  const collateralUsd = healthR.kind === "ok" ? healthR.health.collateralUsd : 0;
  const debtUsd = healthR.kind === "ok" ? healthR.health.debtUsd : 0;

  let depositUsd = 0;
  const depositNames: string[] = [];
  for (const d of readable) {
    const p = await loadFreshPrice(d.asset as string, ctx);
    if (!p) return { ok: false, message: `The ${d.asset} price is unavailable right now, so I can't size this safely. Try again in a minute.` };
    depositUsd += Number(d.amount) * p.usd;
    depositNames.push(fmtAmount(d.amount as string, d.asset as string));
  }

  const equityNow = collateralUsd - debtUsd;
  let baseUsd: number;
  let basis: string;
  const named = w.amount.base;
  if (named) {
    // The user named the base ("using 0.5 SOL", "against my 10 JitoSOL"): it must be collateral they hold, or are
    // depositing earlier in this same plan.
    const b = await holdingValue(named, readable, healthR, ctx, "The leverage is taken on");
    if (!b.ok) return b;
    baseUsd = b.usd;
    basis = b.basis;
  } else {
    baseUsd = depositUsd > 0 ? depositUsd : equityNow;
    basis = depositUsd > 0 ? `your ${depositNames.join(" + ")} deposit (${fmtUsd(baseUsd)})` : `your account equity (${fmtUsd(baseUsd)})`;
  }
  if (!(baseUsd > 0)) {
    return { ok: false, message: "There is no collateral to take a leverage multiple of. Deposit something first, or tell me exactly how much to borrow." };
  }

  const price = await loadFreshPrice(asset, ctx);
  if (!price) return { ok: false, message: `The ${asset} price is unavailable right now, so I can't size this safely. Try again in a minute.` };

  const c0 = collateralUsd + depositUsd;
  const borrowUsd = (multiple - 1) * baseUsd;
  const after = hfAfter(c0 + borrowUsd, debtUsd + borrowUsd);
  if (after !== null && after < floor) {
    const headroom = maxBorrowUsd(c0, debtUsd, floor, true);
    const best = 1 + headroom / baseUsd;
    const holds = best > 1.05
      ? ` The most I can size on ${basis} while keeping health at ${floor.toFixed(2)} is about ${(Math.floor(best * 100) / 100).toFixed(2)}x.`
      : " There is no room to borrow against it while keeping that floor.";
    return { ok: false, message: `${multiple}x on ${basis} would borrow about ${fmtUsd(borrowUsd)} of ${asset} and take your health factor to ${fmtHf(after)}, below the ${floor.toFixed(2)} floor.${holds}` };
  }

  // The per-action limit applies to the borrow itself; say the largest multiple it allows instead of failing mid-plan.
  if (borrowUsd > copilotConfig.maxActionUsd) {
    const most = Math.floor((1 + copilotConfig.maxActionUsd / baseUsd) * 100) / 100;
    return { ok: false, message: `${multiple}x on ${basis} would borrow about ${fmtUsd(borrowUsd)} of ${asset}, above the per-action limit of ${fmtUsd(copilotConfig.maxActionUsd)}. The most I can borrow in one action on this is about ${most.toFixed(2)}x. Ask for that or less.` };
  }
  const amount = usdToUnits(borrowUsd, price.usd, asset);
  if (!(Number(amount) > 0)) return { ok: false, message: `That leverage works out to less than the smallest ${asset} amount, so there is nothing to borrow.` };

  // Dev-only trace (no-op otherwise): the figures this sizing computed, so a turn's numbers are all traceable.
  debugMcp("size:leverage_borrow", { asset, multiple }, true, { base_usd: baseUsd, borrow_usd: borrowUsd, borrow_amount: amount, price_usd: price.usd, hf_after: after, collateral_usd: c0, debt_usd: debtUsd });
  const notes = [
    `${multiple}x on ${basis}: borrowing ${fmtAmount(amount, asset)} (about ${fmtUsd(borrowUsd)}) so your collateral is ${multiple} times your equity. Health after: ${fmtHf(after)}.`,
    `The borrowed ${asset} stays in your margin account as collateral. Because you owe ${asset} and also hold it, this raises your leverage ratio but does not add price exposure to ${asset}. To go long an asset, deposit it (or lever it) and borrow a stable.`,
  ];
  return { ok: true, amount, notes };
}

type Holding = { asset: Asset; value: string };

/**
 * The USD value of a holding the user named as a borrow's base. It must be collateral they hold, or are depositing
 * earlier in this same plan.
 */
async function holdingValue(
  named: Holding,
  deposits: StepSpec[],
  healthR: HealthResult,
  ctx: ReadCtx,
  lead: string,
): Promise<{ ok: true; usd: number; basis: string } | { ok: false; message: string }> {
  const held = healthR.kind === "ok" ? (healthR.health.collateral.find((r) => r.symbol === named.asset)?.units ?? 0) : 0;
  const depositing = deposits.filter((d) => d.asset === named.asset).reduce((sum, d) => sum + Number(d.amount), 0);
  const want = Number(named.value);
  if (held + depositing + 1e-9 < want) {
    return {
      ok: false,
      message: `${lead} ${fmtAmount(named.value, named.asset)}, but your margin account holds ${fmtAmount(held, named.asset)}${depositing > 0 ? ` and this plan deposits ${fmtAmount(depositing, named.asset)}` : ""}. Say "deposit ${fmtAmount(named.value, named.asset)} and borrow" to do both, or use a smaller amount.`,
    };
  }
  const p = await loadFreshPrice(named.asset, ctx);
  if (!p) return { ok: false, message: `The ${named.asset} price is unavailable right now, so I can't size this safely. Try again in a minute.` };
  const usd = want * p.usd;
  return { ok: true, usd, basis: `${fmtAmount(named.value, named.asset)} of your collateral (${fmtUsd(usd)})` };
}

/**
 * "Borrow what I can against 5 JupSOL": the largest borrow that holding supports on its own at the health floor. The
 * borrowed asset stays in the account as collateral, so on a holding worth V the borrow x keeps (V + x) / x >= floor.
 * It never exceeds what the whole account allows (with this plan's earlier deposits counted), what the pool can lend,
 * or the per-action limit; whichever binds is said in the plan's notes. The borrow step re-checks it live.
 */
export async function sizeBorrowAgainst(w: WriteIntent, earlier: StepSpec[], ctx: ReadCtx, floor: number): Promise<LevBorrowResult> {
  const asset = w.asset;
  if (!asset || w.amount?.kind !== "against") return { ok: false, message: "Which asset do you want to borrow?" };
  const named = w.amount.base;

  const deposits = earlier.filter((s) => s.kind === "write" && s.op === "deposit" && s.asset);
  const readable = deposits.filter((s) => isDecimal(s.amount));
  if (readable.length !== deposits.length) {
    return { ok: false, message: 'To size the borrow I need the exact amount you are depositing. Say how much to deposit (not "all" or a percentage) and I will size the borrow.' };
  }

  const [healthR, price, available] = await Promise.all([loadHealth(ctx), loadFreshPrice(asset, ctx), poolAvailable(asset, ctx)]);
  if (healthR.kind === "unavailable" || healthR.kind === "malformed") {
    return { ok: false, message: "I couldn't read your account data, so I can't size this borrow right now. Try again in a minute." };
  }
  if (!price) return { ok: false, message: `The ${asset} price is unavailable right now, so I can't size this safely. Try again in a minute.` };
  const base = await holdingValue(named, readable, healthR, ctx, "The borrow is sized against");
  if (!base.ok) return base;

  let depositUsd = 0;
  for (const d of readable) {
    const p = await loadFreshPrice(d.asset as string, ctx);
    if (!p) return { ok: false, message: `The ${d.asset} price is unavailable right now, so I can't size this safely. Try again in a minute.` };
    depositUsd += Number(d.amount) * p.usd;
  }
  const collateralUsd = (healthR.kind === "ok" ? healthR.health.collateralUsd : 0) + depositUsd;
  const debtUsd = healthR.kind === "ok" ? healthR.health.debtUsd : 0;

  const limits: Array<{ usd: number; why: string }> = [
    { usd: maxBorrowUsd(base.usd, 0, floor, true), why: `the most ${base.basis} supports on its own at a health factor of ${floor.toFixed(2)}` },
    { usd: maxBorrowUsd(collateralUsd, debtUsd, floor, true), why: `the most your whole account allows at a health factor of ${floor.toFixed(2)}` },
    { usd: copilotConfig.maxActionUsd, why: `the per-action limit of ${fmtUsd(copilotConfig.maxActionUsd)}` },
  ];
  if (available !== null) limits.push({ usd: available * POOL_HEADROOM * price.usd, why: `what the ${asset} pool can lend right now (${fmtAmount(available, asset)})` });
  const binding = limits.reduce((a, b) => (b.usd < a.usd ? b : a));
  // A small margin under the exact limit, as the safe-borrow sizer keeps, so a price tick before signing doesn't fail it.
  const amount = usdToUnits(binding.usd * 0.995, price.usd, asset);
  if (!(Number(amount) > 0)) return { ok: false, message: `There is no room to borrow ${asset}: it is capped by ${binding.why}.` };

  const borrowUsd = Number(amount) * price.usd;
  const after = hfAfter(collateralUsd + borrowUsd, debtUsd + borrowUsd);
  debugMcp("size:borrow_against", { asset, base: named }, true, { base_usd: base.usd, borrow_usd: borrowUsd, borrow_amount: amount, price_usd: price.usd, hf_after: after, collateral_usd: collateralUsd, debt_usd: debtUsd, pool_available: available });
  const notes = [
    `Borrowing ${fmtAmount(amount, asset)} (about ${fmtUsd(borrowUsd)}), sized to ${binding.why}. Health after: ${fmtHf(after)}.`,
  ];
  if (binding !== limits[0]) notes.push(`On its own, ${base.basis} would support about ${fmtUsd(limits[0].usd)}.`);
  return { ok: true, amount, notes };
}
