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

import { fmtAmount, fmtHf, fmtUsd } from "../explain";
import type { WriteIntent } from "../intent";
import { loadFreshPrice, loadHealth, type ReadCtx } from "../mcp-facts";
import type { StepSpec } from "../plan";
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
  const baseUsd = depositUsd > 0 ? depositUsd : equityNow;
  if (!(baseUsd > 0)) {
    return { ok: false, message: "There is no collateral to take a leverage multiple of. Deposit something first, or tell me exactly how much to borrow." };
  }
  const basis = depositUsd > 0 ? `your ${depositNames.join(" + ")} deposit (${fmtUsd(baseUsd)})` : `your account equity (${fmtUsd(baseUsd)})`;

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

  const amount = usdToUnits(borrowUsd, price.usd, asset);
  if (!(Number(amount) > 0)) return { ok: false, message: `That leverage works out to less than the smallest ${asset} amount, so there is nothing to borrow.` };

  const notes = [
    `${multiple}x on ${basis}: borrowing ${fmtAmount(amount, asset)} (about ${fmtUsd(borrowUsd)}) so your collateral is ${multiple} times your equity. Health after: ${fmtHf(after)}.`,
    `The borrowed ${asset} stays in your margin account as collateral. Because you owe ${asset} and also hold it, this raises your leverage ratio but does not add price exposure to ${asset}. To go long an asset, deposit it (or lever it) and borrow a stable.`,
  ];
  return { ok: true, amount, notes };
}
