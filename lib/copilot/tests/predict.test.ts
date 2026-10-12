/**
 * Predict (World.xyz prediction markets) in the Copilot, offline: a scripted model, a fake MCP, the real firewall,
 * decision guard, sizing, plan store and workflow. The trade is one step whose transactions the wallet signs together
 * and the server sends in order, each confirmed before the next; the pool merge runs after it confirms.
 */
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateFirewall } from "../domain-firewall";
import { handleChat } from "../index";
import { setLimitStoreForTests } from "../limits";
import { mcp, MCPError, parseWriteEnvelope } from "../mcp-client";
import { predictLegsOf } from "../plan";
import type { ChatResponse, CopilotUser } from "../types";
import { setLlmClient, type LlmClient, type LlmRequest } from "../vertex";
import { advanceWorkflow, approveWorkflow, confirmWorkflow, createWorkflow, submitWorkflow, workflowDeps, type SignatureState, type WorkflowRecord } from "../workflow";
import { pendingDeps, type ConversationRecord } from "../workflow/pending";
import { MemoryStore } from "./helpers";

const kp = Keypair.generate();
const USER: CopilotUser = { wallet: kp.publicKey.toBase58(), subject: createHash("sha256").update(kp.publicKey.toBase58()).digest("hex"), expiresAt: Date.now() + 1e7 };
const BARCA = "6tutZgRrk3GNkaTNpcxaoHdj2CBtVZTe9YqxnipzEBUT";
const DRAW = "BBegRHnAJ9gRmVdmS3HHNuuUfMtT2wh7DUaH3nGo2Mtm";
const GALA = "83Y67kyWMvY8Hs6mRs4iWPRwGF4Nq8yUu4XpDgw3uTVx";

const outcome = (market_id: string, name: string, y: number, n: number, tradable = true) => ({
  market_id, name, yes_label: "Yes", no_label: "No", yes_buy_cents: y, no_buy_cents: n, yes_sell_cents: y - 1.7, no_sell_cents: n - 1.7, tradable, price_source: "quote", joins_vanna_pool: true,
});
const EVENT = { event_id: "FzMSs3Df", title: "Galatasaray vs Barcelona", type: "match", league: "UCL", outcomes: [outcome(GALA, "Galatasaray", 11.4, 90.4), outcome(BARCA, "Barcelona", 78.4, 23.4), outcome(DRAW, "Draw", 13.4, 88.4, false)] };

let nonce = 0;
function unsignedFor(payer: PublicKey): string {
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 + nonce++ })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}
const sign = (b64: string) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString("base64");
};

const batchEnvelope = (n: number) => ({
  schemaVersion: "1",
  transactions: Array.from({ length: n }, (_, i) => ({
    id: `predict-${i + 1}`, purpose: `Leg ${i + 1}`, unsignedTransaction: unsignedFor(kp.publicKey), blockhash: "bh", lastValidBlockHeight: "200",
    simulation: { status: i === 0 ? "success" : "not_run_dependency", err: null },
  })),
  summary: { action: "predict_trade", batch: true, sign_all_at_once: true, send_in_order: true, merge_markets: [BARCA] },
  simulation_success: true,
  code: null,
  reason: null,
});

type Call = { name: string; args: Record<string, unknown> };
function scripted(script: Call[][]): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async generate(req) {
      requests.push(req);
      return { text: null, calls: script[Math.min(requests.length - 1, script.length - 1)], tokens: 50 };
    },
  };
}
const chat = (message: string): Promise<ChatResponse> => handleChat({ req: { message, history: [] }, user: USER });

let workflows: MemoryStore<WorkflowRecord>;
const originalDeps = { ...workflowDeps };
const originalPending = { ...pendingDeps };
let positions: Record<string, unknown>;

