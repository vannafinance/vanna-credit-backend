/**
 * Types shared by the investigation stage (stage 2 of a turn: firewall -> INVESTIGATE -> size -> review -> execute ->
 * complete). The model reads the account through tools and ends with exactly one decision; code owns every number.
 */

import type { StructuredAnswer } from "../answer-schema";
import type { Intent } from "../intent";

/** One tool-backed fact the model asked for, as it was shown to the model. */
export interface Observation {
  /** Read tool name, e.g. `get_account_health`. */
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Compact JSON the model sees (and the grounding check reads). */
  result: string;
  ms: number;
}

/** A decision the code refused, fed back so the model can correct itself on the next turn. */
export interface Rejection {
  tool: string;
  reason: string;
}

export interface InvestigationLimits {
  maxTurns: number;
  maxReads: number;
  maxDurationMs: number;
  maxReadDurationMs: number;
  maxObservationChars: number;
}

/** What stage 2 hands to the rest of the turn. */
export type InvestigationOutcome =
  /** A plan or action to size, review and execute (the same intents the deterministic lanes use). */
  | { kind: "intent"; intent: Intent }
  /** A read question answered from the evidence; every figure in it was found in a tool result. */
  | { kind: "answer"; answer: StructuredAnswer }
  /** The model is unavailable or ran out of budget without a usable decision. */
  | { kind: "none"; reason: string };

export interface InvestigationTrace {
  turns: number;
  reads: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; ms: number }>;
  rejections: Rejection[];
  decision: string | null;
  tokens: number;
  ms: number;
}

export interface InvestigationResult {
  outcome: InvestigationOutcome;
  trace: InvestigationTrace;
}
