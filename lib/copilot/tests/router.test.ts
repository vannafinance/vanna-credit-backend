import { describe, expect, it } from "vitest";
import { keywordRoute } from "../router";
import { intentFromCall } from "../vertex";
import { parseDecimalString, splitClauses, validateLever, validateWrite } from "../intent";
import type { Intent } from "../intent";

type Expect =
  | { lane: "read"; kind: string }
  | { lane: "write"; op: string; asset?: string | null; amount?: unknown; to?: string; source?: string }
  | { lane: "lever"; asset: string; leverage: number }
  | { lane: "chain"; ops: string[] }
  | { lane: "ask" }
  | { lane: "refuse" }
  | { lane: "unknown" };

const exact = (v: string) => ({ kind: "exact", value: v });

const table: Array<[string, Expect]> = [
  // reads
  ["what's my health factor?", { lane: "read", kind: "health" }],
  ["show my positions", { lane: "read", kind: "positions" }],
  ["what is my portfolio worth", { lane: "read", kind: "positions" }],
  ["how much do I owe", { lane: "read", kind: "debt" }],
  ["what's my collateral", { lane: "read", kind: "collateral" }],
  ["what is my wallet balance", { lane: "read", kind: "wallet" }],
  ["what's the price of SOL", { lane: "read", kind: "price" }],
  ["USDC supply APY", { lane: "read", kind: "pool" }],
  ["show the earn pool rates", { lane: "read", kind: "pool" }],
  ["how much interest have I earned", { lane: "read", kind: "earn_position" }],
  ["what are the kamino apys", { lane: "read", kind: "farm_markets" }],
  ["show my kamino positions", { lane: "read", kind: "farm_positions" }],
  ["how much can I borrow?", { lane: "read", kind: "capacity" }],
  ["how much USDC can I borrow", { lane: "read", kind: "capacity" }],
  ["how much SOL can I withdraw", { lane: "read", kind: "capacity" }],
  ["am I at risk of liquidation?", { lane: "read", kind: "liquidation_risk" }],
  ["show my history", { lane: "read", kind: "history" }],
  ["what assets does the protocol support", { lane: "read", kind: "protocol" }],
  ["quote 1 SOL to USDC", { lane: "read", kind: "quote" }],
  ["what is a health factor", { lane: "read", kind: "concept" }],
  ["explain leverage", { lane: "read", kind: "concept" }],
  // which yield product: a generic ask compares; a named product goes to that product
  ["where should I put my USDC for the best yield?", { lane: "read", kind: "yield_options" }],
  ["what are my options to earn on SOL", { lane: "read", kind: "yield_options" }],
  ["I want passive income", { lane: "read", kind: "yield_options" }],
  ["stake my SOL", { lane: "read", kind: "yield_options" }],
  ["best place for my USDC", { lane: "read", kind: "yield_options" }],
  ["earn on my USDC", { lane: "read", kind: "yield_options" }],
  ["deposit 1 SOL into the kamino vault", { lane: "write", op: "farm_deposit" }],
  ["supply 10 USDC to earn", { lane: "write", op: "earn_supply" }],
  ["show me the vaults", { lane: "read", kind: "vaults_list" }],
  ["what vault shares do I have", { lane: "read", kind: "vaults_positions" }],
  ["deposit 20 USDC into ETH basis", { lane: "write", op: "vault_deposit" }],
  ["withdraw all my USD* junior", { lane: "write", op: "vault_withdraw" }],
  ["deposit 20 USDC into a vault", { lane: "ask" }],
  ["what can you do", { lane: "read", kind: "help" }],
  // single writes
  ["supply 100 USDC", { lane: "write", op: "earn_supply", asset: "USDC", amount: exact("100") }],
  ["lend 1,000.5 usdt", { lane: "write", op: "earn_supply", asset: "USDT", amount: exact("1000.5") }],
  ["redeem 50 USDC from earn", { lane: "write", op: "earn_redeem", asset: "USDC", amount: exact("50") }],
  ["redeem all my USDC", { lane: "write", op: "earn_redeem", asset: "USDC", amount: { kind: "all" } }],
  ["withdraw half my SOL from earn", { lane: "write", op: "earn_redeem", asset: "SOL", amount: { kind: "pct", pct: 50 } }],
  ["deposit 2 SOL as collateral", { lane: "write", op: "deposit", asset: "SOL", amount: exact("2") }],
  ["add collateral 500 USDC", { lane: "write", op: "deposit", asset: "USDC", amount: exact("500") }],
  ["withdraw 1 SOL collateral", { lane: "write", op: "withdraw", asset: "SOL", amount: exact("1") }],
  ["borrow 50 USDC", { lane: "write", op: "borrow", asset: "USDC", amount: exact("50") }],
  ["borrow max USDC", { lane: "write", op: "borrow", asset: "USDC", amount: { kind: "all" } }],
  ["can you borrow 100 USDT?", { lane: "write", op: "borrow", asset: "USDT", amount: exact("100") }],
  ["repay 20 USDC", { lane: "write", op: "repay", asset: "USDC", amount: exact("20"), source: "wallet" }],
  ["repay all USDC debt", { lane: "write", op: "repay", asset: "USDC", amount: { kind: "all" } }],
  ["repay 10 USDC from my margin balance", { lane: "write", op: "repay", asset: "USDC", amount: exact("10"), source: "margin" }],
  ["swap 1 SOL to USDC", { lane: "write", op: "swap", asset: "SOL", to: "USDC", amount: exact("1"), source: "wallet" }],
  ["swap 10 USDC for JitoSOL in my margin account", { lane: "write", op: "swap", asset: "USDC", to: "JitoSOL", amount: exact("10"), source: "margin" }],
  ["farm 100 USDC on kamino", { lane: "write", op: "farm_deposit", asset: "USDC", amount: exact("100") }],
  ["deposit 1 SOL into kamino", { lane: "write", op: "farm_deposit", asset: "SOL", amount: exact("1") }],
  ["deposit 1 JitoSOL into kamino", { lane: "refuse" }],
  ["redeem my kUSDC", { lane: "write", op: "farm_redeem", asset: "USDC", amount: { kind: "all" } }],
  ["withdraw 5 USDC from kamino", { lane: "write", op: "farm_redeem", asset: "USDC", amount: exact("5") }],
  ["open a margin account", { lane: "write", op: "create_account" }],
  ["close my margin account", { lane: "write", op: "close_account" }],
  // strategies and chains
  ["lever my SOL 2x", { lane: "lever", asset: "SOL", leverage: 2 }],
  ["lever 5 SOL 3x", { lane: "lever", asset: "SOL", leverage: 3 }],
  ["go 2x long on JitoSOL", { lane: "lever", asset: "JitoSOL", leverage: 2 }],
  ["deposit 2 SOL as collateral then borrow 100 USDC", { lane: "chain", ops: ["deposit", "borrow"] }],
  ["deposit 2 SOL as collateral and borrow 100 USDC then tell me my health factor", { lane: "chain", ops: ["deposit", "borrow", "report"] }],
  // missing details -> ask, never a default
  ["supply USDC", { lane: "ask" }],
  ["borrow 50", { lane: "ask" }],
  ["deposit 10 SOL", { lane: "ask" }],
  ["withdraw 1 SOL", { lane: "ask" }],
  ["swap SOL", { lane: "ask" }],
  // guard refusals inside the router
  ["borrow 10 JitoSOL", { lane: "refuse" }],
  ["supply 10 JupSOL", { lane: "refuse" }],
  // nothing matched
  ["banana", { lane: "unknown" }],
];

