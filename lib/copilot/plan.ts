/**
 * Plan IR: the executable content of a plan, its digest and its TTL.
 *
 * What executes is what was approved, so the plan is frozen (exact amounts, resolved once from live
 * reads), fingerprinted, stored on the server, and replayed verbatim. The browser never sends
 * amounts back; it sends the digest it was shown. Presentation (labels, warnings) is NOT hashed, so
 * a copy edit cannot break an approval, while every executable slot is.
 */

import { createHash } from "node:crypto";
import type { Venue } from "./types";
import type { WriteIntent, WriteOp } from "./intent";

export type Op = WriteOp | "report";
export type SlotValue = string | number | boolean | null;
export type Slots = Record<string, SlotValue>;

export interface StepSpec {
  kind: "write" | "read";
  op: Op;
  /** Underlying asset for farm ops (never the receipt symbol). */
  asset: string | null;
  /** Decimal string, or "all" (resolved against the live balance when the step is built). */
  amount: string | null;
  slots: Slots;
}

/** Approval must arrive within this of creation; beyond it a plan is re-drawn from fresh reads. */
export const PLAN_TTL_MS = 5 * 60 * 1000;
/** Once approved, new steps may still be started for this long; after that the plan expires. */
export const RUN_WINDOW_MS = 30 * 60 * 1000;
export const MAX_PLAN_STEPS = 8;

export const VENUE_BY_OP: Record<Op, Venue> = {
  create_account: "margin",
  close_account: "margin",
  earn_supply: "earn",
  earn_redeem: "earn",
  deposit: "margin",
  withdraw: "margin",
  borrow: "margin",
  repay: "margin",
  swap: "swap",
  farm_deposit: "farm",
  farm_redeem: "farm",
  report: "other",
};

/** Ops that lower (or can lower) the health factor: gated by the risk floor. */
export const RISK_INCREASING: ReadonlySet<Op> = new Set<Op>(["borrow", "withdraw", "swap"]);

/** Ops that touch the margin account (need one, and a health read before/after). */
export const MARGIN_OPS: ReadonlySet<Op> = new Set<Op>(["deposit", "withdraw", "borrow", "repay", "farm_deposit", "farm_redeem", "close_account"]);

function canonicalSlots(slots: Slots): Array<[string, SlotValue]> {
  return Object.entries(slots)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** sha256 over every executable slot of every step, the wallet and the health floor. */
export function planDigest(wallet: string, hfFloor: number, steps: StepSpec[]): string {
  const canonical = JSON.stringify({
    v: 1,
    w: wallet,
    f: hfFloor,
    s: steps.map((s) => [s.kind, s.op, s.asset, s.amount, canonicalSlots(s.slots)]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const fmtQty = (amount: string | null, asset: string | null): string => {
  if (!amount && !asset) return "";
  return `${amount === "all" ? "all" : amount ?? ""} ${asset ?? ""}`.trim();
};

export function labelFor(s: StepSpec): string {
  const q = fmtQty(s.amount, s.asset);
  switch (s.op) {
    case "create_account":
      return "Open your margin account";
    case "close_account":
      return "Close your (empty) margin account";
    case "earn_supply":
      return `Supply ${q} to the Vanna Earn pool`;
    case "earn_redeem":
      return `Redeem ${q} from the Vanna Earn pool`;
    case "deposit":
      return `Deposit ${q} as margin collateral`;
    case "withdraw":
      return `Withdraw ${q} from margin collateral`;
    case "borrow":
      return `Borrow ${q} against your margin collateral`;
    case "repay":
      return `Repay ${q} ${s.slots.source === "margin" ? "from your margin balance" : "from your wallet"}`;
    case "swap": {
      const to = String(s.slots.to_asset ?? "");
      return s.slots.mode === "margin"
        ? `Swap ${q} to ${to} inside your margin account`
        : `Swap ${q} to ${to} in your wallet`;
    }
    case "farm_deposit":
      return `Supply ${q} to Kamino (farm) from your margin balance`;
    case "farm_redeem": {
      // The amount is in receipt tokens (kSOL), not the underlying, so name them rather than print "86.6 SOL".
      const k = s.asset ? `k${s.asset}` : "receipt tokens";
      const what = !s.amount || s.amount === "all" ? `all your ${k}` : `${s.amount} ${k}`;
      return `Redeem ${what} from Kamino (farm) back to margin`;
    }
    case "report":
      return "Report your health factor";
  }
}

/** Steps that ask the wallet for a signature. */
export function signatureCount(steps: StepSpec[]): number {
  return steps.filter((s) => s.kind === "write").length;
}

export function planWarnings(steps: StepSpec[], extra: string[] = []): string[] {
  const w = [...extra];
  const n = signatureCount(steps);
  if (n > 1) w.push(`${n} separate wallet signatures. The plan stops if you cancel partway, and every step is re-checked against live data before it is built.`);
  if (steps.some((s) => s.kind === "write" && s.amount === "all")) {
    w.push('"All" is resolved against your live balance at the moment that step is built.');
  }
  return w;
}

export function stepFromWrite(w: WriteIntent, amount: string | null): StepSpec {
  const slots: Slots = {};
  if (w.op === "swap") {
    slots.to_asset = w.to_asset ?? null;
    slots.mode = w.source === "margin" ? "margin" : "wallet";
    slots.slippage_bps = 100;
  }
  if (w.op === "repay") slots.source = w.source === "margin" ? "margin" : "wallet";
  return { kind: "write", op: w.op, asset: w.asset, amount, slots };
}

export function reportStep(): StepSpec {
  return { kind: "read", op: "report", asset: null, amount: null, slots: { report: "health" } };
}

/** A plan must be non-empty, bounded, and only contain steps the executor knows how to build. */
export function validateSteps(steps: StepSpec[]): string | null {
  if (!steps.length) return "That plan has no steps.";
  if (steps.length > MAX_PLAN_STEPS) return `A plan can have at most ${MAX_PLAN_STEPS} steps.`;
  for (const s of steps) {
    if (s.kind === "read" && s.op !== "report") return "Unsupported read step.";
    if (s.kind === "write" && s.op === "report") return "A report is not a write.";
    if (s.kind === "write" && s.op !== "create_account" && s.op !== "close_account" && !s.asset) return "A step is missing its asset.";
    if (s.kind === "write" && s.op !== "create_account" && s.op !== "close_account" && !s.amount) return "A step is missing its amount.";
  }
  return null;
}
