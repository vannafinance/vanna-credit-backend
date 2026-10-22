/**
 * The reply once a plan has run: what was done, in place of the approval and run cards.
 *
 * Built only from the server's plan (its confirmed steps and their labels), never from the
 * reply written before approval, which ended in an instruction to approve. Every step label
 * is ours (plan.ts `labelFor`: "<Verb> <amount> <asset> ..."), so turning its first verb into
 * the past tense keeps the amounts and venues exactly as the card showed them.
 */
import type { PlanStepView, PlanView } from "@/lib/copilot/types";

const PAST: Record<string, string> = {
  add: "added",
  borrow: "borrowed",
  buy: "bought",
  close: "closed",
  create: "created",
  deposit: "deposited",
  lever: "levered",
  move: "moved",
  open: "opened",
  redeem: "redeemed",
  repay: "repaid",
  sell: "sold",
  supply: "supplied",
  swap: "swapped",
  withdraw: "withdrew",
};

/** Beyond this many steps the reply counts them instead of listing every one. */
const LISTED_STEPS = 3;

const DONE_STATUS = new Set(["confirmed", "done"]);

function pastVerb(word: string): string | null {
  return PAST[word.toLowerCase()] ?? null;
}

/** "Supply 5 USDC to the Vanna Earn pool" -> "supplied 5 USDC to the Vanna Earn pool". */
export function doneClause(label: string): string {
  // A Predict trade reads "Predict: Sell 2 Yes shares of X, buy Yes on Y for 1 CASH (Event)".
  const text = label.trim().replace(/^Predict:\s*/, "");
  const legs = text.split(/,\s+(?=(?:buy|sell|move)\s)/i);
  const done = legs.map((leg) => {
    const [first, ...rest] = leg.split(/\s+/);
    const verb = first ? pastVerb(first) : null;
    return verb ? [verb, ...rest].join(" ") : leg;
  });
  return done.join(", ");
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The finished reply for a completed plan, or null when it has not completed. */
export function completionSummary(plan: PlanView): string | null {
  if (plan.state !== "completed") return null;
  const writes: PlanStepView[] = plan.steps.filter((s) => s.kind === "write" && DONE_STATUS.has(s.status));
  if (!writes.length) return null;
  if (writes.length > LISTED_STEPS) {
    return `Done. All ${writes.length} transactions are confirmed on chain.`;
  }
  const listed = writes.map((s) => doneClause(s.label)).join(", then ");
  return `Done. ${capitalise(listed).replace(/[.\s]+$/, "")}.`;
}
