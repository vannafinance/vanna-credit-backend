/**
 * handleChat end to end with a FAKE MCP and a FAKE language model (no network, no credentials).
 * The real code paths run: firewall, router, limits, read answers, risk gate, plan store, pending picks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChat } from "../index";
import { mcp, MCPError } from "../mcp-client";
import { setLimitStoreForTests, tokensUsedToday } from "../limits";
import { priceDeps } from "../mcp-facts";
import { setLlmClient, type LlmClient, type LlmRequest } from "../vertex";
import { workflowDeps, type WorkflowRecord } from "../workflow";
import { pendingDeps, type ConversationRecord } from "../workflow/pending";
import type { ChatRequest, ChatResponse } from "../types";
import { MemoryStore, userFor, WALLET_A, WALLET_B } from "./helpers";

const USER = userFor(WALLET_A);

const HEALTH = {
  margin_account: "GCL2pGFBKnBhkGEPZ3BhC4FuqHnfpJJnr8i9nnLKkTgD",
  collateral: [{ symbol: "SOL", raw_balance: 5_000_000_000, ui_balance: "5", usd_value: "600.00", price: { usd: "120", source: "pyth", fresh: true } }],
  debt: [],
  total_collateral_usd: "600.00",
  total_debt_usd: "0.00",
  health_factor: null,
  is_healthy: true,
  is_liquidatable: false,
  price_checks_pass: true,
};
const HEALTH_WITH_DEBT = {
  ...HEALTH,
  debt: [{ symbol: "USDC", raw_debt: 200_000_000, ui_debt: "200", usd_value: "200.00", price: { usd: "1", source: "pyth", fresh: true } }],
  total_debt_usd: "200.00",
  health_factor: "3.0",
};

const PRICES: Record<string, string> = { SOL: "120", USDC: "1", USDT: "1", JitoSOL: "140", JupSOL: "130" };

interface Fake {
  health: Record<string, unknown> | Error;
  canBorrow: Record<string, unknown>;
  walletSol: string;
  calls: Array<{ fn: string; args: unknown[] }>;
  buildEnvelope: Record<string, unknown>;
}

function envelope(ok = true): Record<string, unknown> {
  return {
    schemaVersion: "1",
    transactions: [
      {
        id: "action",
        unsignedTransaction: "AQAAAA==",
        blockhash: "SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxxxxx37xe1",
        lastValidBlockHeight: "225656",
        simulation: ok ? { status: "success", err: null } : { status: "failed", err: "Program log: Error: insufficient funds" },
      },
    ],
    summary: { action: "supply" },
    preview: null,
    signing_status: "needs_wallet_sign",
    error: null,
    code: ok ? null : "simulation_failed",
    reason: ok ? null : "Program log: Error: insufficient funds",
    simulation_success: ok,
  };
}

let fake: Fake;
let workflows: MemoryStore<WorkflowRecord>;
const originalDeps = { ...workflowDeps };
const originalPending = { ...pendingDeps };

function installFake() {
  vi.spyOn(mcp, "accountHealth").mockImplementation(async (...args: unknown[]) => {
    fake.calls.push({ fn: "accountHealth", args });
    if (fake.health instanceof Error) throw fake.health;
    return fake.health;
  });
  vi.spyOn(mcp, "accountResolve").mockImplementation(async () => ({ exists: !(fake.health instanceof Error) }));
  vi.spyOn(mcp, "price").mockImplementation(async (symbol: string) => ({ price_usd: PRICES[symbol], fresh: true, stale: false }));
  vi.spyOn(mcp, "prices").mockImplementation(async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, { symbol: s, price_usd: PRICES[s], stale: false }])));
  vi.spyOn(mcp, "poolStats").mockImplementation(async (symbol: string) => ({ asset_symbol: symbol, supply_apr_pct: "4.5", borrow_apr_pct: "6.25", utilization_rate_pct: "55.5", available_liquidity: "1000000" }));
  vi.spyOn(mcp, "wallet").mockImplementation(async () => ({
    authority: WALLET_A,
    sol_balance: fake.walletSol,
    margin_account_exists: true,
    assets: [
      { symbol: "SOL", wallet_balance: "0", lender_share_balance: "0", lender_redeemable_underlying: "0" },
      { symbol: "USDC", wallet_balance: "2000", lender_share_balance: "0", lender_redeemable_underlying: "0" },
    ],
  }));
  vi.spyOn(mcp, "canBorrow").mockImplementation(async (...args: unknown[]) => {
    fake.calls.push({ fn: "canBorrow", args });
    return fake.canBorrow;
  });
  vi.spyOn(mcp, "swapQuote").mockImplementation(async () => ({ from: "USDC", to: "SOL", in_amount: "600", out_amount: "4.98", min_out_amount: "4.93" }));
  vi.spyOn(mcp, "maxBorrow").mockImplementation(async () => ({ max_amount: "500" }));
  vi.spyOn(mcp, "call").mockImplementation(async (tool: string, args: Record<string, unknown>) => {
    fake.calls.push({ fn: `call:${tool}:${String(args.action)}`, args: [args] });
    if (tool === "vanna_earn_write" || tool === "vanna_margin_trade" || tool === "vanna_swap" || tool === "vanna_farm_kamino" || tool === "vanna_account") {
      if (tool === "vanna_swap" && args.action === "quote") return { out_amount: "4.98", min_out_amount: "4.93" };
      return fake.buildEnvelope;
    }
    throw new MCPError(`unexpected tool ${tool}`, { code: "invalid_input" });
  });
}

beforeEach(() => {
  fake = { health: HEALTH, canBorrow: { allowed: true, projected_health_factor: "2.0", current_health_factor: null }, walletSol: "10", calls: [], buildEnvelope: envelope() };
  workflows = new MemoryStore<WorkflowRecord>();
  Object.assign(workflowDeps, { store: () => workflows });
  Object.assign(pendingDeps, { store: () => new (class extends MemoryStore<ConversationRecord> {})() });
  const conv = new MemoryStore<ConversationRecord>();
  Object.assign(pendingDeps, { store: () => conv });
  setLimitStoreForTests(new MemoryStore());
  setLlmClient(null);
  // This suite covers the deterministic lanes and the router's model fallback; the investigation stage has its own
  // suite (investigation.test.ts).
  process.env.COPILOT_INVESTIGATION = "off";
  installFake();
});

afterEach(() => {
  delete process.env.COPILOT_INVESTIGATION;
  vi.restoreAllMocks();
  Object.assign(workflowDeps, originalDeps);
  Object.assign(pendingDeps, originalPending);
  setLimitStoreForTests(null);
  setLlmClient(null);
});

const chat = (message: string, extra: Partial<ChatRequest> = {}, user = USER): Promise<ChatResponse> => handleChat({ req: { message, ...extra }, user });
const buildCalls = () => fake.calls.filter((c) => /^call:vanna_(earn_write|margin_trade|swap|farm_kamino|account):(?!quote)/.test(c.fn));

function fakeLlm(handler: (req: LlmRequest) => { text?: string | null; calls?: Array<{ name: string; args: Record<string, unknown> }>; tokens?: number }): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async generate(req) {
      requests.push(req);
      const r = handler(req);
      return { text: r.text ?? null, calls: r.calls ?? [], tokens: r.tokens ?? 100 };
    },
  };
}

describe("session and limits", () => {
  it("asks an unauthenticated caller to sign in and does nothing else", async () => {
    const res = await handleChat({ req: { message: "what is my health factor" }, user: null });
    expect(res.kind).toBe("needs_login");
    expect(fake.calls).toHaveLength(0);
  });

  it("enforces the per-user chat rate", async () => {
    process.env.COPILOT_RATE_CHAT_PER_MIN = "2";
    try {
      await chat("what is the price of SOL");
      await chat("what is the price of SOL");
      const third = await chat("what is the price of SOL");
      expect(third.kind).toBe("error");
      expect(third.limit?.kind).toBe("rate");
      // a different wallet has its own bucket
      expect((await chat("what is the price of SOL", {}, userFor(WALLET_B))).kind).toBe("answer");
    } finally {
      delete process.env.COPILOT_RATE_CHAT_PER_MIN;
    }
  });

  it("stops at the daily token cap and executes nothing", async () => {
    process.env.COPILOT_DAILY_TOKEN_CAP = "50";
    try {
      setLlmClient(fakeLlm(() => ({ calls: [{ name: "read_question", args: { kind: "health" } }], tokens: 60 })));
      await chat("give me the state of my account"); // model route costs 60 tokens
      expect(await tokensUsedToday(USER)).toBeGreaterThanOrEqual(60); // routing call + wording call both count
      const next = await chat("supply 10 USDC");
      expect(next.kind).toBe("error");
      expect(next.limit?.kind).toBe("daily_tokens");
      expect(buildCalls()).toHaveLength(0);
    } finally {
      delete process.env.COPILOT_DAILY_TOKEN_CAP;
    }
  });
});

describe("firewall and refusals", () => {
  it.each(["liquidate that account", "write me a python script", "supply 10 JupUSD", "send 1 SOL to 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"])("blocks %s before any data or model call", async (m) => {
    const llm = fakeLlm(() => ({}));
    setLlmClient(llm);
    const res = await chat(m);
    expect(res.kind).toBe("blocked");
    expect(fake.calls).toHaveLength(0);
    expect(llm.requests).toHaveLength(0);
  });
});

describe("read lane", () => {
  it("answers a health question from MCP numbers, not from the model", async () => {
    fake.health = HEALTH_WITH_DEBT;
    const res = await chat("what's my health factor?");
    expect(res.kind).toBe("answer");
    expect(res.answer?.headline).toContain("3.00");
    expect(res.answer?.facts.find((f) => f.label === "debt")?.value).toBe("$200.00");
    expect(res.answer?.facts.find((f) => f.label === "collateral")?.value).toBe("$600.00");
  });

  it("no debt reports no health factor instead of a number", async () => {
    const res = await chat("what's my health factor");
    expect(res.answer?.headline).toMatch(/no debt/i);
    expect(res.answer?.facts.find((f) => f.label === "health factor")?.value).toBe("no debt");
  });

  it("says the margin account is missing when there is none", async () => {
    fake.health = new MCPError("Account not found", { code: "account_not_found" });
    const res = await chat("what's my health factor");
    expect(res.kind).toBe("answer");
    expect(res.answer?.headline).toMatch(/don't have a margin account/);
    expect(res.answer?.facts).toHaveLength(0);
  });

  it("when the MCP is down it says it has no figure and invents none", async () => {
    fake.health = new MCPError("boom", { code: "mcp_unreachable", retryable: true });
    const res = await chat("what's my health factor");
    expect(res.kind).toBe("unavailable");
    expect(res.answer?.facts).toHaveLength(0);
    expect(res.message).not.toMatch(/\d\.\d\d/);
  });

  it("partial account data is refused rather than guessed", async () => {
    fake.health = { ...HEALTH, total_debt_usd: undefined };
    const res = await chat("what's my health factor");
    expect(res.kind).toBe("unavailable");
  });

  it("pool rates come straight from the MCP", async () => {
    const res = await chat("USDC supply APY");
    expect(res.answer?.headline).toContain("4.50%");
  });

  it("safe borrow is sized to the 1.15 floor and verified through can_borrow", async () => {
    fake.health = HEALTH_WITH_DEBT;
    fake.canBorrow = { allowed: true, projected_health_factor: "1.16", current_health_factor: "3.0" };
    const res = await chat("how much USDC can I borrow");
    expect(res.kind).toBe("answer");
    // (600 - 1.15*200) / 0.15 = 2466.67 USD max at the floor, shaved 0.5%
    const fact = res.answer?.facts.find((f) => f.label.startsWith("safe borrow"));
    expect(fact?.value).toMatch(/2,454\.3/);
    expect(res.answer?.facts.find((f) => f.label.startsWith("protocol maximum"))?.value).toContain("500");
  });

  it("explains a concept without touching the MCP", async () => {
    const res = await chat("what is a health factor");
    expect(res.answer?.headline).toMatch(/1\.10/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("model wording is constrained to the facts", () => {
  it("accepts wording whose numbers are all in the data", async () => {
    fake.health = HEALTH_WITH_DEBT;
    setLlmClient(fakeLlm(() => ({ text: JSON.stringify({ headline: "Your margin account sits at a health factor of 3.00, well above liquidation at 1.10." }) })));
    const res = await chat("what's my health factor?");
    expect(res.answer?.headline).toMatch(/well above liquidation/);
  });

  it("discards wording that contains an invented number and keeps the code-built answer", async () => {
    fake.health = HEALTH_WITH_DEBT;
    setLlmClient(fakeLlm(() => ({ text: JSON.stringify({ headline: "Your health factor is 4.25, which is great." }) })));
    const res = await chat("what's my health factor?");
    expect(res.answer?.headline).toBe("Your health factor is 3.00 on your margin account.");
  });

  it("discards markdown and falls back when the model errors", async () => {
    fake.health = HEALTH_WITH_DEBT;
    setLlmClient(fakeLlm(() => ({ text: JSON.stringify({ headline: "**Your health factor is 3.00**" }) })));
    expect((await chat("what's my health factor?")).answer?.headline).toBe("Your health factor is 3.00 on your margin account.");
    setLlmClient({ generate: async () => { throw new Error("vertex 500"); } });
    expect((await chat("what's my health factor?")).answer?.headline).toBe("Your health factor is 3.00 on your margin account.");
  });
});

describe("model routing", () => {
  it("routes an unusual phrase by function call, through the same guards", async () => {
    fake.health = HEALTH_WITH_DEBT;
    const llm = fakeLlm((req) => (req.tools?.length ? { calls: [{ name: "read_question", args: { kind: "health" } }] } : { text: null }));
    setLlmClient(llm);
    const res = await chat("give me the state of my account");
    expect(res.kind).toBe("answer");
    expect(llm.requests[0].forceTool).toBe(true);
  });

  it("cannot be talked into borrowing a collateral-only asset", async () => {
    setLlmClient(fakeLlm(() => ({ calls: [{ name: "write_action", args: { op: "borrow", asset: "JitoSOL", amount: "5" } }] })));
    const res = await chat("sort out that staked thing for my account");
    expect(res.kind).toBe("blocked");
    expect(buildCalls()).toHaveLength(0);
  });

  it("without a model it says what it could not do instead of guessing", async () => {
    const res = await chat("sort out that staked thing for my account");
    expect(res.kind).toBe("unavailable");
  });
});

describe("single write", () => {
  it("builds and simulates, then returns a preview bound to a server-held plan (no transaction leaves the server yet)", async () => {
    const res = await chat("supply 100 USDC");
    expect(res.kind).toBe("preview");
    expect(res.workflow_id).toBeTruthy();
    expect(res.plan?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(res.plan?.steps).toHaveLength(1);
    expect(res.plan?.state).toBe("proposed");
    expect(res.preview?.requires_signature).toBe(true);
    expect(res.unsigned_tx).toBeFalsy();
    expect(JSON.stringify(res)).not.toContain("unsignedTransaction");
    expect(buildCalls()).toHaveLength(1);
    expect(fake.calls.find((c) => c.fn === "call:vanna_earn_write:supply")?.args[0]).toMatchObject({ action: "supply", owner: WALLET_A, asset: "USDC", amount: "100" });
  });

  it("identity comes from the session: a wallet smuggled into the message or body is ignored", async () => {
    await chat("supply 100 USDC");
    const args = fake.calls.find((c) => c.fn === "call:vanna_earn_write:supply")?.args[0] as Record<string, unknown>;
    expect(args.owner).toBe(USER.wallet);
    expect((await chat(`supply 100 USDC for ${WALLET_B}`)).kind).toBe("blocked");
  });

  it("a failing simulation is explained and nothing is stored", async () => {
    fake.buildEnvelope = envelope(false);
    const res = await chat("supply 100 USDC");
    expect(res.kind).toBe("error");
    expect(res.message).toMatch(/does not hold enough/);
    expect(workflows.docs.size).toBe(0);
  });

  it("blocks a borrow that would leave the account below the 1.15 floor and builds nothing", async () => {
    fake.health = HEALTH_WITH_DEBT;
    fake.canBorrow = { allowed: true, projected_health_factor: "1.12", current_health_factor: "3.0" };
    const res = await chat("borrow 500 USDC");
    expect(res.kind).toBe("blocked");
    expect(res.message).toMatch(/1\.12/);
    expect(buildCalls()).toHaveLength(0);
    expect(workflows.docs.size).toBe(0);
  });

  it("allows a borrow that stays above the floor, with the MCP's projected health factor on the card", async () => {
    fake.health = HEALTH_WITH_DEBT;
    fake.canBorrow = { allowed: true, projected_health_factor: "2.0", current_health_factor: "3.0" };
    const res = await chat("borrow 100 USDC");
    expect(res.kind).toBe("preview");
    expect(res.preview?.simulation?.hf_before).toBe(3);
    expect(res.preview?.simulation?.hf_after).toBe(2);
    expect(res.preview?.risk.decision).toBe("allow");
  });

  it("flags a thin buffer above the floor", async () => {
    fake.health = HEALTH_WITH_DEBT;
    fake.canBorrow = { allowed: true, projected_health_factor: "1.2", current_health_factor: "3.0" };
    const res = await chat("borrow 100 USDC");
    expect(res.preview?.risk.decision).toBe("needs_confirmation");
  });

  it("fails closed when the MCP does not report a projected health factor", async () => {
    fake.health = HEALTH_WITH_DEBT;
    fake.canBorrow = { allowed: true };
    expect((await chat("borrow 100 USDC")).kind).toBe("blocked");
  });

  it("enforces the per-action USD cap BEFORE building", async () => {
    const res = await chat("supply 6000 USDC");
    expect(res.kind).toBe("error");
    expect(res.limit?.kind).toBe("spend");
    expect(buildCalls()).toHaveLength(0);
  });

  it("enforces the per-minute write-build rate", async () => {
    process.env.COPILOT_RATE_WRITE_PER_MIN = "1";
    try {
      expect((await chat("supply 10 USDC")).kind).toBe("preview"); // dry-build consumes the one allowed build
      const second = await chat("supply 10 USDC");
      expect(second.kind).toBe("error");
      expect(second.limit?.kind).toBe("rate");
    } finally {
      delete process.env.COPILOT_RATE_WRITE_PER_MIN;
    }
  });

  it("refuses margin actions when there is no margin account, but offers to open one for a deposit", async () => {
    fake.health = new MCPError("Account not found", { code: "account_not_found" });
    const borrow = await chat("borrow 10 USDC");
    expect(borrow.kind).toBe("blocked");
    const dep = await chat("deposit 1 SOL as collateral");
    expect(dep.kind).toBe("plan_preview");
    expect(dep.plan?.steps.map((s) => s.op)).toEqual(["create_account", "deposit"]);
  });

  it("the page guide surface never writes", async () => {
    const res = await chat("supply 100 USDC", { surface: "assistant" });
    expect(res.kind).toBe("blocked");
    expect(buildCalls()).toHaveLength(0);
  });

  it("a percentage is resolved once against the live balance and frozen as an exact amount", async () => {
    const res = await chat("supply 50% of my USDC");
    expect(res.kind).toBe("preview");
    expect(res.preview?.slots.amount).toBe("1000");
  });
});

describe("clarification", () => {
  it("stores the options server-side and runs the picked one exactly once", async () => {
    const res = await chat("deposit 10 USDC");
    expect(res.kind).toBe("clarification");
    expect(res.clarify_options?.map((o) => o.label)).toEqual(["Vanna Earn pool", "Margin account", "Kamino farm"]);
    const pick = await chat("", { conversation_id: res.conversation_id, clarify: { pending_id: res.pending_id as string, option_id: "opt-2" } });
    expect(pick.kind).toBe("preview");
    expect(pick.plan?.steps[0].op).toBe("deposit");
    const replay = await chat("", { conversation_id: res.conversation_id, clarify: { pending_id: res.pending_id as string, option_id: "opt-2" } });
    expect(replay.kind).toBe("error");
  });

  it("another wallet cannot use someone else's pending choice", async () => {
    const res = await chat("deposit 10 USDC");
    const stolen = await chat("", { conversation_id: res.conversation_id, clarify: { pending_id: res.pending_id as string, option_id: "opt-1" } }, userFor(WALLET_B));
    expect(stolen.kind).toBe("error");
    expect(buildCalls()).toHaveLength(0);
  });

  it("an unknown option id or a wrong pending id is rejected", async () => {
    const res = await chat("deposit 10 USDC");
    expect((await chat("", { conversation_id: res.conversation_id, clarify: { pending_id: res.pending_id as string, option_id: "opt-99" } })).kind).toBe("error");
    expect((await chat("", { conversation_id: res.conversation_id, clarify: { pending_id: "nope", option_id: "opt-1" } })).kind).toBe("error");
  });

  it("missing amounts are asked for, never defaulted", async () => {
    const res = await chat("supply USDC");
    expect(res.kind).toBe("clarification");
    expect(res.message).toMatch(/How much USDC/);
    expect(buildCalls()).toHaveLength(0);
  });
});

describe("plan lane", () => {
  it("chains explicit steps into a frozen plan and checks the first one now", async () => {
    fake.health = HEALTH_WITH_DEBT;
    const res = await chat("deposit 2 SOL as collateral then borrow 100 USDC then tell me my health factor");
    expect(res.kind).toBe("plan_preview");
    expect(res.plan?.steps.map((s) => s.op)).toEqual(["deposit", "borrow", "report"]);
    expect(res.plan?.signature_count).toBe(2);
    expect(res.plan?.steps[2].kind).toBe("read");
    expect(buildCalls()).toHaveLength(0); // later steps cannot be simulated before earlier ones land
  });

  it("lever: asks which stable to borrow when not stated", async () => {
    const res = await chat("lever my SOL 2x");
    expect(res.kind).toBe("clarification");
    expect(res.clarify_options?.map((o) => o.label)).toEqual(["Borrow USDC", "Borrow USDT"]);
  });

  it("lever: sizes borrow = (N-1) x equity, swap inside margin, worst-case HF above the floor", async () => {
    const first = await chat("lever my SOL 2x");
    const res = await chat("", { conversation_id: first.conversation_id, clarify: { pending_id: first.pending_id as string, option_id: "opt-1" } });
    expect(res.kind).toBe("plan_preview");
    const steps = res.plan!.steps;
    expect(steps.map((s) => s.op)).toEqual(["borrow", "swap", "report"]);
    expect(steps[0]).toMatchObject({ asset: "USDC", amount: "600" }); // 5 SOL x $120 = $600 equity -> borrow $600
    expect(steps[1].slots).toMatchObject({ to_asset: "SOL", mode: "margin" });
    expect(res.plan!.hf_floor).toBe(1.15);
    expect(res.plan!.simulation?.hf_after).toBeGreaterThanOrEqual(1.15);
    expect(res.plan!.simulation?.hf_after).toBeCloseTo(1.99, 2);
    expect(res.plan!.warnings.join(" ")).toMatch(/worst allowed price/);
  });

  it("lever: refuses a leverage that cannot hold the floor and offers the largest one that can", async () => {
    fake.health = HEALTH_WITH_DEBT;
    const res = await chat("lever 5 SOL 9x borrowing USDC");
    expect(res.kind).toBe("clarification");
    expect(res.message).toMatch(/below the 1\.15 floor/);
    expect(res.clarify_options?.[0].label).toMatch(/^Use \d+\.\dx instead$/);
    const offered = Number(res.clarify_options![0].label.match(/(\d+\.\d)x/)![1]);
    expect(offered).toBeGreaterThan(1);
    expect(offered).toBeLessThan(9);
  });

  it("lever with a fresh deposit opens the account and deposits first when needed", async () => {
    fake.health = new MCPError("Account not found", { code: "account_not_found" });
    const res = await chat("lever 2 SOL 2x borrowing USDC");
    expect(res.kind).toBe("plan_preview");
    expect(res.plan!.steps.map((s) => s.op)).toEqual(["create_account", "deposit", "borrow", "swap", "report"]);
    expect(res.plan!.steps[1]).toMatchObject({ asset: "SOL", amount: "2" });
  });

  it("lever refuses when a needed price is unavailable", async () => {
    vi.spyOn(mcp, "price").mockImplementation(async () => {
      throw new Error("no oracle");
    });
    const res = await chat("lever my SOL 2x borrowing USDC");
    expect(res.kind).toBe("clarification");
    expect(res.message).toMatch(/unavailable/);
  });

  it("lever still plans when a price is only flagged stale: the build re-checks and the MCP fails closed", async () => {
    priceDeps.refresh = vi.fn(async () => undefined);
    priceDeps.sleep = vi.fn(async () => undefined);
    vi.spyOn(mcp, "price").mockImplementation(async () => ({ price_usd: "120", stale: true }));
    const res = await chat("lever my SOL 2x borrowing USDC");
    expect(res.kind).toBe("plan_preview");
  });

  it("a stated health floor above 1.15 is honoured", async () => {
    const res = await chat("lever 5 SOL 2x borrowing USDC keeping health factor above 1.5");
    expect(res.kind).toBe("plan_preview");
    expect(res.plan!.hf_floor).toBe(1.5);
  });
});
