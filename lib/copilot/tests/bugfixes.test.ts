/**
 * Regression tests for the bugs the prompt suite found (2026-10-01). Each case failed before its fix.
 */
import { describe, expect, it } from "vitest";

import { keywordRoute } from "../router";
import { parseAmountToken, scanAmount } from "../intent";
import type { Intent } from "../intent";

const lane = (m: string): Intent => keywordRoute(m);
const text = (i: Intent): string => ("message" in i ? i.message : "question" in i ? i.question : "");

describe("bug 1: an amount is never silently changed", () => {
  it.each([
    ["supply -5 USDC", /positive/i],
    ["supply 1e30 SOL", /larger|far outside/i],
    ["supply 0 SOL", /above zero/i],
    ["supply NaN USDC", /not a number/i],
    ["supply Infinity SOL", /not a number/i],
    ["supply 1.0000000000001 USDC", /decimal/i],
    ["supply 1,5 SOL", /tell how to read|comma/i],
    ["supply 1.000,5 SOL", /tell how to read|comma/i],
  ])("%s is stopped with a reason", (message, reason) => {
    const i = lane(message);
    expect(["refuse", "ask"]).toContain(i.lane);
    expect(text(i)).toMatch(reason);
  });

  it("reads 1e-3 exactly as 0.001 and never as 1", () => {
    const r = parseAmountToken("1e-3", { allowExponent: true });
    expect(r).toEqual({ ok: true, value: "0.001" });
    const i = lane("supply 1e-3 SOL");
    expect(i.lane).toBe("write");
    if (i.lane === "write") expect(i.write.amount).toEqual({ kind: "exact", value: "0.001" });
  });

  it("refuses more decimals than the token has (USDC has 6)", () => {
    const i = lane("supply 1.1234567 USDC");
    expect(i.lane).toBe("refuse");
    expect(text(i)).toMatch(/6 decimal places/);
  });

  it("asks when two different amounts are present", () => {
    expect(scanAmount("supply 5 USDC and 7 USDC").issue?.kind).toBe("ambiguous");
  });

  it("ordinary amounts still work", () => {
    for (const [m, v] of [["supply 100 USDC", "100"], ["supply 1,000.50 USDC", "1000.5"], ["borrow 2k USDC", "2000"], ["supply .5 SOL", "0.5"]] as const) {
      const i = lane(m);
      expect(i.lane).toBe("write");
      if (i.lane === "write") expect(i.write.amount).toEqual({ kind: "exact", value: v });
    }
  });
});

describe("bug 2: conditions and schedules are refused, not previewed", () => {
  it.each([
    "limit order to swap 1 SOL to USDC at 200",
    "every week supply 5 USDC to earn",
    "supply 1 SOL when the price hits 90",
    "borrow 10 USDC next Monday",
    "swap 1 SOL to USDC at 5pm",
    "supply 10 USDC every day",
    "borrow 5 USDC tomorrow",
    "set a stop loss for my SOL",
    "swap 1 SOL to USDC if SOL drops below 100",
    "auto-compound my earn interest every hour",
    "rebalance my portfolio daily at 9am",
  ])("%s", (message) => {
    const i = lane(message);
    expect(i.lane).toBe("refuse");
    expect(text(i)).toMatch(/can't watch prices or act/);
  });

  it("offers the do-it-now version", () => {
    expect(text(lane("borrow 10 USDC next Monday"))).toMatch(/tell me: "borrow 10 usdc"/i);
  });

  it("does not misfire on plain sentences", () => {
    expect(lane("swap 1 SOL to USDC").lane).toBe("write");
    expect(lane("borrow 50 USDC keeping HF above 1.5").lane).toBe("write");
    expect(lane("what is the price of SOL").lane).toBe("read");
  });
});

describe("bug 3: a question with an amount is answered, never previewed", () => {
  it.each([
    ["can I borrow 500 USDC without getting liquidated?", { op: "borrow", amount: "500", asset: "USDC" }],
    ["if I withdraw 1 SOL of collateral, what will my HF be?", { op: "withdraw", amount: "1", asset: "SOL" }],
    ["how much USDC do I need to repay to get HF above 2?", { op: "repay", target_hf: 2, asset: "USDC" }],
    ["I have 3 SOL collateral. How many USDC can I borrow at HF 1.5?", { op: "borrow", target_hf: 1.5, asset: "USDC" }],
  ])("%s", (message, want) => {
    const i = lane(message);
    expect(i.lane).toBe("read");
    if (i.lane === "read") expect(i.read).toMatchObject({ kind: "whatif", ...want });
  });

  it("a polite request is still an order", () => {
    expect(lane("can you borrow 50 USDC").lane).toBe("write");
    expect(lane("please supply 100 USDC").lane).toBe("write");
  });
});

describe("bug 4: rate questions are not borrow requests", () => {
  it.each(["borrow rate for USDT", "what is the USDC borrow APR", "USDT borrow interest"])("%s", (message) => {
    const i = lane(message);
    expect(i.lane).toBe("read");
    if (i.lane === "read") expect(i.read.kind).toBe("pool");
  });
});
