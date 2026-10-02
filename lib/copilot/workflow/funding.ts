/**
 * Funding check at preview time: is the wallet able to pay for the steps that spend wallet funds?
 *
 * Only steps that run before anything could change the balance are checked (a borrow, withdrawal,
 * redeem or farm exit may bring funds in, so what comes after them is checked when its turn comes).
 * Figures come from the MCP wallet summary; the one constant is the SOL the MCP itself keeps back for
 * fees and rent (TOOLS_CATALOGUE section 2.2), shared with `walletSpendable`.
 */

import { fmtAmount } from "../explain";
import { mcp } from "../mcp-client";
import type { ReadCtx } from "../mcp-facts";
import type { StepSpec } from "../plan";
import { num } from "../risk";
import { SOL_FEE_RESERVE } from "./steps";

/** Ops that pull from the wallet: deposit, Earn supply, and repay/swap when their source is the wallet. */
function spendsWallet(s: StepSpec): boolean {
  if (s.kind !== "write") return false;
  if (s.op === "deposit" || s.op === "earn_supply") return true;
  if (s.op === "repay") return String(s.slots?.source ?? "wallet") !== "margin";
  // A swap's balance lives in `mode` (wallet | margin); a margin swap spends margin collateral, not the wallet.
  if (s.op === "swap") return String(s.slots?.mode ?? "wallet") !== "margin";
  return false;
}

/** Ops that may bring funds into the wallet or margin balance; later steps are checked when they run. */
const CREATES_FUNDS = new Set(["borrow", "withdraw", "earn_redeem", "farm_redeem"]);
/** Ops whose transaction can create accounts (token accounts, the margin account) and so pay rent. */
const PAYS_RENT = new Set(["create_account", "deposit", "earn_supply", "swap", "farm_deposit"]);

export async function checkFunding(steps: StepSpec[], ctx: ReadCtx): Promise<string | null> {
  const writes = steps.filter((s) => s.kind === "write");
  if (!writes.length) return null;
  let wallet: Record<string, unknown>;
  try {
    wallet = await mcp.wallet(ctx.user.wallet, ctx);
  } catch {
    return null; // an unreadable wallet is reported by the step's own check; this one only refuses on facts
  }
  const sol = num(wallet.sol_balance);
  if (sol === null) return null;
  const held = (symbol: string): number | null => {
    if (symbol === "SOL") return sol;
    const row = Array.isArray(wallet.assets) ? (wallet.assets as Array<Record<string, unknown>>).find((a) => a.symbol === symbol) : undefined;
    return row ? num(row.wallet_balance) : 0;
  };

  if (writes.some((s) => PAYS_RENT.has(s.op)) && sol < SOL_FEE_RESERVE) {
    return `Your wallet has ${fmtAmount(sol, "SOL")}. Transactions here need about ${SOL_FEE_RESERVE} SOL for network fees and account rent, so I can't prepare this yet. Add SOL to your wallet first.`;
  }

  const planned = new Map<string, number>();
  for (const s of steps) {
    if (s.kind === "write" && CREATES_FUNDS.has(s.op)) break;
    if (!spendsWallet(s) || !s.asset) continue;
    const have = held(s.asset);
    if (have === null) continue;
    const spendable = s.asset === "SOL" ? Math.max(0, have - SOL_FEE_RESERVE) : have;
    const already = planned.get(s.asset) ?? 0;
    const need = s.amount === "all" ? (spendable > already ? already + 1e-12 : already + 1) : already + Number(s.amount);
    if (!Number.isFinite(need)) continue;
    if (spendable + 1e-9 < need) {
      const what = s.asset === "SOL" ? `${fmtAmount(have, "SOL")} (about ${SOL_FEE_RESERVE} SOL stays back for fees and rent)` : `${fmtAmount(have, s.asset)}`;
      const needText = s.amount === "all" ? `some ${s.asset}` : `${fmtAmount(String(need), s.asset)}`;
      return `Your wallet has ${what}, but this needs ${needText}. Add funds or ask for a smaller amount.`;
    }
    planned.set(s.asset, need);
  }
  return null;
}
