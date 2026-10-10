/**
 * Plan / workflow state machine over the durable RecordStore.
 *
 *   proposed --approve(digest, <=5 min)--> approved --advance--> running --(per step)-->
 *     building -> awaiting_signature -> submitted -> confirmed | failed | expired | uncertain
 *
 * Invariants (each one is tested):
 *   - The approval is bound to the digest of every executable slot and to the wallet; the record is
 *     re-hashed on approve, so a tampered stored plan cannot be approved.
 *   - A step is CLAIMED by compare-and-set before its MCP build, so two servers (or two clicks)
 *     build it once. A build is safe to redo (nothing is signed); a SEND is not, so the step is
 *     marked `submitted` by compare-and-set BEFORE the transaction is broadcast and is never
 *     re-sent. An unclear outcome is `uncertain` and only a human-triggered confirm can resolve it.
 *   - Nothing is "done" until a signature is confirmed on chain.
 *   - Fresh checks (limits, risk floor, live balances) run before each step is built; a failed
 *     check pauses the plan, it never pushes through.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { copilotConfig } from "./config";
import { answerToText, type StructuredAnswer } from "./answer-schema";
import { humanizeFailure } from "./explain";
import { recordSpend } from "./limits";
import type { ReadCtx } from "./mcp-facts";
import { MAX_PLAN_STEPS, PLAN_TTL_MS, RUN_WINDOW_MS, VENUE_BY_OP, labelFor, planDigest, signatureCount, validateSteps, type StepSpec } from "./plan";
import { workflowStore, type RecordStore } from "./store";
import { explorerUrl } from "../solana/config";
import type {
  AdvanceResponse,
  ConfirmRequest,
  ConfirmResponse,
  CopilotUser,
  PlanStepView,
  PlanView,
  Simulation,
  StepStatus,
  SubmitRequest,
  SubmitResponse,
  UnsignedTx,
} from "./types";
import { buildStepTx, preflightStep, runReadStep } from "./workflow/steps";
import { verifySignedTx } from "./workflow/submit-verify";
import { WorkflowError, specOf, type StoredStep, type WorkflowRecord, type WorkflowState } from "./workflow/types";
import { getConnection } from "../solana/connection";

export { WorkflowError };
export type { WorkflowRecord };

// ── Seams (tests replace these; production uses the defaults) ───────────────

export type SignatureState = { state: "confirmed" } | { state: "failed"; err: string } | { state: "pending" };

export interface WorkflowDeps {
  store(): RecordStore<WorkflowRecord>;
  now(): number;
  uuid(): string;
  blockHeight(): Promise<number>;
  send(raw: Uint8Array): Promise<string>;
  signatureState(signature: string): Promise<SignatureState>;
  preflight: typeof preflightStep;
  build: typeof buildStepTx;
  readStep: typeof runReadStep;
  recordSpend: typeof recordSpend;
}

let cachedStore: RecordStore<WorkflowRecord> | null = null;

export const workflowDeps: WorkflowDeps = {
  store: () => (cachedStore ??= workflowStore<WorkflowRecord>()),
  now: () => Date.now(),
  uuid: () => randomUUID(),
  blockHeight: () => getConnection().getBlockHeight("confirmed"),
  send: (raw) => getConnection().sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }),
  signatureState: async (signature) => {
    const res = await getConnection().getSignatureStatuses([signature], { searchTransactionHistory: true });
    const s = res.value[0];
    if (!s) return { state: "pending" };
    if (s.err) return { state: "failed", err: JSON.stringify(s.err) };
    if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return { state: "confirmed" };
    return { state: "pending" };
  },
  preflight: preflightStep,
  build: buildStepTx,
  readStep: runReadStep,
  recordSpend,
};

/** A build that has not delivered a transaction within this window is presumed dead and may be re-claimed. */
export const STALE_BUILD_MS = 90_000;

const TERMINAL: ReadonlySet<WorkflowState> = new Set(["completed", "failed", "cancelled", "expired"]);
const DONE: ReadonlySet<StepStatus> = new Set(["confirmed", "done", "skipped"]);

// ── Creation ────────────────────────────────────────────────────────────────

export interface NewWorkflow {
  user: CopilotUser;
  summary: string;
  steps: StepSpec[];
  warnings?: string[];
  simulation?: Simulation | null;
  hfFloor?: number;
  requestId?: string | null;
  conversationId?: string | null;
}

