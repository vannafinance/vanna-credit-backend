/**
 * Understanding a request, not matching a phrase: lists of amounts, leverage targets on a borrow, and the model as the
 * reader of sentences the patterns cannot read. Same fakes as chat.test.ts (fake MCP, fake language model); the real
 * router, guards, sizing and plan code run.
 */
import { onlyDeclineWording } from "../testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChat } from "../index";
import { mcp, MCPError } from "../mcp-client";
import { setLimitStoreForTests } from "../limits";
import { amountsAreTyped, expandAmountList, keywordRoute } from "../router";
import { setLlmClient, type LlmClient, type LlmRequest } from "../vertex";
import { workflowDeps, type WorkflowRecord } from "../workflow";
import { pendingDeps, type ConversationRecord } from "../workflow/pending";
import type { ChatResponse } from "../types";
import { MemoryStore, userFor, WALLET_A } from "./helpers";

const USER = userFor(WALLET_A);
const PRICES: Record<string, string> = { SOL: "120", USDC: "1", USDT: "1", JitoSOL: "140", JupSOL: "130" };

const account = (collateralUsd: number, debtUsd: number) => ({
  margin_account: "GCL2pGFBKnBhkGEPZ3BhC4FuqHnfpJJnr8i9nnLKkTgD",
  collateral: [{ symbol: "USDC", raw_balance: 1, ui_balance: String(collateralUsd), usd_value: collateralUsd.toFixed(2), price: { usd: "1", fresh: true } }],
  debt: debtUsd ? [{ symbol: "USDC", raw_debt: 1, ui_debt: String(debtUsd), usd_value: debtUsd.toFixed(2), price: { usd: "1", fresh: true } }] : [],
  total_collateral_usd: collateralUsd.toFixed(2),
  total_debt_usd: debtUsd.toFixed(2),
  health_factor: debtUsd ? String(collateralUsd / debtUsd) : null,
  is_healthy: true,
  is_liquidatable: false,
  price_checks_pass: true,
});

const OK_ENVELOPE = {
  schemaVersion: "1",
  transactions: [{ id: "action", unsignedTransaction: "AQAAAA==", blockhash: "x", lastValidBlockHeight: "1", simulation: { status: "success", err: null } }],
  summary: { action: "supply" },
  preview: null,
  signing_status: "needs_wallet_sign",
  error: null,
  code: null,
  reason: null,
  simulation_success: true,
};

let health: Record<string, unknown>;
let workflows: MemoryStore<WorkflowRecord>;
const originalDeps = { ...workflowDeps };
const originalPending = { ...pendingDeps };

beforeEach(() => {
  health = account(600, 0);
  workflows = new MemoryStore<WorkflowRecord>();
  Object.assign(workflowDeps, { store: () => workflows });
  const conv = new MemoryStore<ConversationRecord>();
  Object.assign(pendingDeps, { store: () => conv });
  setLimitStoreForTests(new MemoryStore());
  setLlmClient(null);
  vi.spyOn(mcp, "accountHealth").mockImplementation(async () => health);
  vi.spyOn(mcp, "accountResolve").mockImplementation(async () => ({ exists: true }));
  vi.spyOn(mcp, "price").mockImplementation(async (symbol: string) => ({ price_usd: PRICES[symbol], fresh: true, stale: false }));
  vi.spyOn(mcp, "prices").mockImplementation(async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, { symbol: s, price_usd: PRICES[s], stale: false }])));
  vi.spyOn(mcp, "wallet").mockImplementation(async () => ({
    authority: WALLET_A,
    sol_balance: "10",
    margin_account_exists: true,
    assets: ["SOL", "USDC", "USDT"].map((symbol) => ({ symbol, wallet_balance: "5000", lender_share_balance: "0", lender_redeemable_underlying: "0" })),
  }));
  vi.spyOn(mcp, "canBorrow").mockImplementation(async () => ({ allowed: true, projected_health_factor: "2.0", current_health_factor: null }));
  vi.spyOn(mcp, "maxBorrow").mockImplementation(async () => ({ max_amount: "100000" }));
  vi.spyOn(mcp, "call").mockImplementation(async (tool: string) => {
    if (["vanna_earn_write", "vanna_margin_trade", "vanna_swap", "vanna_farm_kamino", "vanna_account"].includes(tool)) return OK_ENVELOPE;
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

const chat = (message: string): Promise<ChatResponse> => handleChat({ req: { message }, user: USER });

function fakeLlm(handler: (req: LlmRequest) => { calls?: Array<{ name: string; args: Record<string, unknown> }> }): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async generate(req) {
      requests.push(req);
      return { text: null, calls: handler(req).calls ?? [], tokens: 50 };
    },
  };
}

