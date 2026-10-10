import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotUser } from "../types";
import { PLAN_TTL_MS, RUN_WINDOW_MS, type StepSpec } from "../plan";
import {
  STALE_BUILD_MS,
  advanceWorkflow,
  approveWorkflow,
  cancelWorkflow,
  classifySendError,
  confirmWorkflow,
  createWorkflow,
  getWorkflow,
  submitWorkflow,
  workflowDeps,
  type SignatureState,
  type WorkflowRecord,
} from "../workflow";
import { base58Encode, verifySignedTx } from "../workflow/submit-verify";
import { WorkflowError } from "../workflow/types";
import { MemoryStore } from "./helpers";

// ── fixtures ────────────────────────────────────────────────────────────────

const kp = Keypair.generate();
const other = Keypair.generate();
const userOf = (k: Keypair): CopilotUser => ({ wallet: k.publicKey.toBase58(), subject: createHash("sha256").update(k.publicKey.toBase58()).digest("hex"), expiresAt: Date.now() + 1e7 });
const USER = userOf(kp);
const STRANGER = userOf(other);

let nonce = 0;
function unsignedFor(payer: PublicKey, lamports = 1): string {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: lamports + nonce++ })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

function sign(b64: string, signer: Keypair): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([signer]);
  return Buffer.from(tx.serialize()).toString("base64");
}

const writeStep = (over: Partial<StepSpec> = {}): StepSpec => ({ kind: "write", op: "earn_supply", asset: "USDC", amount: "10", slots: {}, ...over });
const reportStep: StepSpec = { kind: "read", op: "report", asset: null, amount: null, slots: { report: "health" } };

interface Harness {
  store: MemoryStore<WorkflowRecord>;
  clock: { t: number };
  builds: number;
  sends: Uint8Array[];
  spends: number[];
  height: number;
  sigState: SignatureState;
  preflightOk: boolean;
  buildOk: boolean;
  sendError: Error | null;
  buildDelay: () => Promise<void>;
}

let h: Harness;
const original = { ...workflowDeps };

beforeEach(() => {
  h = {
    store: new MemoryStore<WorkflowRecord>(),
    clock: { t: 1_700_000_000_000 },
    builds: 0,
    sends: [],
    spends: [],
    height: 100,
    sigState: { state: "pending" },
    preflightOk: true,
    buildOk: true,
    sendError: null,
    buildDelay: async () => undefined,
  };
  Object.assign(workflowDeps, {
    store: () => h.store,
    now: () => h.clock.t,
    blockHeight: async () => h.height,
    send: async (raw: Uint8Array) => {
      if (h.sendError) throw h.sendError;
      h.sends.push(raw);
      return "sig";
    },
    signatureState: async () => h.sigState,
    preflight: async (step: { asset: string | null; amount: string | null }) =>
      h.preflightOk
        ? { ok: true as const, prepared: { usd: 10, call: { tool: "t", args: {} }, risk: { decision: "allow" as const, reasons: [] }, simulation: null, resolvedAmount: step.amount, notes: ["note"] } }
        : { ok: false as const, code: "risk" as const, message: "Health factor would be too low." },
    build: async () => {
      h.builds++;
      await h.buildDelay();
      return h.buildOk
        ? { ok: true as const, tx: { transaction: unsignedFor(kp.publicKey), blockhash: "bh", lastValidBlockHeight: 200, simulation_success: true } }
        : { ok: false as const, code: "rejected" as const, message: "Simulation failed." };
    },
    readStep: async () => ({ ok: true, data: {}, answer: { headline: "Your health factor is 2.00.", facts: [] } }),
    recordSpend: async (_u: CopilotUser, usd: number) => void h.spends.push(usd),
  });
});

afterEach(() => {
  Object.assign(workflowDeps, original);
});