export async function createWorkflow(n: NewWorkflow): Promise<WorkflowRecord> {
  const invalid = validateSteps(n.steps);
  if (invalid) throw new WorkflowError("bad_request", invalid, 400);
  const now = workflowDeps.now();
  const hfFloor = n.hfFloor ?? copilotConfig.minHealthFactor;
  const id = workflowDeps.uuid();
  const rec: WorkflowRecord = {
    v: 1,
    id,
    subject: n.user.subject,
    wallet: n.user.wallet,
    digest: planDigest(n.user.wallet, hfFloor, n.steps),
    summary: n.summary,
    created_at: now,
    expires_at: now + PLAN_TTL_MS,
    approved_at: null,
    hf_floor: hfFloor,
    state: "proposed",
    pause_reason: null,
    warnings: n.warnings ?? [],
    simulation: n.simulation ?? null,
    steps: n.steps.map((s, i) => ({
      ...s,
      slots: { ...s.slots },
      n: i + 1,
      label: labelFor(s),
      venue: VENUE_BY_OP[s.op],
      status: "pending" as StepStatus,
      claim: null,
      claimed_at: null,
      tx: null,
      signature: null,
      submitted_at: null,
      usd: null,
      note: null,
      resolved: null,
      builds: 0,
    })),
    request_id: n.requestId ?? null,
    conversation_id: n.conversationId ?? null,
    log: [{ at: now, event: "proposed" }],
  };
  const ok = await workflowDeps.store().write(id, null, rec);
  if (!ok) throw new WorkflowError("conflict", "A plan with that id already exists.", 409);
  return rec;
}

// ── Views ───────────────────────────────────────────────────────────────────

export function toStepView(s: StoredStep): PlanStepView {
  return {
    n: s.n,
    kind: s.kind,
    op: s.op,
    asset: s.asset,
    amount: s.resolved ?? s.amount,
    label: s.label,
    venue: s.venue,
    slots: s.slots,
    status: s.status,
    signature: s.signature,
    note: s.note,
    ...(s.answer ? { answer: s.answer } : {}),
  };
}

export function toPlanView(rec: WorkflowRecord): PlanView {
  return {
    plan_id: rec.id,
    digest: rec.digest,
    summary: rec.summary,
    created_at: rec.created_at,
    expires_at: rec.expires_at,
    signature_count: signatureCount(rec.steps.map(specOf)),
    warnings: rec.warnings,
    hf_floor: rec.hf_floor,
    state: rec.state,
    steps: rec.steps.map(toStepView),
    simulation: rec.simulation,
  };
}

const toUnsigned = (tx: NonNullable<StoredStep["tx"]>): UnsignedTx => ({
  transaction: tx.transaction,
  blockhash: tx.blockhash,
  lastValidBlockHeight: tx.lastValidBlockHeight,
  simulation_success: true,
  ...(tx.summary ? { summary: tx.summary } : {}),
});

// ── Store access with compare-and-set ───────────────────────────────────────

async function load(id: string, user: CopilotUser): Promise<{ rec: WorkflowRecord; version: string }> {
  let stored;
  try {
    stored = await workflowDeps.store().read(id);
  } catch (e) {
    if (e instanceof Error && e.message === "invalid_record_id") throw new WorkflowError("not_found", "Plan not found.", 404);
    throw e;
  }
  // A plan that belongs to another wallet is indistinguishable from one that does not exist.
  if (!stored || stored.value.subject !== user.subject || stored.value.wallet !== user.wallet) {
    throw new WorkflowError("not_found", "Plan not found.", 404);
  }
  return { rec: stored.value, version: stored.version };
}

export async function getWorkflow(id: string, user: CopilotUser): Promise<WorkflowRecord> {
  const { rec } = await load(id, user);
  return withLazyExpiry(rec, workflowDeps.now());
}

/** A proposed plan past its TTL, or an approved plan past its run window, reads as expired without a write. */
function withLazyExpiry(rec: WorkflowRecord, now: number): WorkflowRecord {
  if (rec.state === "proposed" && now > rec.expires_at) return { ...rec, state: "expired" };
  return rec;
}

type Update<R> = { next: WorkflowRecord; out: R } | { next: null; out: R };

/**
 * Read-decide-write with retry. `fn` is re-evaluated against the freshly read record on every
 * retry, so a claim that another request won is re-decided instead of overwritten.
 */
