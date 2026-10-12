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
import type { ReadCall, ReadLeg, WriteIntent, WriteOp } from "./intent";
import { PERP_OPS, VAULT_NAMES, VAULT_OPS, type VaultId } from "./intent";

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
/** "Show me" legs a plan may hold besides its transactions (they ask for no signature). */
export const MAX_PLAN_READS = 6;
/** Read tool calls one read leg may make. */
export const MAX_LEG_READS = 4;

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
  perp_open: "perps",
  perp_close: "perps",
  perp_withdraw: "perps",
  perp_register: "perps",
  // The vaults live on the app's Farm page.
  vault_deposit: "farm",
  vault_withdraw: "farm",
  vault_move_shares: "farm",
  report: "other",
};

/** Ops that lower (or can lower) the health factor: gated by the risk floor. */
export const RISK_INCREASING: ReadonlySet<Op> = new Set<Op>(["borrow", "withdraw", "swap", "perp_open"]);

/** Ops that touch the margin account (need one, and a health read before/after). */
export const MARGIN_OPS: ReadonlySet<Op> = new Set<Op>(["deposit", "withdraw", "borrow", "repay", "farm_deposit", "farm_redeem", "close_account", "perp_open", "perp_close", "perp_withdraw", "perp_register", "vault_deposit", "vault_withdraw", "vault_move_shares"]);

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

/**
 * Assets a swap INSIDE the margin account cannot buy because the transaction would exceed Solana's size limit.
 * A lever on one of them would deposit and borrow and then fail on the swap, so it is refused up front.
 *
 * Empty since the MCP builds margin swaps with the protocol lookup table and a size-capped Jupiter route
 * (Vanna_MCP_Solana vanna_core/protocol_alt.py, contracts/swap.py): JupSOL and JitoSOL, which always overflowed
 * before, now fit with room to spare. Kept as a safety valve: add a symbol here if a pair is ever unbuildable.
 */
export const MARGIN_SWAP_BLOCKED_TARGETS: Set<string> = new Set();

export const marginSwapBlockedMessage = (asset: string): string =>
  `A swap that buys ${asset} inside your margin account is too large for one Solana transaction on this network, at any amount. ` +
  `Swap in your wallet instead ("swap 20 USDC to ${asset}"), then deposit it as collateral.`;

/**
 * A swap sized by what the user wants to RECEIVE carries its amount as "out:<target>" until the step is built;
 * the input is then sized from live quotes so the minimum received is at least the target.
 */
export const OUT_PREFIX = "out:";
export const outTarget = (amount: string | null): string | null => (amount && amount.startsWith(OUT_PREFIX) ? amount.slice(OUT_PREFIX.length) : null);

/**
 * A step sized to leave the health factor at a target carries its amount as "hf:<target>" until the step is built; it is
 * then sized from the account as it is at that moment (after every earlier step).
 */
export const HF_PREFIX = "hf:";
export const hfTarget = (amount: string | null): number | null => {
  if (!amount || !amount.startsWith(HF_PREFIX)) return null;
  const n = Number(amount.slice(HF_PREFIX.length));
  return Number.isFinite(n) ? n : null;
};

const fmtQty = (amount: string | null, asset: string | null): string => {
  if (!amount && !asset) return "";
  return `${amount === "all" ? "all" : amount ?? ""} ${asset ?? ""}`.trim();
};

