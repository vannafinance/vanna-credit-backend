/**
 * Stored shapes for plans ("workflows"). One record per plan in the `solana_copilot_workflows`
 * collection, sealed at rest and written only through compare-and-set, so a step can never be
 * claimed or sent twice even with several server instances.
 */

import type { PlanView, Simulation, StepStatus, StructuredAnswer, Venue } from "../types";
import type { Slots, StepSpec } from "../plan";

export interface StoredTx {
  /** base64 v0 message with empty signatures, exactly as the MCP built it. */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  built_at: number;
  summary?: string;
}

export interface StoredStep extends StepSpec {
  n: number;
  label: string;
  venue: Venue;
  status: StepStatus;
  /** Random token of the request that claimed the step for building. */
  claim: string | null;
  claimed_at: number | null;
  tx: StoredTx | null;
  signature: string | null;
  submitted_at: number | null;
  /** USD value checked against the spend caps before building; counted once the wallet signed. */
  usd: number | null;
  note: string | null;
  /** Amount as resolved when the step was last built ("all" becomes the live figure). Display only: never hashed. */
  resolved: string | null;
  /** Build attempts (a rebuilt step after an expired blockhash counts again). Never incremented by a send. */
  builds: number;
  /** A read leg's answer, once it ran. */
  answer?: StructuredAnswer | null;
}

export type WorkflowState = PlanView["state"];

export interface WorkflowRecord {
  v: 1;
  id: string;
  subject: string;
  wallet: string;
  digest: string;
  summary: string;
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  hf_floor: number;
  state: WorkflowState;
  pause_reason: string | null;
  warnings: string[];
  simulation: Simulation | null;
  steps: StoredStep[];
  request_id: string | null;
  conversation_id: string | null;
  /** Bounded audit trail: what happened, when. No amounts beyond what the steps hold. */
  log: Array<{ at: number; event: string }>;
}

export class WorkflowError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "bad_request"
      | "conflict"
      | "expired"
      | "digest_mismatch"
      | "not_approved"
      | "tx_mismatch"
      | "limit",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export function specOf(step: StoredStep): StepSpec {
  const slots: Slots = step.slots;
  return { kind: step.kind, op: step.op, asset: step.asset, amount: step.amount, slots };
}