const create = (steps: StepSpec[] = [writeStep()], user = USER) => createWorkflow({ user, summary: "test plan", steps });
const errOf = async (p: Promise<unknown>): Promise<WorkflowError> => {
  try {
    await p;
  } catch (e) {
    return e as WorkflowError;
  }
  throw new Error("expected a WorkflowError");
};

// ── approval ────────────────────────────────────────────────────────────────

describe("approval", () => {
  it("approves with the digest it was shown", async () => {
    const rec = await create();
    const plan = await approveWorkflow(rec.id, rec.digest, USER);
    expect(plan.state).toBe("approved");
  });

  it("refuses a wrong digest and leaves the plan proposed", async () => {
    const rec = await create();
    const e = await errOf(approveWorkflow(rec.id, "0".repeat(64), USER));
    expect(e.code).toBe("digest_mismatch");
    expect((await getWorkflow(rec.id, USER)).state).toBe("proposed");
  });

  it("refuses after 5 minutes and marks the plan expired", async () => {
    const rec = await create();
    h.clock.t += PLAN_TTL_MS + 1;
    const e = await errOf(approveWorkflow(rec.id, rec.digest, USER));
    expect(e.code).toBe("expired");
    expect(e.status).toBe(410);
    expect((await getWorkflow(rec.id, USER)).state).toBe("expired");
    const again = await errOf(approveWorkflow(rec.id, rec.digest, USER));
    expect(again.code).toBe("expired");
  });

  it("approves right at the edge of the TTL", async () => {
    const rec = await create();
    h.clock.t += PLAN_TTL_MS;
    expect((await approveWorkflow(rec.id, rec.digest, USER)).state).toBe("approved");
  });

  it("detects a stored plan edited after it was shown (re-hash on approve)", async () => {
    const rec = await create([writeStep({ amount: "10" })]);
    const stored = h.store.docs.get(rec.id)!;
    stored.value.steps[0].amount = "10000"; // someone with store access raises the amount
    const e = await errOf(approveWorkflow(rec.id, rec.digest, USER));
    expect(e.code).toBe("digest_mismatch");
  });

  it("cannot be approved twice", async () => {
    const rec = await create();
    await approveWorkflow(rec.id, rec.digest, USER);
    expect((await errOf(approveWorkflow(rec.id, rec.digest, USER))).code).toBe("conflict");
  });

  it("is invisible to another wallet", async () => {
    const rec = await create();
    expect((await errOf(approveWorkflow(rec.id, rec.digest, STRANGER))).status).toBe(404);
    expect((await errOf(getWorkflow(rec.id, STRANGER))).status).toBe(404);
    expect((await errOf(advanceWorkflow(rec.id, STRANGER))).status).toBe(404);
  });

  it("will not advance before approval", async () => {
    const rec = await create();
    expect((await errOf(advanceWorkflow(rec.id, USER))).code).toBe("not_approved");
  });

  it("rejects malformed plans at creation", async () => {
    expect((await errOf(create([]))).code).toBe("bad_request");
    expect((await errOf(create([writeStep({ amount: null })]))).code).toBe("bad_request");
  });
});

// ── step claim (exactly once) ───────────────────────────────────────────────