async function update<R>(id: string, user: CopilotUser, fn: (rec: WorkflowRecord, now: number) => Update<R>): Promise<{ rec: WorkflowRecord; out: R }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { rec, version } = await load(id, user);
    const now = workflowDeps.now();
    const d = fn(rec, now);
    if (d.next === null) return { rec, out: d.out };
    const next = settle(d.next, now);
    if (await workflowDeps.store().write(id, version, next)) return { rec: next, out: d.out };
  }
  throw new WorkflowError("conflict", "The plan is busy. Try again in a moment.", 409);
}

const logEvent = (rec: WorkflowRecord, now: number, event: string): WorkflowRecord["log"] => [...rec.log, { at: now, event }].slice(-60);

function withStep(rec: WorkflowRecord, n: number, patch: Partial<StoredStep>): WorkflowRecord {
  return { ...rec, steps: rec.steps.map((s) => (s.n === n ? { ...s, ...patch } : s)) };
}

/** Plan state follows from its steps; explicit states (proposed, cancelled, expired) are never overridden. */
function settle(rec: WorkflowRecord, now: number): WorkflowRecord {
  if (rec.state === "proposed" || rec.state === "cancelled" || rec.state === "expired") return rec;
  const statuses = rec.steps.map((s) => s.status);
  if (statuses.some((s) => s === "failed")) return { ...rec, state: "failed" };
  if (statuses.every((s) => DONE.has(s))) return { ...rec, state: "completed", pause_reason: null, log: logEvent(rec, now, "completed") };
  if (statuses.some((s) => s === "uncertain")) {
    return { ...rec, state: "paused", pause_reason: "A transaction's outcome is unknown. Check its status before doing anything else." };
  }
  return rec;
}

const nextStep = (rec: WorkflowRecord): StoredStep | undefined => rec.steps.find((s) => !DONE.has(s.status));

// ── Approve ─────────────────────────────────────────────────────────────────

function digestEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function approveWorkflow(id: string, digest: string, user: CopilotUser): Promise<PlanView> {
  type Out = { error: WorkflowError } | { ok: true };
  const { rec, out } = await update<Out>(id, user, (r, now) => {
    if (r.state !== "proposed") {
      if (r.state === "expired") return { next: null, out: { error: new WorkflowError("expired", "This plan has expired. Ask again and I'll draw up a fresh one.", 410) } };
      return { next: null, out: { error: new WorkflowError("conflict", `This plan is already ${r.state}.`, 409) } };
    }
    if (now > r.expires_at) {
      return {
        next: { ...r, state: "expired", log: logEvent(r, now, "expired_before_approval") },
        out: { error: new WorkflowError("expired", "That plan sat for more than 5 minutes, so I've withdrawn it: prices and balances have moved. Ask again for a fresh one.", 410) },
      };
    }
    if (typeof digest !== "string" || !digestEquals(digest, r.digest)) {
      return { next: null, out: { error: new WorkflowError("digest_mismatch", "That approval doesn't match the plan I'm holding, so I did not run anything. Ask again and approve the new plan.", 409) } };
    }
    // Re-hash what is stored: an edited record cannot be approved under its old digest.
    if (!digestEquals(planDigest(r.wallet, r.hf_floor, r.steps.map(specOf)), r.digest)) {
      return { next: null, out: { error: new WorkflowError("digest_mismatch", "The stored plan failed its integrity check, so I did not run it.", 409) } };
    }
    return { next: { ...r, state: "approved", approved_at: now, log: logEvent(r, now, "approved") }, out: { ok: true } };
  });
  if ("error" in out) throw out.error;
  return toPlanView(rec);
}

export async function cancelWorkflow(id: string, user: CopilotUser): Promise<PlanView> {
  const { rec } = await update<null>(id, user, (r, now) => {
    if (TERMINAL.has(r.state)) return { next: null, out: null };
    const inFlight = r.steps.some((s) => s.status === "submitted" || s.status === "uncertain");
    if (inFlight) throw new WorkflowError("conflict", "A transaction is already on its way; it can't be cancelled. Wait for its result.", 409);
    return { next: { ...r, state: "cancelled", log: logEvent(r, now, "cancelled") }, out: null };
  });
  return toPlanView(rec);
}

// ── Advance ─────────────────────────────────────────────────────────────────

function view(rec: WorkflowRecord, extra: Partial<AdvanceResponse> = {}): AdvanceResponse {
  return { plan: toPlanView(rec), ...extra };
}

