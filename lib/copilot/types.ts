/**
 * Vanna Solana Copilot — shared contracts between the browser UI, /api/copilot/* and the brain.
 *
 * Shapes deliberately mirror the Stellar Copilot (`ChatRequest` / `ChatResponse` / plan card) so the
 * ported UI keeps working; everything Stellar-only (auto-sign, wallet bind, Sign Service, page-assistant
 * attachments) is gone. Solana has one signer: the user's own wallet.
 *
 * Rule of the contract: the browser sends ONLY a message, ids, an approval and signed transactions.
 * Amounts, assets and instructions live on the server in the plan record — never echoed back by the client.
 */

import type { StructuredAnswer } from "./answer-schema";

export type { StructuredAnswer };

// ── Identity ────────────────────────────────────────────────────────────────

/** The authenticated caller, resolved server-side from the session cookie. */
export interface CopilotUser {
  /** Base58 wallet address that signed in (Sign-In-With-Solana). The only identity on Solana. */
  wallet: string;
  /** Stable key for limits, conversations and plans: sha256(wallet) hex. */
  subject: string;
  /** Session expiry, epoch ms. */
  expiresAt: number;
}

// ── Chat request ─────────────────────────────────────────────────────────────

export interface ChatRequest {
  message: string;
  /** Conversation the turn belongs to (server creates one when absent). */
  conversation_id?: string | null;
  /** Short recent history so follow-ups work ("and 2x?"). Text only, bounded by the route. */
  history?: Array<{ role: "user" | "assistant"; text: string }> | null;
  /** "copilot" = the /copilot workspace; "assistant" = floating page guide (read/explain only, never writes). */
  surface?: "assistant" | "copilot" | null;
  /**
   * Answers a clarification: the UI sends the picked option id back with the pending id the server issued.
   * The server looks the pending action up by id — the client never resends slots.
   */
  clarify?: { pending_id: string; option_id: string } | null;
}

// ── Chat response ────────────────────────────────────────────────────────────

export type ResponseKind =
  | "answer"
  | "clarification"
  | "unavailable"
  | "blocked"
  | "error"
  | "preview" // one action, simulated, waiting for the user to confirm
  | "executed"
  | "needs_wallet_sign" // an unsigned transaction is ready for the wallet
  | "needs_login" // no valid session: show Sign-In-With-Solana
  | "plan_preview"; // a multi-step plan waiting for approval

export type Venue = "earn" | "margin" | "farm" | "swap" | "wallet" | "perps" | "predict" | "other";

export interface ClarifyOption {
  id: string;
  label: string;
  description?: string;
}

export interface RiskResult {
  decision: "allow" | "block" | "needs_confirmation";
  reasons: string[];
  projected_health_factor?: number | null;
}

/** Before/after margin numbers, always read from the MCP (`can_borrow`/`can_withdraw` or the envelope preview). */
export interface Simulation {
  hf_before: number | null;
  hf_after: number | null;
  collateral_before: number;
  collateral_after: number;
  debt_before: number;
  debt_after: number;
  liquidation_threshold: number;
  amount_usd: number;
  asset?: string | null;
  /** False for ops that don't touch the margin account (Earn supply/redeem): nothing to project. */
  margin_applicable?: boolean;
}

/** One unsigned, simulated transaction handed to the wallet (from the MCP WriteEnvelope). */
export interface UnsignedTx {
  /** base64 v0 VersionedTransaction, fee payer = the user's wallet, blockhash already set. */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** MCP-side simulation result; a failed simulation is never handed to the wallet. */
  simulation_success: boolean;
  summary?: string;
  /**
   * A one-time setup the MCP returns in place of the action (since the 2026-10-09 program upgrade: the wallet's own
   * lookup table, which margin transactions now need to fit). Once it lands, the same step is built again.
   */
  prerequisite?: boolean;
  /**
   * What the prerequisite is, when the MCP says: "phoenix_fund" = a perps open too large for one transaction, whose
   * USDC moves into Phoenix first; the order is then built with `funded` (workflow/steps.ts).
   */
  prerequisite_kind?: string;
  /**
   * A Predict trade: every transaction of it (the first is `transaction`), co-signed by the app's market maker. The
   * wallet signs them all in ONE approval (signAllTransactions) and the server sends them in order, each confirmed before
   * the next. `merge_markets`: pools the app's keeper merges once the last one confirms.
   */
  batch?: { transactions: string[]; labels: string[]; merge_markets: string[] };
}

export interface Preview {
  template_id: string;
  human_summary: string;
  slots: Record<string, string | number | boolean | null>;
  risk: RiskResult;
  simulation?: Simulation | null;
  requires_signature: boolean;
}

/** Step lifecycle. A step runs at most once (server claims it); `uncertain` is never retried automatically. */
export type StepStatus =
  | "pending"
  | "building" // claimed by one server, MCP build in flight
  | "awaiting_signature" // unsigned tx delivered to the wallet
  | "submitted" // signed tx sent; waiting for confirmation
  | "confirmed"
  | "failed"
  | "expired" // blockhash expired before confirmation; rebuilt on next advance
  | "uncertain" // outcome unknown (timeout after send); needs a human look
  | "skipped"
  | "done"; // read legs