describe("step claim", () => {
  it("N concurrent advances build the step exactly once (compare-and-set race)", async () => {
    const rec = await create();
    await approveWorkflow(rec.id, rec.digest, USER);
    h.buildDelay = () => new Promise((r) => setTimeout(r, 25));
    const results = await Promise.all(Array.from({ length: 6 }, () => advanceWorkflow(rec.id, USER)));
    expect(h.builds).toBe(1);
    const withTx = results.filter((r) => r.unsigned_tx);
    expect(withTx.length).toBeGreaterThanOrEqual(1);
    // everyone who got a transaction got the same one
    expect(new Set(withTx.map((r) => r.unsigned_tx!.transaction)).size).toBe(1);
    const final = await getWorkflow(rec.id, USER);
    expect(final.steps[0].status).toBe("awaiting_signature");
    expect(final.steps[0].builds).toBe(1);
  });

  it("a repeat advance returns the stored transaction instead of building again", async () => {
    const rec = await create();
    await approveWorkflow(rec.id, rec.digest, USER);
    const a = await advanceWorkflow(rec.id, USER);
    const b = await advanceWorkflow(rec.id, USER);
    expect(h.builds).toBe(1);
    expect(b.unsigned_tx?.transaction).toBe(a.unsigned_tx?.transaction);
  });

  it("a dead claim is re-taken after the stale window, and the old builder cannot overwrite the new one", async () => {
    const rec = await create();
    await approveWorkflow(rec.id, rec.digest, USER);
    // simulate a crashed server: step left in `building`
    const doc = h.store.docs.get(rec.id)!;
    doc.value.state = "running";
    doc.value.steps[0].status = "building";
    doc.value.steps[0].claim = "dead-token";
    doc.value.steps[0].claimed_at = h.clock.t;
    const busy = await advanceWorkflow(rec.id, USER);
    expect(busy.unsigned_tx).toBeFalsy();
    expect(h.builds).toBe(0);
    h.clock.t += STALE_BUILD_MS + 1;
    const res = await advanceWorkflow(rec.id, USER);
    expect(res.unsigned_tx).toBeTruthy();
    expect(h.builds).toBe(1);
  });

  it("a failed pre-check pauses the plan and builds nothing; fixing it lets the same step proceed", async () => {
    const rec = await create();
    await approveWorkflow(rec.id, rec.digest, USER);
    h.preflightOk = false;
    const paused = await advanceWorkflow(rec.id, USER);
    expect(paused.plan.state).toBe("paused");
    expect(paused.pause_reason).toMatch(/too low/);
    expect(paused.unsigned_tx).toBeFalsy();
    expect(h.builds).toBe(0);
    expect(paused.plan.steps[0].status).toBe("pending");
    h.preflightOk = true;
    const ok = await advanceWorkflow(rec.id, USER);
    expect(ok.unsigned_tx).toBeTruthy();
    expect(ok.plan.state).toBe("running");
  });

  it("a rejected build (simulation failed) is never handed to the wallet", async () => {
    const rec = await create();
    await approveWorkflow(rec.id, rec.digest, USER);
    h.buildOk = false;
    const res = await advanceWorkflow(rec.id, USER);
    expect(res.unsigned_tx).toBeFalsy();
    expect(res.plan.state).toBe("paused");
    expect(res.plan.steps[0].status).toBe("pending");
  });

  it("steps run strictly in order: step 2 is not built until step 1 is confirmed", async () => {
    const rec = await create([writeStep({ amount: "1" }), writeStep({ amount: "2" })]);
    await approveWorkflow(rec.id, rec.digest, USER);
    const first = await advanceWorkflow(rec.id, USER);
    expect(first.step?.n).toBe(1);
    const again = await advanceWorkflow(rec.id, USER);
    expect(again.step?.n).toBe(1);
    expect(h.builds).toBe(1);
  });

  it("the run window bounds how long an approved plan may keep starting steps", async () => {
    const rec = await create();
    await approveWorkflow(rec.id, rec.digest, USER);
    h.clock.t += RUN_WINDOW_MS + 1;
    const res = await advanceWorkflow(rec.id, USER);
    expect(res.plan.state).toBe("expired");
    expect(h.builds).toBe(0);
  });
});

// ── submit ──────────────────────────────────────────────────────────────────

async function ready(steps: StepSpec[] = [writeStep()]) {
  const rec = await create(steps);
  await approveWorkflow(rec.id, rec.digest, USER);
  const adv = await advanceWorkflow(rec.id, USER);
  return { rec, unsigned: adv.unsigned_tx!.transaction };
}