export async function advanceWorkflow(id: string, user: CopilotUser, ctx: Omit<ReadCtx, "user"> = {}): Promise<AdvanceResponse> {
  const rctx: ReadCtx = { ...ctx, user };
  const token = workflowDeps.uuid();
  let answer: StructuredAnswer | null = null;

  for (let guard = 0; guard < MAX_PLAN_STEPS * 2 + 2; guard++) {
    const { rec } = await load(id, user);
    const now = workflowDeps.now();
    const current = withLazyExpiry(rec, now);

    if (current.state === "proposed") throw new WorkflowError("not_approved", "Approve the plan first.", 409);
    if (TERMINAL.has(current.state)) {
      return view(current, { answer, message: terminalMessage(current) });
    }
    if (current.approved_at !== null && now > current.approved_at + RUN_WINDOW_MS && !current.steps.some((s) => s.status === "awaiting_signature" || s.status === "submitted")) {
      const { rec: expired } = await update<null>(id, user, (r, t) => (TERMINAL.has(r.state) ? { next: null, out: null } : { next: { ...r, state: "expired", log: logEvent(r, t, "run_window_elapsed") }, out: null }));
      return view(expired, { message: "This plan was approved too long ago to keep running. Ask again for a fresh one." });
    }

    const step = nextStep(current);
    if (!step) {
      const { rec: done } = await update<null>(id, user, (r) => ({ next: { ...r }, out: null }));
      return view(done, { answer, message: "All steps are confirmed." });
    }

    // ── read leg ──
    if (step.kind === "read") {
      if (step.status === "pending") {
        const outcome = await workflowDeps.readStep(step, rctx);
        answer = outcome.answer;
        await update<null>(id, user, (r, t) =>
          r.steps.find((s) => s.n === step.n)?.status === "pending"
            ? { next: { ...withStep(r, step.n, { status: "done", answer: outcome.answer, note: null }), log: logEvent(r, t, `read_done:${step.n}`) }, out: null }
            : { next: null, out: null },
        );
      }
      continue;
    }

    switch (step.status) {
      case "submitted":
        return view(current, { step: toStepView(step), message: "Waiting for this transaction to confirm." });
      case "uncertain":
        return view(current, { step: toStepView(step), pause_reason: current.pause_reason, message: "I can't tell whether this transaction landed. Check its status; I will not send it again on my own." });
      case "failed":
        return view(current, { step: toStepView(step), message: step.note ?? "This step failed." });
      case "awaiting_signature": {
        if (step.tx && (await isExpired(step.tx.lastValidBlockHeight))) {
          await update<null>(id, user, (r, t) =>
            r.steps.find((s) => s.n === step.n)?.status === "awaiting_signature"
              ? { next: { ...withStep(r, step.n, { status: "expired", tx: null, note: "The transaction expired before it was sent; it will be rebuilt." }), log: logEvent(r, t, `expired:${step.n}`) }, out: null }
              : { next: null, out: null },
          );
          continue;
        }
        return view(current, { step: toStepView(step), unsigned_tx: step.tx ? toUnsigned(step.tx) : null, message: "Waiting for your wallet to sign." });
      }
      case "building": {
        if (step.claimed_at !== null && now - step.claimed_at < STALE_BUILD_MS) {
          return view(current, { step: toStepView(step), message: "This step is being prepared." });
        }
        break; // a dead claim: fall through to re-claim below
      }
      default:
        break;
    }

    // ── claim (pending | expired | stale building) ──
    const claim = await update<boolean>(id, user, (r, t) => {
      const s = r.steps.find((x) => x.n === step.n);
      if (!s) return { next: null, out: false };
      const claimable = s.status === "pending" || s.status === "expired" || (s.status === "building" && s.claimed_at !== null && t - s.claimed_at >= STALE_BUILD_MS);
      if (!claimable) return { next: null, out: false };
      if (r.state !== "approved" && r.state !== "running" && r.state !== "paused") return { next: null, out: false };
      return {
        next: { ...withStep(r, step.n, { status: "building", claim: token, claimed_at: t, builds: s.builds + 1, note: null }), state: "running", pause_reason: null, log: logEvent(r, t, `claimed:${step.n}`) },
        out: true,
      };
    });
    if (!claim.out) continue; // someone else claimed it; the next pass reports its state

    const claimed = claim.rec.steps.find((s) => s.n === step.n) as StoredStep;
    const pause = async (message: string, status: StepStatus = "pending"): Promise<AdvanceResponse> => {
      const { rec: paused } = await update<null>(id, user, (r, t) => {
        const s = r.steps.find((x) => x.n === step.n);
        if (!s || s.claim !== token) return { next: null, out: null };
        return { next: { ...withStep(r, step.n, { status, claim: null, claimed_at: null, note: message }), state: "paused", pause_reason: message, log: logEvent(r, t, `paused:${step.n}`) }, out: null };
      });
      return view(paused, { step: toStepView(paused.steps.find((s) => s.n === step.n) ?? claimed), pause_reason: message, message });
    };

    let pre;
    try {
      pre = await workflowDeps.preflight(claimed, rctx);
    } catch (e) {
      return pause(`I couldn't run the pre-checks for this step: ${humanizeFailure(e instanceof Error ? e.message : String(e))}`);
    }
    if (!pre.ok) return pause(pre.message);
    if ("skip" in pre) {
      await update<null>(id, user, (r, t) => {
        const s = r.steps.find((x) => x.n === step.n);
        if (!s || s.claim !== token) return { next: null, out: null };
        return { next: { ...withStep(r, step.n, { status: "skipped", claim: null, claimed_at: null, note: pre.skip }), log: logEvent(r, t, `skipped:${step.n}`) }, out: null };
      });
      continue;
    }

    const built = await workflowDeps.build(pre.prepared, rctx);
    if (!built.ok) return pause(built.message);

    const saved = await update<boolean>(id, user, (r, t) => {
      const s = r.steps.find((x) => x.n === step.n);
      if (!s || s.claim !== token || s.status !== "building") return { next: null, out: false };
      return {
        next: {
          ...withStep(r, step.n, {
            status: "awaiting_signature",
            tx: {
              transaction: built.tx.transaction, blockhash: built.tx.blockhash, lastValidBlockHeight: built.tx.lastValidBlockHeight, built_at: t,
              ...(built.tx.summary ? { summary: built.tx.summary } : {}),
              ...(built.tx.prerequisite ? { prerequisite: true } : {}),
              ...(built.tx.prerequisite_kind ? { prerequisite_kind: built.tx.prerequisite_kind } : {}),
            },
            // A prerequisite moves no funds: nothing counts toward the spend caps until the step itself is signed.
            usd: built.tx.prerequisite ? 0 : pre.prepared.usd,
            resolved: pre.prepared.resolvedAmount,
            note: built.tx.prerequisite_kind === "phoenix_fund"
              ? "Your account holds enough assets that this order doesn't fit in one Solana transaction. This first transaction moves the USDC into Phoenix; the order itself follows."
              : built.tx.prerequisite
                ? "One-time setup: this creates your wallet's lookup table so margin transactions fit in one Solana transaction. The step itself follows."
                : pre.prepared.notes.join(" ") || null,
          }),
          state: "running",
          simulation: pre.prepared.simulation ?? r.simulation,
          log: logEvent(r, t, `built:${step.n}`),
        },
        out: true,
      };
    });
    if (!saved.out) return view(saved.rec, { message: "That step changed while I was preparing it. Try again." });
    const fresh = saved.rec.steps.find((s) => s.n === step.n) as StoredStep;
    return view(saved.rec, { step: toStepView(fresh), unsigned_tx: fresh.tx ? toUnsigned(fresh.tx) : null, message: "Ready for your wallet to sign." });
  }
  const { rec } = await load(id, user);
  return view(rec, { answer, message: "Nothing further to do right now." });
}

