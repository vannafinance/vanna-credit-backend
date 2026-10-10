/**
 * Refusals: the rule decides, Gemini words the reply. Checks that the model's wording is used when it is safe, that the
 * rule's own wording is used when it is not (or when the model fails), and that the wording call can never act.
 */
import { afterEach, describe, expect, it } from "vitest";

import { composeDecline, declineIsSafe, DECLINE_SYSTEM } from "../decline";
import { setLlmClient, type LlmClient, type LlmRequest } from "../vertex";

function replying(reply: string | (() => never)): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async generate(req) {
      requests.push(req);
      if (typeof reply === "function") reply();
      return { text: JSON.stringify({ reply }), calls: [], tokens: 40 };
    },
  };
}

const FALLBACK = "BONK is not part of the Vanna Copilot product. I work with SOL, USDC, USDT (lend and borrow).";

afterEach(() => setLlmClient(null));

describe("composeDecline", () => {
  it("uses Gemini's wording for this message, with no tools", async () => {
    const llm = replying("BONK isn't something Vanna supports, so I can't buy it. You could swap into SOL or USDC instead, for example \"swap 10 USDC to SOL\".");
    setLlmClient(llm);
    const out = await composeDecline({ message: "yo buy me some bonk", reason: "refuse:unoffered_asset", fallback: FALLBACK });
    expect(out.used).toBe(true);
    expect(out.text).toMatch(/BONK isn't something Vanna supports/);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0].system).toBe(DECLINE_SYSTEM);
    expect(llm.requests[0].tools).toBeUndefined();
    expect(llm.requests[0].user).toContain("yo buy me some bonk");
  });

  it.each([
    ["an invented number", "Sure, BONK pays 42.7% APY on Vanna."],
    ["an address", "Send it to 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin instead."],
    ["a link", "See https://example.com for BONK."],
    ["markdown", "**No.** BONK is not supported."],
    ["a claim that something happened", "Done, I've swapped your USDC for SOL instead."],
    ["nothing", ""],
  ])("falls back to the rule's wording when the reply has %s", async (_label, reply) => {
    setLlmClient(replying(reply));
    const out = await composeDecline({ message: "buy bonk", reason: "refuse:unoffered_asset", fallback: FALLBACK });
    expect(out.used).toBe(false);
    expect(out.text).toBe(FALLBACK);
  });

  it("falls back when the model errors", async () => {
    setLlmClient(replying(() => { throw new Error("vertex down"); }));
    const out = await composeDecline({ message: "buy bonk", reason: "refuse:unoffered_asset", fallback: FALLBACK });
    expect(out).toEqual({ text: FALLBACK, tokens: 0, used: false });
  });

  it("lets numbers through only when the facts or the rule contain them", () => {
    expect(declineIsSafe("Liquidation is at 1.10, so I keep you above it.", ["liquidation is at health factor 1.10"])).toBe(true);
    expect(declineIsSafe("You'd earn 12.5% on it.", ["no figures here"])).toBe(false);
  });
});