function check(i: Intent, e: Expect) {
  expect(i.lane).toBe(e.lane);
  if (e.lane === "read" && i.lane === "read") expect(i.read.kind).toBe(e.kind);
  if (e.lane === "write" && i.lane === "write") {
    expect(i.write.op).toBe(e.op);
    if (e.asset !== undefined) expect(i.write.asset).toBe(e.asset);
    if (e.amount !== undefined) expect(i.write.amount).toEqual(e.amount);
    if (e.to) expect(i.write.to_asset).toBe(e.to);
    if (e.source) expect(i.write.source).toBe(e.source);
  }
  if (e.lane === "lever" && i.lane === "lever") {
    expect(i.lever.asset).toBe(e.asset);
    expect(i.lever.leverage).toBe(e.leverage);
  }
  if (e.lane === "chain" && i.lane === "chain") {
    expect(i.steps.map((s) => ("write" in s ? s.write.op : "report"))).toEqual(e.ops);
  }
}

describe("keyword router", () => {
  it.each(table)("%s", (message, expected) => {
    check(keywordRoute(message), expected);
  });

  it("repay all defaults to the wallet (the user's funds), margin only when said", () => {
    const r = keywordRoute("repay all USDC");
    expect(r.lane === "write" && r.write.source).toBe("wallet");
  });

  it("an ambiguous deposit offers Earn, margin and Kamino with the amount already filled in", () => {
    const r = keywordRoute("deposit 10 USDC");
    expect(r.lane).toBe("ask");
    if (r.lane === "ask") {
      expect(r.options?.map((o) => o.label)).toEqual(["Vanna Earn pool", "Margin account", "Kamino farm"]);
      const apply = r.options?.map((o) => (o.apply.lane === "write" ? `${o.apply.write.op}:${o.apply.write.asset}:${JSON.stringify(o.apply.write.amount)}` : ""));
      expect(apply?.[0]).toBe('earn_supply:USDC:{"kind":"exact","value":"10"}');
    }
  });

  it("collateral-only assets are not offered the Earn option", () => {
    const r = keywordRoute("deposit 1 JitoSOL");
    expect(r.lane === "ask" && r.options?.map((o) => o.label)).toEqual(["Margin account", "Kamino farm"]);
  });

  it("a lever request without a borrow asset is resolved later by a question, not a default", () => {
    const r = keywordRoute("lever my SOL 2x");
    expect(r.lane === "lever" && r.lever.borrow_asset).toBeNull();
  });

  it("a stated health floor is carried", () => {
    const r = keywordRoute("lever 5 SOL 2x keeping health factor above 1.5");
    expect(r.lane === "lever" && r.lever.min_hf).toBe(1.5);
  });

  it("a percentage on a later chain step is asked about or carried for the planner to refuse, never guessed", () => {
    const r = keywordRoute("deposit 2 SOL as collateral then borrow 50% of USDC");
    expect(["chain", "ask"]).toContain(r.lane);
  });
});