async function isExpired(lastValid: number): Promise<boolean> {
  try {
    return (await workflowDeps.blockHeight()) > lastValid;
  } catch {
    return false; // can't tell: keep the transaction rather than discard a possibly valid one
  }
}

function terminalMessage(rec: WorkflowRecord): string {
  switch (rec.state) {
    case "completed":
      return "All steps are confirmed on chain.";
    case "failed":
      return "The plan failed. Nothing further will run.";
    case "cancelled":
      return "This plan was cancelled.";
    default:
      return "This plan has expired. Ask again and I'll draw up a fresh one.";
  }
}

// ── Submit ──────────────────────────────────────────────────────────────────

type SendClass = "rejected" | "expired" | "ambiguous";

/** Did the RPC definitely refuse the transaction (so it cannot land), or do we not know? */
export function classifySendError(e: unknown): SendClass {
  const msg = e instanceof Error ? e.message : String(e);
  if (/blockhash not found|block height exceeded/i.test(msg)) return "expired";
  const logs = (e as { logs?: unknown } | null)?.logs;
  if (Array.isArray(logs) || /simulation failed|custom program error|insufficient (funds|lamports)|invalid account|already been processed|signature verification/i.test(msg)) return "rejected";
  return "ambiguous";
}

export async function submitWorkflow(id: string, req: SubmitRequest, user: CopilotUser): Promise<SubmitResponse> {
  if (!Number.isInteger(req?.step_n) || req.step_n < 1) throw new WorkflowError("bad_request", "step_n is required.", 400);
  const { rec } = await load(id, user);
  const step = rec.steps.find((s) => s.n === req.step_n);
  if (!step) throw new WorkflowError("bad_request", "No such step.", 400);
  if (TERMINAL.has(rec.state)) throw new WorkflowError("conflict", `This plan is ${rec.state}.`, 409);

  // A repeat of an already-submitted step is idempotent: report it, never send twice.
  if (step.status === "submitted" || step.status === "confirmed" || step.status === "uncertain") {
    return { plan: toPlanView(rec), signature: step.signature, status: step.status, message: "This step was already sent." };
  }
  if (step.status !== "awaiting_signature" || !step.tx) throw new WorkflowError("conflict", "This step is not waiting for a signature.", 409);
  if (await isExpired(step.tx.lastValidBlockHeight)) {
    await update<null>(id, user, (r, t) =>
      r.steps.find((s) => s.n === step.n)?.status === "awaiting_signature"
        ? { next: { ...withStep(r, step.n, { status: "expired", tx: null, note: "The transaction expired before it was signed; it will be rebuilt." }), log: logEvent(r, t, `expired:${step.n}`) }, out: null }
        : { next: null, out: null },
    );
    throw new WorkflowError("expired", "That transaction expired before it was signed. Continue the plan to get a fresh one.", 410);
  }

  const verified = verifySignedTx({ unsignedB64: step.tx.transaction, signedB64: req.signed_tx, wallet: user.wallet });

  // Mark submitted BEFORE broadcasting: a second request now finds `submitted` and does not send.
  const builtAt = step.tx.built_at;
  const marked = await update<boolean>(id, user, (r, t) => {
    const s = r.steps.find((x) => x.n === step.n);
    if (!s || s.status !== "awaiting_signature" || s.tx?.built_at !== builtAt) return { next: null, out: false };
    return { next: { ...withStep(r, step.n, { status: "submitted", signature: verified.signature, submitted_at: t, note: null }), log: logEvent(r, t, `submitted:${step.n}`) }, out: true };
  });
  if (!marked.out) {
    const s = marked.rec.steps.find((x) => x.n === step.n);
    return { plan: toPlanView(marked.rec), signature: s?.signature ?? null, status: s?.status ?? "pending", message: "This step was already sent." };
  }

  let message: string | null = null;
  let finalStatus: StepStatus = "submitted";
  try {
    await workflowDeps.send(verified.raw);
  } catch (e) {
    const kind = classifySendError(e);
    finalStatus = kind === "expired" ? "expired" : kind === "rejected" ? "failed" : "uncertain";
    message =
      kind === "ambiguous"
        ? "I couldn't confirm the network received this transaction. I won't send it again; check its status below."
        : kind === "expired"
          ? "The transaction expired before the network accepted it. Continue the plan to get a fresh one."
          : `The network rejected the transaction: ${humanizeFailure(e instanceof Error ? e.message : String(e))}`;
    const { rec: after } = await update<null>(id, user, (r, t) => {
      const s = r.steps.find((x) => x.n === step.n);
      if (!s || s.status !== "submitted" || s.signature !== verified.signature) return { next: null, out: null };
      return { next: { ...withStep(r, step.n, { status: finalStatus, ...(kind === "expired" ? { tx: null } : {}), note: message }), log: logEvent(r, t, `send_${kind}:${step.n}`) }, out: null };
    });
    return { plan: toPlanView(after), signature: verified.signature, status: finalStatus, message };
  }

  try {
    if (step.usd) await workflowDeps.recordSpend(user, step.usd);
  } catch {
    /* the cap counter is best-effort after the fact; the pre-build check is the enforcement */
  }
  const { rec: latest } = await load(id, user);
  return { plan: toPlanView(latest), signature: verified.signature, status: "submitted" };
}