export interface PlanStepView {
  n: number;
  /** "read" legs report a number and need no signature. */
  kind: "write" | "read";
  /** Stable op name: deposit | withdraw | borrow | repay | earn_supply | earn_redeem | swap | farm_deposit | farm_redeem | report | ... */
  op: string;
  asset: string | null;
  amount: string | null;
  label: string;
  venue: Venue;
  /** Human-readable slots for the card (amounts as decimal strings). */
  slots?: Record<string, string | number | boolean | null>;
  status: StepStatus;
  signature?: string | null;
  note?: string | null;
  /** A read leg's answer, once the plan reached it. */
  answer?: StructuredAnswer | null;
}

export interface PlanView {
  plan_id: string;
  /** sha256 over every executable slot of every step — approval is bound to this. */
  digest: string;
  summary: string;
  created_at: number;
  /** Approval is refused after this (created_at + 5 min). */
  expires_at: number;
  /** Wallet signatures the user will be asked for. */
  signature_count: number;
  warnings: string[];
  /** Health-factor floor the plan sizes to (1.15 unless the user stated a higher one). */
  hf_floor: number;
  state: "proposed" | "approved" | "running" | "paused" | "completed" | "failed" | "cancelled" | "expired";
  steps: PlanStepView[];
  simulation?: Simulation | null;
}

export interface ChatResponse {
  kind: ResponseKind;
  message: string;
  answer?: StructuredAnswer | null;
  preview?: Preview | null;
  /** plan_preview: the server-held plan. To run it the client calls /api/copilot/workflow/[id]/approve with `digest`. */
  plan?: PlanView | null;
  /** Single actions are one-step plans too; this is the id to approve/advance. */
  workflow_id?: string | null;
  /** needs_wallet_sign: the transaction for the wallet. */
  unsigned_tx?: UnsignedTx | null;
  clarify_options?: ClarifyOption[] | null;
  /** Issued with clarify_options; send back as `clarify.pending_id`. */
  pending_id?: string | null;
  request_id?: string | null;
  conversation_id?: string | null;
  execution?: {
    status: string;
    signature?: string | null;
    explorer_url?: string | null;
    hf_after?: number | null;
  } | null;
  /** Always present when a limit was hit or is close (429-style info for the UI). */
  limit?: { kind: "rate" | "daily_tokens" | "spend"; retry_after_s?: number | null; message: string } | null;
}

// ── Workflow (plan) API ─────────────────────────────────────────────────────

/** POST /api/copilot/workflow/[id]/approve  {digest} */
export interface ApproveRequest {
  digest: string;
}

/**
 * POST /api/copilot/workflow/[id]/advance
 * Claims the next step (exactly once), does fresh checks, builds it through the MCP.
 * Returns the unsigned tx for a write step, runs read steps inline, or reports paused/completed.
 */
export interface AdvanceResponse {
  plan: PlanView;
  /** The step that was just claimed, when one was. */
  step?: PlanStepView | null;
  unsigned_tx?: UnsignedTx | null;
  /** Why the plan paused (health floor, price moved, simulation failed, ...). */
  pause_reason?: string | null;
  message?: string | null;
  answer?: StructuredAnswer | null;
}

/** POST /api/copilot/workflow/[id]/submit  {step_n, signed_tx} — server sends it; never trusts the client's amounts. */
export interface SubmitRequest {
  step_n: number;
  /** base64 signed v0 transaction. Must match the unsigned tx the server built for this step. */
  signed_tx: string;
  /** A Predict trade (UnsignedTx.batch): every transaction, signed in one approval, in the order built. */
  signed_txs?: string[];
}
export interface SubmitResponse {
  plan: PlanView;
  signature: string | null;
  status: StepStatus;
  message?: string | null;
}

/** POST /api/copilot/workflow/[id]/confirm  {step_n} — polls the chain; idempotent. */
export interface ConfirmRequest {
  step_n: number;
}
export interface ConfirmResponse {
  plan: PlanView;
  status: StepStatus;
  signature?: string | null;
  explorer_url?: string | null;
  message?: string | null;
}

// ── Auth API (Sign-In-With-Solana) ──────────────────────────────────────────

/** GET /api/copilot/auth/nonce?wallet=<base58> -> message to sign */
export interface NonceResponse {
  nonce: string;
  /** The exact UTF-8 message the wallet must signMessage (SIWS-style, domain + nonce + issued-at + expiry). */
  message: string;
  expires_at: number;
}
/** POST /api/copilot/auth/verify  {wallet, message, signature(base64)} -> sets the session cookie */
export interface VerifyRequest {
  wallet: string;
  message: string;
  signature: string;
}
export interface SessionResponse {
  authenticated: boolean;
  wallet?: string | null;
  expires_at?: number | null;
}

// ── Health ───────────────────────────────────────────────────────────────────

export interface BrainHealth {
  status: "ok" | "degraded";
  chain: "solana";
  llm: { provider: "vertex"; model: string; auth: "attached_service_account" | "service_account" | "workload_identity" | "developer_login" | "unknown" };
  mcp: { base_url: string; reachable?: boolean; tools?: number; auth: "workos_m2m" | "none" };
  store: { kind: "firestore" | "local_file"; project?: string | null; database?: string | null };
  auth: { siws: boolean };
}