describe("amount parsing", () => {
  it.each([
    ["1,000.50", "1000.5"],
    ["2k", "2000"],
    [".5", "0.5"],
    ["007", "7"],
    ["0", null],
    ["-1", null],
    ["1e3", null],
    ["abc", null],
    ["1.1234567890123", null],
  ])("%s -> %s", (raw, want) => {
    expect(parseDecimalString(raw)).toBe(want);
  });

  it("splits chains on then / and <verb>", () => {
    expect(splitClauses("deposit 2 SOL then borrow 5 USDC and repay 1 USDC")).toHaveLength(3);
    expect(splitClauses("supply 100 USDC and USDT")).toHaveLength(1);
  });
});

describe("guards apply to every intent", () => {
  it("rejects assets outside the product and lend/borrow of collateral-only assets", () => {
    expect(validateWrite({ op: "borrow", asset: "JitoSOL", amount: { kind: "all" } }).ok).toBe(false);
    expect(validateWrite({ op: "earn_supply", asset: "JupSOL", amount: { kind: "all" } }).ok).toBe(false);
    expect(validateWrite({ op: "swap", asset: "SOL", to_asset: "SOL", amount: { kind: "all" } }).ok).toBe(false);
    expect(validateWrite({ op: "deposit", asset: "JitoSOL", amount: { kind: "all" } }).ok).toBe(true);
    expect(validateWrite({ op: "deposit", asset: "SPYx", amount: { kind: "all" } }).ok).toBe(false);
  });

  it("follows the app's token registry: new collateral tokens, USDT not depositable, delisted farms", () => {
    const exact = (value: string) => ({ kind: "exact" as const, value });
    expect(validateWrite({ op: "deposit", asset: "NVDAx", amount: exact("1.5") }).ok).toBe(true);
    expect(validateWrite({ op: "deposit", asset: "JupUSD", amount: exact("10") }).ok).toBe(true);
    expect(validateWrite({ op: "swap", asset: "NVDAx", to_asset: "AAPLx", amount: exact("1") }).ok).toBe(true);
    expect(validateWrite({ op: "deposit", asset: "NVDAx", amount: exact("1.123456789") }).ok).toBe(false); // 8 decimals
    expect(validateWrite({ op: "earn_supply", asset: "JupUSD", amount: exact("10") }).ok).toBe(false);
    expect(validateWrite({ op: "borrow", asset: "TSLAx", amount: exact("1") }).ok).toBe(false);
    const usdt = validateWrite({ op: "deposit", asset: "USDT", amount: exact("10") });
    expect(usdt.ok).toBe(false);
    expect(!usdt.ok && usdt.message).toMatch(/not offered as a margin collateral deposit/);
    expect(validateWrite({ op: "withdraw", asset: "USDT", amount: { kind: "all" } }).ok).toBe(true);
    expect(validateWrite({ op: "borrow", asset: "USDT", amount: exact("10") }).ok).toBe(true);
    const farm = validateWrite({ op: "farm_deposit", asset: "JitoSOL", amount: exact("1") });
    expect(!farm.ok && farm.message).toMatch(/closed to new supply/);
    expect(validateWrite({ op: "farm_redeem", asset: "JitoSOL", amount: { kind: "all" } }).ok).toBe(true);
    expect(validateWrite({ op: "farm_deposit", asset: "NVDAx", amount: exact("1") }).ok).toBe(false);
    expect(validateWrite({ op: "farm_deposit", asset: "SOL", amount: exact("1") }).ok).toBe(true);
  });

  it("bounds leverage and refuses borrowing the asset being levered", () => {
    expect(validateLever({ asset: "SOL", leverage: 1, borrow_asset: null, amount: null }).ok).toBe(false);
    expect(validateLever({ asset: "SOL", leverage: 11, borrow_asset: null, amount: null }).ok).toBe(false);
    expect(validateLever({ asset: "USDC", leverage: 2, borrow_asset: "USDC", amount: null }).ok).toBe(false);
    expect(validateLever({ asset: "SOL", leverage: 2, borrow_asset: null, amount: null }).ok).toBe(true);
  });
});