// ── Confirm ─────────────────────────────────────────────────────────────────

export async function confirmWorkflow(id: string, req: ConfirmRequest, user: CopilotUser): Promise<ConfirmResponse> {
  if (!Number.isInteger(req?.step_n) || req.step_n < 1) throw new WorkflowError("bad_request", "step_n is required.", 400);
  const { rec } = await load(id, user);
  const step = rec.steps.find((s) => s.n === req.step_n);
  if (!step) throw new WorkflowError("bad_request", "No such step.", 400);
  const sigLink = (sig: string | null) => (sig ? explorerUrl("tx", sig) : null);

  if (step.status === "confirmed" || !step.signature || !(step.status === "submitted" || step.status === "uncertain")) {
    return { plan: toPlanView(rec), status: step.status, signature: step.signature, explorer_url: sigLink(step.signature), message: step.status === "confirmed" ? "Confirmed on chain." : null };
  }

  let state: SignatureState;
  try {
    state = await workflowDeps.signatureState(step.signature);
  } catch {
    return { plan: toPlanView(rec), status: step.status, signature: step.signature, explorer_url: sigLink(step.signature), message: "I couldn't reach the network to check. Try again shortly." };
  }

  const signature = step.signature;
  if (state.state === "pending") {
    // Only a never-seen signature whose blockhash has expired can be declared dead.
    if (step.tx && (await isExpired(step.tx.lastValidBlockHeight))) {
      const again = await workflowDeps.signatureState(signature).catch(() => ({ state: "pending" }) as SignatureState);
      if (again.state === "pending") {
        const { rec: next } = await update<null>(id, user, (r, t) => {
          const s = r.steps.find((x) => x.n === step.n);
          if (!s || s.signature !== signature || (s.status !== "submitted" && s.status !== "uncertain")) return { next: null, out: null };
          return { next: { ...withStep(r, step.n, { status: "expired", tx: null, note: "The transaction never landed and its blockhash expired; it will be rebuilt." }), state: "paused", pause_reason: "A transaction expired before it landed.", log: logEvent(r, t, `expired_unseen:${step.n}`) }, out: null };
        });
        return { plan: toPlanView(next), status: "expired", signature, explorer_url: sigLink(signature), message: "It expired without landing. Continue the plan to rebuild it." };
      }
      state = again;
    }
  }
  if (state.state === "pending") {
    return { plan: toPlanView(rec), status: step.status, signature, explorer_url: sigLink(signature), message: "Waiting for confirmation." };
  }

  const confirmed = state.state === "confirmed";
  const { rec: next } = await update<null>(id, user, (r, t) => {
    const s = r.steps.find((x) => x.n === step.n);
    if (!s || s.signature !== signature || (s.status !== "submitted" && s.status !== "uncertain")) return { next: null, out: null };
    const note = confirmed ? null : `The transaction failed on chain: ${humanizeFailure((state as { err: string }).err)}`;
    if (confirmed && s.tx?.prerequisite) {
      // The one-time setup landed: the step itself is built next (status back to pending).
      return {
        next: {
          ...withStep(r, step.n, s.tx.prerequisite_kind === "phoenix_fund"
            ? { status: "pending", tx: null, signature: null, submitted_at: null, funded: true, note: "The USDC is in Phoenix. Preparing the order." }
            : { status: "pending", tx: null, signature: null, submitted_at: null, note: "One-time setup done. Preparing the step itself." }),
          state: r.state === "paused" ? "running" : r.state,
          pause_reason: null,
          log: logEvent(r, t, `prerequisite_confirmed:${step.n}`),
        },
        out: null,
      };
    }
    return { next: { ...withStep(r, step.n, { status: confirmed ? "confirmed" : "failed", note }), state: r.state === "paused" && confirmed ? "running" : r.state, pause_reason: confirmed ? null : r.pause_reason, log: logEvent(r, t, `${confirmed ? "confirmed" : "failed_onchain"}:${step.n}`) }, out: null };
  });
  const s2 = next.steps.find((x) => x.n === step.n);
  return {
    plan: toPlanView(next),
    status: s2?.status ?? (confirmed ? "confirmed" : "failed"),
    signature,
    explorer_url: sigLink(signature),
    message: s2?.status === "pending" ? s2.note : confirmed ? "Confirmed on chain." : (s2?.note ?? "The transaction failed."),
  };
}