export function labelFor(s: StepSpec): string {
  const q = fmtQty(s.amount, s.asset);
  const hf = hfTarget(s.amount);
  if (hf !== null && s.asset) {
    const t = hf.toFixed(2);
    if (s.op === "borrow") return `Borrow ${s.asset} down to a health factor of ${t}`;
    if (s.op === "withdraw") return `Withdraw ${s.asset} down to a health factor of ${t}`;
    if (s.op === "repay") return `Repay ${s.asset} ${s.slots.source === "margin" ? "from your margin balance" : "from your wallet"} up to a health factor of ${t}`;
    if (s.op === "deposit") return `Deposit ${s.asset} as margin collateral up to a health factor of ${t}`;
  }
  switch (s.op) {
    case "perp_register":
      return "Create your Phoenix trading account (first perps trade only)";
    case "perp_open":
      return `Open a ${String(s.slots.leverage)}x ${String(s.slots.side)} on ${String(s.slots.market)}-PERP with ${s.amount ?? ""} USDC (Phoenix)`;
    case "perp_close":
      return typeof s.slots.fraction === "number" && s.slots.fraction < 1
        ? `Close ${Math.round(s.slots.fraction * 100)}% of your ${String(s.slots.market)}-PERP position`
        : `Close your ${String(s.slots.market)}-PERP position`;
    case "perp_withdraw":
      return s.amount && s.amount !== "all" ? `Move ${s.amount} USDC from Phoenix back to your margin account` : "Move your USDC from Phoenix back to your margin account";
    case "vault_deposit": {
      const v = VAULT_NAMES[s.slots.vault as VaultId]?.name ?? String(s.slots.vault);
      return `Deposit ${s.amount ?? ""} USDC from your margin account into ${v}`;
    }
    case "vault_withdraw": {
      const v = VAULT_NAMES[s.slots.vault as VaultId];
      return s.amount && s.amount !== "all"
        ? `Withdraw ${s.amount} ${v?.symbol ?? ""} shares from ${v?.name ?? String(s.slots.vault)} to USDC`
        : `Withdraw all your ${v?.name ?? String(s.slots.vault)} shares to USDC`;
    }
    case "vault_move_shares":
      return `Move your ${VAULT_NAMES[s.slots.vault as VaultId]?.name ?? String(s.slots.vault)} shares from the wallet into your margin account`;
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
      const target = outTarget(s.amount);
      if (target) {
        const where = s.slots.mode === "margin" ? "inside your margin account" : "in your wallet";
        return `Swap ${s.asset ?? ""} to receive at least ${target} ${to} ${where}`;
      }
      const via = s.slots.provider === "titan" ? " via Titan" : s.slots.provider === "jupiter" ? " via Jupiter" : "";
      return s.slots.mode === "margin"
        ? `Swap ${q} to ${to}${via} inside your margin account`
        : `Swap ${q} to ${to}${via} in your wallet`;
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
      return typeof s.slots.label === "string" && s.slots.label ? s.slots.label : "Report your health factor";
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

/** "Titan" / "Jupiter" for a swap route as users read it. */
export function providerName(provider: string | null | undefined): string {
  return provider === "titan" ? "Titan" : "Jupiter";
}

/**
 * The balances a planned step changes, as "place:ASSET" keys (wallet, margin, debt, earn, farm), or "*" for a step
 * that may change any of them (perps, vaults, account steps). Used to tell whether a later percentage can be sized now.
 */
export function balancesTouched(s: StepSpec): string[] {
  const a = String(s.asset ?? "");
  switch (s.op) {
    case "deposit":
    case "withdraw":
      return [`wallet:${a}`, `margin:${a}`];
    case "earn_supply":
    case "earn_redeem":
      return [`wallet:${a}`, `earn:${a}`];
    case "farm_deposit":
    case "farm_redeem":
      return [`margin:${a}`, `farm:${a}`];
    case "borrow":
      return [`margin:${a}`, `debt:${a}`];
    case "repay":
      return [`debt:${a}`, `${s.slots.source === "margin" ? "margin" : "wallet"}:${a}`];
    case "swap": {
      const place = s.slots.mode === "margin" ? "margin" : "wallet";
      return [`${place}:${a}`, `${place}:${String(s.slots.to_asset ?? "")}`];
    }
    default:
      return ["*"];
  }
}

/**
 * The balance a percentage in this write is a share of ("place:ASSET"), or null when it depends on the whole account
 * (a borrow's safe size moves with every earlier step).
 */
export function percentBalance(w: WriteIntent): string | null {
  const a = String(w.asset ?? "");
  switch (w.op) {
    case "deposit":
    case "earn_supply":
      return `wallet:${a}`;
    case "swap":
      return `${w.source === "margin" ? "margin" : "wallet"}:${a}`;
    case "withdraw":
      return `margin:${a}`;
    case "earn_redeem":
      return `earn:${a}`;
    case "farm_redeem":
      return `farm:${a}`;
    case "repay":
      return `debt:${a}`;
    default:
      return null;
  }
}

export function stepFromWrite(w: WriteIntent, amount: string | null): StepSpec {
  const slots: Slots = {};
  if (w.op === "swap") {
    slots.to_asset = w.to_asset ?? null;
    slots.mode = w.source === "margin" ? "margin" : "wallet";
    slots.slippage_bps = 100;
    if (w.provider) slots.provider = w.provider;
  }
  if (w.op === "repay") slots.source = w.source === "margin" ? "margin" : "wallet";
  if (w.op === "perp_open") {
    slots.market = w.market ?? null;
    slots.side = w.side ?? null;
    slots.leverage = w.leverage ?? null;
  }
  if (w.op === "perp_close") {
    slots.market = w.market ?? null;
    if (w.amount?.kind === "pct" && w.amount.pct < 100) slots.fraction = w.amount.pct / 100;
    return { kind: "write", op: w.op, asset: null, amount: null, slots };
  }
  if (w.op === "perp_register") return { kind: "write", op: w.op, asset: null, amount: null, slots };
  if (VAULT_OPS.has(w.op)) {
    slots.vault = w.vault ?? null;
    return { kind: "write", op: w.op, asset: null, amount: w.op === "vault_move_shares" ? (amount ?? "all") : amount, slots };
  }
  return { kind: "write", op: w.op, asset: w.asset, amount, slots };
}

export function reportStep(): StepSpec {
  return { kind: "read", op: "report", asset: null, amount: null, slots: { report: "health" } };
}

/** A read leg as a plan step. Its reads are part of the approved plan, so they are hashed with it. */
export function readLegStep(leg: ReadLeg): StepSpec {
  return { kind: "read", op: "report", asset: null, amount: null, slots: { report: "reads", question: leg.question, label: leg.label, reads: JSON.stringify(leg.reads) } };
}

/** The read leg a stored step carries, or null for the health report (and for anything malformed). */
export function readLegOf(s: Pick<StepSpec, "slots">): ReadLeg | null {
  if (s.slots.report !== "reads" || typeof s.slots.reads !== "string") return null;
  try {
    const reads = JSON.parse(s.slots.reads) as ReadCall[];
    if (!Array.isArray(reads) || !reads.length || reads.length > MAX_LEG_READS) return null;
    if (!reads.every((r) => r && typeof r.tool === "string" && r.args && typeof r.args === "object" && !Array.isArray(r.args))) return null;
    return { question: String(s.slots.question ?? ""), label: String(s.slots.label ?? ""), reads };
  } catch {
    return null;
  }
}

/** A plan must be non-empty, bounded, and only contain steps the executor knows how to build. */
export function validateSteps(steps: StepSpec[]): string | null {
  if (!steps.length) return "That plan has no steps.";
  if (steps.filter((s) => s.kind === "write").length > MAX_PLAN_STEPS) return `A plan can have at most ${MAX_PLAN_STEPS} steps.`;
  if (steps.filter((s) => s.kind === "read").length > MAX_PLAN_READS) return `A plan can show at most ${MAX_PLAN_READS} things along the way.`;
  for (const s of steps) {
    if (s.kind === "read" && s.op !== "report") return "Unsupported read step.";
    if (s.kind === "read" && s.slots.report === "reads" && !readLegOf(s)) return "A step that shows information is malformed.";
    if (s.kind === "write" && s.op === "report") return "A report is not a write.";
    if (s.kind === "write" && VAULT_OPS.has(s.op as WriteOp)) {
      // Vaults name a vault, not an asset: a deposit is USDC, a withdrawal shares (or all).
      if (!s.slots.vault) return "A vault step is missing its vault.";
      if (s.op === "vault_deposit" && !s.amount) return "A vault deposit is missing its USDC amount.";
      continue;
    }
    if (s.kind === "write" && PERP_OPS.has(s.op as WriteOp)) {
      // Perps name a market, not an asset; a close and the registration carry no amount.
      if ((s.op === "perp_open" || s.op === "perp_close") && !s.slots.market) return "A perps step is missing its market.";
      if (s.op === "perp_open" && !s.amount) return "A perps order is missing its USDC collateral.";
      continue;
    }
    if (s.kind === "write" && s.op !== "create_account" && s.op !== "close_account" && !s.asset) return "A step is missing its asset.";
    if (s.kind === "write" && s.op !== "create_account" && s.op !== "close_account" && !s.amount) return "A step is missing its amount.";
  }
  return null;
}