describe("a list of amounts is a list of steps", () => {
  it("expands one verb over several amount+asset pairs and keeps the venue", () => {
    expect(expandAmountList("deposit 100 usdc, 100 usdt and 1 sol in lending pool")).toEqual([
      "deposit 100 usdc in lending pool",
      "deposit 100 usdt in lending pool",
      "deposit 1 sol in lending pool",
    ]);
    expect(expandAmountList("Can you supply 5 SOL & 10 USDC")).toEqual(["supply 5 SOL", "supply 10 USDC"]);
  });

  it("leaves everything else alone", () => {
    expect(expandAmountList("deposit 100 USDC")).toBeNull();
    expect(expandAmountList("swap 5 SOL to 100 USDC")).toBeNull();
    expect(expandAmountList("deposit 1 SOL, 2 USDC and borrow 5 USDT")).toBeNull(); // another action: not a plain list
    expect(expandAmountList("deposit 100 foo and 5 bar")).toBeNull(); // not product assets
  });

  it("draws one plan with a supply step per asset, each with the amount that was typed", async () => {
    const res = await chat("deposit 100 usdc, 100 usdt and 1 sol in lending pool");
    expect(res.kind).toBe("plan_preview");
    expect(res.plan?.steps.map((s) => [s.op, s.asset, s.amount])).toEqual([
      ["earn_supply", "USDC", "100"],
      ["earn_supply", "USDT", "100"],
      ["earn_supply", "SOL", "1"],
    ]);
  });
});

describe("a leverage target on a borrow is sized by the server", () => {
  it("'deposit 100 USDC in margin and borrow SOL 3x against it': borrows 2x the deposit's value in SOL, from live prices", async () => {
    const res = await chat("can you deposit 100 USDC in margin account and borrow SOL 3x against that USDC");
    expect(res.kind).toBe("plan_preview");
    const [dep, borrow] = res.plan!.steps;
    expect([dep.op, dep.asset, dep.amount]).toEqual(["deposit", "USDC", "100"]);
    // (3 - 1) x $100 = $200 of SOL at $120 = 1.666666666 SOL (rounded down to SOL's 9 decimals)
    expect([borrow.op, borrow.asset, borrow.amount]).toEqual(["borrow", "SOL", "1.666666666"]);
    const notes = res.plan!.warnings.join(" ");
    expect(notes).toContain("3x on your 100 USDC deposit");
    expect(notes).toMatch(/does not add price exposure/);
  });

  it("with no deposit in the request the target applies to the account's equity", async () => {
    health = account(600, 0);
    const res = await chat("borrow SOL 3x");
    expect(res.kind).toBe("preview");
    expect(res.preview?.slots.amount).toBe("10"); // 2 x $600 / $120
  });

  it("refuses a target that would breach the floor, and says the most that holds it", async () => {
    health = account(100, 95); // HF 1.05
    const res = await chat("deposit 10 USDC in margin and borrow SOL 5x against it");
    expect(res.kind).toBe("clarification");
    expect(res.message).toMatch(/below the 1\.15 floor/);
    expect(res.message).toMatch(/keeping health at 1\.15/);
  });

  it("does not treat the multiple as an amount", async () => {
    const intent = keywordRoute("deposit 100 USDC in margin and borrow SOL 3x against that USDC");
    expect(intent.lane).toBe("chain");
    if (intent.lane !== "chain") return;
    const borrow = intent.steps.find((s) => "write" in s && s.write.op === "borrow");
    expect(borrow && "write" in borrow ? borrow.write.amount : null).toEqual({ kind: "lev", multiple: 3 });
  });
});

describe("fallback router: the model reads what the patterns cannot, but supplies no number", () => {
  // These exercise the keyword router's own model fallback (used when the investigation stage is off or down).
  beforeEach(() => {
    process.env.COPILOT_INVESTIGATION = "off";
  });
  afterEach(() => {
    delete process.env.COPILOT_INVESTIGATION;
  });

  it("reads a differently worded list through the model and still draws the same plan", async () => {
    const llm = fakeLlm(() => ({
      calls: [{ name: "action_chain", args: { steps: [
        { op: "earn_supply", asset: "USDC", amount: "100" },
        { op: "earn_supply", asset: "USDT", amount: "100" },
        { op: "earn_supply", asset: "SOL", amount: "1" },
      ] } }],
    }));
    setLlmClient(llm);
    const res = await chat("put 100 USDC plus 100 USDT plus 1 SOL into the pool");
    expect(llm.requests).toHaveLength(1);
    expect(res.kind).toBe("plan_preview");
    expect(res.plan?.steps.map((s) => s.amount)).toEqual(["100", "100", "1"]);
  });

  it("drops a model amount that the user never typed and keeps the pattern router's question", async () => {
    setLlmClient(fakeLlm(() => ({ calls: [{ name: "write_action", args: { op: "borrow", asset: "SOL", amount: "42" } }] })));
    const res = await chat("borrow SOL, the usual amount");
    expect(res.kind).toBe("clarification");
    expect(res.message).toMatch(/How much SOL/);
    expect(workflows.docs.size).toBe(0);
  });

  it("does not let the model override a refusal", async () => {
    const llm = fakeLlm(() => ({ calls: [{ name: "write_action", args: { op: "earn_supply", asset: "SOL", amount: "1" } }] }));
    setLlmClient(llm);
    const res = await chat("liquidate that account");
    expect(res.kind).toBe("blocked");
    expect(onlyDeclineWording(llm.requests)).toBe(true);
  });

  it("checks typed amounts against the message and the user's earlier messages only", () => {
    const chain = { lane: "write", write: { op: "borrow", asset: "SOL", amount: { kind: "exact", value: "5" } } } as const;
    expect(amountsAreTyped(chain, "borrow 5 SOL")).toBe(true);
    expect(amountsAreTyped(chain, "borrow some SOL")).toBe(false);
    expect(amountsAreTyped(chain, "do it again", [{ role: "user", text: "borrow 5 SOL" }])).toBe(true);
    expect(amountsAreTyped(chain, "do it", [{ role: "assistant", text: "you can borrow 5 SOL" }])).toBe(false);
  });
});