beforeEach(() => {
  workflows = new MemoryStore<WorkflowRecord>();
  Object.assign(workflowDeps, { store: () => workflows });
  const conv = new MemoryStore<ConversationRecord>();
  Object.assign(pendingDeps, { store: () => conv });
  setLimitStoreForTests(new MemoryStore());
  positions = {
    wallet: { cash: 1000, usdc: 5, sol: 2 },
    positions: [{ event: "Galatasaray vs Barcelona", market_id: BARCA, outcome: "Barcelona", side: "yes", label: "Yes", shares: 12.5, wallet_shares: 0, pooled_shares: 12.5 }],
    summary: { value_usd: 9.7, cost_usd: 10, pnl_usd: -0.3, payout_if_all_win_cash: 12.5, count: 1 },
    vanna_pool: { deposited_usd: 33, apy_pct: 1.6 },
    can_move_to_pool: [],
  };
  vi.spyOn(mcp, "accountHealth").mockImplementation(async () => ({ collateral: [], debt: [], total_collateral_usd: "0", total_debt_usd: "0", health_factor: null, is_liquidatable: false, price_checks_pass: true }));
  vi.spyOn(mcp, "wallet").mockImplementation(async () => ({ authority: USER.wallet, sol_balance: "2", assets: [] }));
  vi.spyOn(mcp, "predictMarkets").mockImplementation(async () => ({ events: [EVENT], count: 1 }));
  vi.spyOn(mcp, "predictMarket").mockImplementation(async () => ({ event: EVENT }));
  vi.spyOn(mcp, "predictPositions").mockImplementation(async () => positions);
  vi.spyOn(mcp, "predictQuote").mockImplementation(async (_o: string, legs: Array<{ side: string; amount: string }>) => ({
    quotes: legs.map((l, i) => (l.side === "buy"
      ? { leg: i + 1, side: "buy", outcome: "yes", cash_in: Number(l.amount), shares_out: 12.76, price_cents: 78.35, payout_if_win_cash: 12.76, shares_into_vanna_pool: 12.76 }
      : { leg: i + 1, side: "sell", outcome: "yes", shares_in: Number(l.amount), cash_out: 3.8, price_cents: 76.7, payout_if_win_cash: 0, pool_shares_redeemed: Number(l.amount) })),
    warnings: [],
  }));
  vi.spyOn(mcp, "call").mockImplementation(async (tool: string, args: Record<string, unknown>) => {
    if (tool === "vanna_predict" && args.action === "trade") return batchEnvelope((args.legs as unknown[]).length);
    throw new MCPError(`unexpected tool ${tool}`, { code: "invalid_input" });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(workflowDeps, originalDeps);
  Object.assign(pendingDeps, originalPending);
  setLimitStoreForTests(null);
  setLlmClient(null);
});

const read: Call = { name: "get_predict_markets", args: { query: "barcelona" } };
const buy = (market: string, amount: string, quote = `bet ${amount} on barcelona`): Record<string, unknown> => ({ op: "predict_buy", market_id: market, outcome: "yes", sizing: { kind: "literal", amount }, source_quote: quote });

describe("Predict through the Copilot", () => {
  it("reads the markets, then plans the buy as one Predict trade with the app's quote", async () => {
    const llm = scripted([[read], [{ name: "propose_actions", args: { actions: [buy(BARCA, "10")] } }]]);
    setLlmClient(llm);
    const res = await chat("bet 10 on barcelona");
    expect(res.kind).toBe("preview");
    expect(llm.requests[1].user).toContain(BARCA); // the market ids reach the model in full
    const step = res.plan!.steps[0]!;
    expect(step.op).toBe("predict_trade");
    expect(step.label).toBe("Predict: Buy Yes on Barcelona for 10 CASH (Galatasaray vs Barcelona)");
    expect(res.message).toContain("78.35¢");
    expect(res.message).toContain("health factor doesn't change");
    const trade = vi.mocked(mcp.call).mock.calls.find((c) => c[0] === "vanna_predict")!;
    expect(trade[1]).toMatchObject({ action: "trade", authority: USER.wallet, legs: [{ market: BARCA, outcome: "yes", side: "buy", amount: "10" }] });
  });

  it("several outcomes in one request become one trade with one approval", async () => {
    setLlmClient(scripted([[read], [{ name: "propose_actions", args: { actions: [buy(BARCA, "10", "10 on barcelona"), { ...buy(GALA, "5", "5 against galatasaray"), outcome: "no" }] } }]]));
    const res = await chat("put 10 on barcelona and 5 against galatasaray");
    expect(res.kind).toBe("preview");
    expect(res.plan!.steps).toHaveLength(1);
    const rec = workflows.docs.get(res.workflow_id!)!.value;
    const legs = predictLegsOf(rec.steps[0]!)!;
    expect(legs.map((l) => [l.name, l.outcome, l.amount])).toEqual([["Barcelona", "yes", "10"], ["Galatasaray", "no", "5"]]);
    expect(rec.steps[0]!.amount).toBe("15");
  });

  it("refuses a market_id the model did not read", async () => {
    const llm = scripted([[{ name: "propose_actions", args: { actions: [buy(BARCA, "10")] } }], [{ name: "ask_user", args: { question: "Which market do you mean?" } }]]);
    setLlmClient(llm);
    const res = await chat("bet 10 on barcelona");
    expect(llm.requests[1].user).toMatch(/is not in any Predict read/);
    expect(res.kind).toBe("clarification");
  });

  it("sizes 'all my CASH' from the wallet and refuses an outcome with no live price", async () => {
    setLlmClient(scripted([[read], [{ name: "propose_actions", args: { actions: [{ op: "predict_buy", market_id: BARCA, outcome: "yes", sizing: { kind: "all" }, source_quote: "all my cash on barcelona" }] } }]]));
    const all = await chat("all my cash on barcelona");
    expect(all.kind).toBe("preview");
    expect(all.plan!.steps[0]!.label).toContain("for 1000 CASH");

    setLlmClient(scripted([[read], [{ name: "propose_actions", args: { actions: [{ ...buy(DRAW, "5", "5 on a draw") }] } }]]));
    const draw = await chat("5 on a draw");
    expect(draw.kind).toBe("clarification");
    expect(draw.message).toMatch(/Draw .* has no live price/);
  });

  it("checks the wallet's CASH and the shares before anything is built", async () => {
    positions = { ...positions, wallet: { cash: 3, usdc: 0, sol: 2 } };
    setLlmClient(scripted([[read], [{ name: "propose_actions", args: { actions: [buy(BARCA, "10")] } }]]));
    const res = await chat("bet 10 on barcelona");
    expect(res.kind).toBe("blocked");
    expect(res.message).toMatch(/holds 3 CASH .* test CASH/);

    setLlmClient(scripted([[read], [{ name: "propose_actions", args: { actions: [{ op: "predict_sell", market_id: BARCA, outcome: "yes", sizing: { kind: "literal", amount: "20" }, source_quote: "sell 20 barcelona" }] } }]]));
    const sell = await chat("sell 20 barcelona");
    expect(sell.kind).toBe("blocked");
    expect(sell.message).toMatch(/You hold 12.5 Yes shares of Barcelona in your wallet and Vanna's pool, fewer than the 20/);
  });

  it("adds test CASH at once (no transaction) and lets other faucets stay refused", async () => {
    const faucet = vi.spyOn(mcp, "predictFaucet").mockImplementation(async () => ({ ok: true, added_cash: 100, cash: 1100 }));
    setLlmClient(scripted([[{ name: "propose_actions", args: { actions: [{ op: "predict_faucet", source_quote: "get me some test cash" }] } }]]));
    const res = await chat("get me some test cash");
    expect(res.kind).toBe("answer");
    expect(res.message).toContain("Added 100 test CASH to your wallet; it now holds 1100 CASH.");
    expect(faucet).toHaveBeenCalledWith(USER.wallet, null, expect.anything());
    expect(evaluateFirewall("faucet me some SOL", { modelDecides: true }).allow).toBe(false);
    expect(evaluateFirewall("cash faucet please", { modelDecides: true }).allow).toBe(true);
    expect(evaluateFirewall("bet 10 CASH on 10 YES", { modelDecides: true }).allow).toBe(true);
  });

  it("reads the markets as compact rows that keep every market id", async () => {
    const { executeRead } = await import("../investigation/catalog");
    const out = await executeRead("get_predict_markets", { query: "barcelona" }, { user: USER });
    const text = JSON.stringify(out.result);
    for (const id of [BARCA, DRAW, GALA]) expect(text).toContain(id);
    expect(text).toContain("yes_buy_cents");
  });
});

describe("the Predict batch envelope", () => {
  it("parses every transaction for one approval and needs the first simulated", () => {
    const ok = parseWriteEnvelope(batchEnvelope(3));
    expect(ok.ok && ok.tx.batch?.transactions.length).toBe(3);
    expect(ok.ok && ok.tx.batch?.merge_markets).toEqual([BARCA]);
    const bad = batchEnvelope(2);
    bad.transactions[0]!.simulation = { status: "failed", err: "boom" } as never;
    expect(parseWriteEnvelope(bad)).toMatchObject({ ok: false, code: "simulation_failed" });
  });
});

describe("a Predict trade on the workflow", () => {
  let sends: Uint8Array[];
  let states: Map<string, SignatureState>;
  let merged: string[][];
  let txs: string[];

  beforeEach(() => {
    sends = [];
    states = new Map();
    merged = [];
    txs = [unsignedFor(kp.publicKey), unsignedFor(kp.publicKey)];
    Object.assign(workflowDeps, {
      now: () => Date.now(),
      blockHeight: async () => 100,
      sleep: async () => undefined,
      send: async (raw: Uint8Array) => {
        sends.push(raw);
        return "sig";
      },
      signatureState: async (sig: string) => states.get(sig) ?? { state: "confirmed" },
      preflight: async () => ({ ok: true as const, prepared: { usd: 15, call: { tool: "vanna_predict", args: {} }, risk: { decision: "allow" as const, reasons: [] }, simulation: null, resolvedAmount: "15", notes: [] } }),
      build: async () => ({ ok: true as const, tx: { transaction: txs[0]!, blockhash: "bh", lastValidBlockHeight: 200, simulation_success: true, batch: { transactions: txs, labels: ["Buy YES", "Buy NO"], merge_markets: [BARCA] } } }),
      recordSpend: async () => undefined,
      predictMerge: async (ids: string[]) => {
        merged.push(ids);
        return 2.5;
      },
    });
  });

  const legs = JSON.stringify([{ market: BARCA, outcome: "yes", side: "buy", amount: "10", name: "Barcelona", side_label: "Yes", event: "E" }, { market: GALA, outcome: "no", side: "buy", amount: "5", name: "Galatasaray", side_label: "No", event: "E" }]);
  const ready = async () => {
    const rec = await createWorkflow({ user: USER, summary: "trade", steps: [{ kind: "write", op: "predict_trade", asset: null, amount: "15", slots: { legs } }] });
    await approveWorkflow(rec.id, rec.digest, USER);
    const adv = await advanceWorkflow(rec.id, USER);
    expect(adv.unsigned_tx?.batch?.transactions).toEqual(txs);
    return rec.id;
  };

  it("sends every transaction in order, then confirms and merges the pool", async () => {
    const id = await ready();
    const res = await submitWorkflow(id, { step_n: 1, signed_tx: "", signed_txs: txs.map(sign) }, USER);
    expect(res.status).toBe("submitted");
    expect(sends).toHaveLength(2);
    expect(Buffer.from(sends[0]!).toString("base64")).toBe(sign(txs[0]!));
    const done = await confirmWorkflow(id, { step_n: 1 }, USER);
    expect(done.status).toBe("confirmed");
    expect(merged).toEqual([[BARCA]]);
    expect(done.plan.steps[0]!.note).toBe("Vanna's pool merged 2.5 USDC of matched shares.");
  });

  it("stops after a transaction that fails on chain and never sends the rest", async () => {
    const id = await ready();
    const signed = txs.map(sign);
    const first = VersionedTransaction.deserialize(Buffer.from(signed[0]!, "base64"));
    const { base58Encode } = await import("../workflow/submit-verify");
    states.set(base58Encode(first.signatures[0]!), { state: "failed", err: "custom program error: 0x1" });
    const res = await submitWorkflow(id, { step_n: 1, signed_tx: "", signed_txs: signed }, USER);
    expect(res.status).toBe("failed");
    expect(res.message).toMatch(/Transaction 1 of 2 \(Buy YES\) failed on chain/);
    expect(sends).toHaveLength(1);
  });

  it("needs every transaction signed together, unchanged", async () => {
    const id = await ready();
    await expect(submitWorkflow(id, { step_n: 1, signed_tx: "", signed_txs: [sign(txs[0]!)] }, USER)).rejects.toMatchObject({ code: "bad_request" });
    await expect(submitWorkflow(id, { step_n: 1, signed_tx: "", signed_txs: [sign(txs[1]!), sign(txs[0]!)] }, USER)).rejects.toMatchObject({ code: "tx_mismatch" });
    expect(sends).toHaveLength(0);
  });
});