describe("model function calls go through the same guards", () => {
  it("builds a write from a call", () => {
    const i = intentFromCall("write_action", { op: "borrow", asset: "USDC", amount: "25" });
    expect(i.lane === "write" && i.write.amount).toEqual(exact("25"));
  });
  it("cannot smuggle an unsupported asset or op", () => {
    expect(intentFromCall("write_action", { op: "borrow", asset: "JupUSD", amount: "5" }).lane).toBe("refuse");
    expect(intentFromCall("write_action", { op: "liquidate", asset: "SOL", amount: "5" }).lane).toBe("unknown");
    expect(intentFromCall("write_action", { op: "borrow", asset: "JitoSOL", amount: "5" }).lane).toBe("refuse");
  });
  it("a missing asset is a question, never a default", () => {
    expect(intentFromCall("write_action", { op: "borrow", amount: "5" }).lane).toBe("ask");
  });
  it("turns a non-numeric amount into a missing amount, never into a number", () => {
    const i = intentFromCall("write_action", { op: "earn_supply", asset: "USDC", amount: "a lot" });
    expect(i.lane === "write" && i.write.amount).toBeNull();
  });
  it("maps ask_user, decline and malformed calls", () => {
    expect(intentFromCall("ask_user", { question: "Which asset?" }).lane).toBe("ask");
    expect(intentFromCall("decline", { reason: "x" }).lane).toBe("refuse");
    expect(intentFromCall("read_question", { kind: "nope" }).lane).toBe("unknown");
    expect(intentFromCall("mystery", {}).lane).toBe("unknown");
  });
  it("accepts a chain with a report step", () => {
    const i = intentFromCall("action_chain", { steps: [{ op: "deposit", asset: "SOL", amount: "1" }, { report: true }] });
    expect(i.lane).toBe("chain");
  });
});