describe("submit", () => {
  it("broadcasts a correctly signed transaction once, marking it submitted first", async () => {
    const { rec, unsigned } = await ready();
    const res = await submitWorkflow(rec.id, { step_n: 1, signed_tx: sign(unsigned, kp) }, USER);
    expect(res.status).toBe("submitted");
    expect(h.sends).toHaveLength(1);
    expect(res.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(h.spends).toEqual([10]);
  });

  it("concurrent and repeated submits send exactly once", async () => {
    const { rec, unsigned } = await ready();
    const signed = sign(unsigned, kp);
    const out = await Promise.all(Array.from({ length: 4 }, () => submitWorkflow(rec.id, { step_n: 1, signed_tx: signed }, USER)));
    await submitWorkflow(rec.id, { step_n: 1, signed_tx: signed }, USER);
    expect(h.sends).toHaveLength(1);
    expect(new Set(out.map((o) => o.signature)).size).toBe(1);
  });

  it("rejects a tampered transaction (different instructions) and sends nothing", async () => {
    const { rec } = await ready();
    const evil = sign(unsignedFor(kp.publicKey, 9_999_999), kp); // valid signature, but not the message we built
    const e = await errOf(submitWorkflow(rec.id, { step_n: 1, signed_tx: evil }, USER));
    expect(e.code).toBe("tx_mismatch");
    expect(h.sends).toHaveLength(0);
    expect((await getWorkflow(rec.id, USER)).steps[0].status).toBe("awaiting_signature");
  });

  it("rejects an unsigned or wrongly signed transaction", async () => {
    const { rec, unsigned } = await ready();
    expect((await errOf(submitWorkflow(rec.id, { step_n: 1, signed_tx: unsigned }, USER))).code).toBe("tx_mismatch");
    // signed by someone else's key in the fee payer slot
    const tx = VersionedTransaction.deserialize(Buffer.from(unsigned, "base64"));
    tx.signatures[0] = nacl.sign.detached(tx.message.serialize(), other.secretKey);
    const forged = Buffer.from(tx.serialize()).toString("base64");
    expect((await errOf(submitWorkflow(rec.id, { step_n: 1, signed_tx: forged }, USER))).code).toBe("tx_mismatch");
    expect(h.sends).toHaveLength(0);
  });

  it("rejects garbage and oversized payloads", async () => {
    const { rec } = await ready();
    expect((await errOf(submitWorkflow(rec.id, { step_n: 1, signed_tx: "not base64!!" }, USER))).code).toBe("bad_request");
    expect((await errOf(submitWorkflow(rec.id, { step_n: 1, signed_tx: "A".repeat(5000) }, USER))).code).toBe("bad_request");
    expect((await errOf(submitWorkflow(rec.id, { step_n: 0, signed_tx: "" }, USER))).code).toBe("bad_request");
  });

  it("will not send for a step that is not awaiting a signature", async () => {
    const rec = await create();
    await approveWorkflow(rec.id, rec.digest, USER);
    const e = await errOf(submitWorkflow(rec.id, { step_n: 1, signed_tx: "AAAA" }, USER));
    expect(e.code).toBe("conflict");
  });

  it("an ambiguous send failure is `uncertain`, is never re-sent and never auto-rebuilt", async () => {
    const { rec, unsigned } = await ready();
    h.sendError = new Error("fetch failed: socket hang up");
    const res = await submitWorkflow(rec.id, { step_n: 1, signed_tx: sign(unsigned, kp) }, USER);
    expect(res.status).toBe("uncertain");
    h.sendError = null;
    const adv = await advanceWorkflow(rec.id, USER);
    expect(adv.unsigned_tx).toBeFalsy();
    expect(h.builds).toBe(1);
    expect(h.sends).toHaveLength(0);
    const again = await submitWorkflow(rec.id, { step_n: 1, signed_tx: sign(unsigned, kp) }, USER);
    expect(again.status).toBe("uncertain");
    expect(h.sends).toHaveLength(0);
    // only a human-triggered confirm can resolve it, and only from chain state
    h.sigState = { state: "confirmed" };
    const c = await confirmWorkflow(rec.id, { step_n: 1 }, USER);
    expect(c.status).toBe("confirmed");
    expect(c.plan.state).toBe("completed");
  });

  it("a definite network rejection marks the step and plan failed", async () => {
    const { rec, unsigned } = await ready();
    h.sendError = new Error("failed to send transaction: Transaction simulation failed: custom program error: 0x1");
    const res = await submitWorkflow(rec.id, { step_n: 1, signed_tx: sign(unsigned, kp) }, USER);
    expect(res.status).toBe("failed");
    expect(res.plan.state).toBe("failed");
    expect(h.spends).toEqual([]);
  });

  it("refuses to sign-and-send a transaction whose blockhash window has passed, and rebuilds on the next advance", async () => {
    const { rec, unsigned } = await ready();
    h.height = 201; // > lastValidBlockHeight 200
    const e = await errOf(submitWorkflow(rec.id, { step_n: 1, signed_tx: sign(unsigned, kp) }, USER));
    expect(e.code).toBe("expired");
    expect(h.sends).toHaveLength(0);
    h.height = 100;
    const adv = await advanceWorkflow(rec.id, USER);
    expect(adv.unsigned_tx).toBeTruthy();
    expect(h.builds).toBe(2);
  });

  it("an advance on a transaction that expired unsigned rebuilds it", async () => {
    await ready();
    h.height = 500;
    const rec = [...h.store.docs.keys()][0];
    const adv = await advanceWorkflow(rec, USER);
    expect(h.builds).toBe(2);
    expect(adv.unsigned_tx).toBeTruthy();
  });
});

describe("classifySendError", () => {
  it.each([
    ["failed to send transaction: Transaction simulation failed: Blockhash not found", "expired"],
    ["Transaction simulation failed: custom program error: 0x1771", "rejected"],
    ["insufficient lamports for rent", "rejected"],
    ["fetch failed", "ambiguous"],
    ["HTTP 502 Bad Gateway", "ambiguous"],
    ["timeout of 30000ms exceeded", "ambiguous"],
  ])("%s -> %s", (msg, kind) => {
    expect(classifySendError(new Error(msg))).toBe(kind);
  });
});

// ── confirm ─────────────────────────────────────────────────────────────────

describe("confirm", () => {
  async function submitted(steps?: StepSpec[]) {
    const { rec, unsigned } = await ready(steps);
    const res = await submitWorkflow(rec.id, { step_n: 1, signed_tx: sign(unsigned, kp) }, USER);
    return { rec, sig: res.signature! };
  }

  it("nothing is done until the chain confirms: submitted stays submitted while pending", async () => {
    const { rec } = await submitted();
    const c = await confirmWorkflow(rec.id, { step_n: 1 }, USER);
    expect(c.status).toBe("submitted");
    expect(c.plan.state).not.toBe("completed");
  });

  it("confirmed signature completes a one-step plan and is idempotent", async () => {
    const { rec } = await submitted();
    h.sigState = { state: "confirmed" };
    const c = await confirmWorkflow(rec.id, { step_n: 1 }, USER);
    expect(c.status).toBe("confirmed");
    expect(c.plan.state).toBe("completed");
    expect(c.explorer_url).toMatch(/explorer\.solana\.com\/tx\//);
    const again = await confirmWorkflow(rec.id, { step_n: 1 }, USER);
    expect(again.status).toBe("confirmed");
  });

  it("a confirmed one-time setup (prerequisite) sends the step back to be built again, and counts no spend", async () => {
    const realBuild = workflowDeps.build;
    let first = true;
    Object.assign(workflowDeps, {
      build: async (...args: Parameters<typeof realBuild>) => {
        const out = await realBuild(...args);
        if (first && out.ok) {
          first = false;
          return { ...out, tx: { ...out.tx, prerequisite: true } };
        }
        return out;
      },
    });
    const { rec } = await submitted();
    expect(h.spends).toEqual([]); // a prerequisite moves no funds: no spend is recorded
    h.sigState = { state: "confirmed" };
    const c = await confirmWorkflow(rec.id, { step_n: 1 }, USER);
    expect(c.status).toBe("pending");
    expect(c.plan.state).not.toBe("completed");
    const adv = await advanceWorkflow(rec.id, USER);
    expect(adv.unsigned_tx).toBeTruthy();
    expect(h.builds).toBe(2);
  });

  it("an on-chain failure fails the step and the plan", async () => {
    const { rec } = await submitted();
    h.sigState = { state: "failed", err: '{"InstructionError":[0,{"Custom":1}]}' };
    const c = await confirmWorkflow(rec.id, { step_n: 1 }, USER);
    expect(c.status).toBe("failed");
    expect(c.plan.state).toBe("failed");
  });

  it("a signature never seen whose blockhash expired is marked expired (and can be rebuilt), not confirmed", async () => {
    const { rec } = await submitted();
    h.height = 999;
    const c = await confirmWorkflow(rec.id, { step_n: 1 }, USER);
    expect(c.status).toBe("expired");
    const adv = await advanceWorkflow(rec.id, USER);
    expect(adv.unsigned_tx).toBeTruthy();
  });

  it("runs a trailing report leg after the writes settle, then completes", async () => {
    const { rec } = await submitted([writeStep(), reportStep]);
    h.sigState = { state: "confirmed" };
    await confirmWorkflow(rec.id, { step_n: 1 }, USER);
    const adv = await advanceWorkflow(rec.id, USER);
    expect(adv.answer?.headline).toMatch(/health factor/);
    expect(adv.plan.state).toBe("completed");
    expect(adv.plan.steps[1].status).toBe("done");
  });

  it("does not run the report leg before the write is confirmed", async () => {
    const { rec } = await submitted([writeStep(), reportStep]);
    const adv = await advanceWorkflow(rec.id, USER);
    expect(adv.answer).toBeFalsy();
    expect(adv.plan.steps[1].status).toBe("pending");
  });
});

describe("cancel", () => {
  it("cancels a plan with nothing in flight, but not one with a transaction on its way", async () => {
    const a = await create();
    expect((await cancelWorkflow(a.id, USER)).state).toBe("cancelled");
    const { rec, unsigned } = await ready();
    await submitWorkflow(rec.id, { step_n: 1, signed_tx: sign(unsigned, kp) }, USER);
    expect((await errOf(cancelWorkflow(rec.id, USER))).code).toBe("conflict");
  });
});

describe("verifySignedTx", () => {
  it("returns the fee payer's signature as the transaction id", () => {
    const unsigned = unsignedFor(kp.publicKey);
    const signed = sign(unsigned, kp);
    const v = verifySignedTx({ unsignedB64: unsigned, signedB64: signed, wallet: kp.publicKey.toBase58() });
    const tx = VersionedTransaction.deserialize(Buffer.from(signed, "base64"));
    expect(v.signature).toBe(base58Encode(tx.signatures[0]));
  });

  it("base58 matches web3.js for arbitrary bytes", () => {
    const bytes = nacl.randomBytes(64);
    const pk = new PublicKey(bytes.slice(0, 32)).toBase58();
    expect(base58Encode(bytes.slice(0, 32))).toBe(pk);
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe("112");
  });

  it("rejects a session wallet that is not the fee payer", () => {
    const unsigned = unsignedFor(kp.publicKey);
    const signed = sign(unsigned, kp);
    expect(() => verifySignedTx({ unsignedB64: unsigned, signedB64: signed, wallet: other.publicKey.toBase58() })).toThrow(/fee payer/);
  });
});

vi.setConfig({ testTimeout: 15_000 });
