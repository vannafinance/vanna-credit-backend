import { afterEach, describe, expect, it } from "vitest";
import { LlmUnavailable, getLlm, intentFromCall, llmConfigured, numbersGrounded, routeWithModel, setLlmClient, wordAnswer, ROUTER_TOOLS } from "../vertex";
import type { StructuredAnswer } from "../answer-schema";

afterEach(() => setLlmClient(null));

const answer: StructuredAnswer = {
  headline: "Your health factor is 3.00 on your margin account.",
  facts: [
    { label: "health factor", value: "3.00" },
    { label: "collateral", value: "$600.00" },
    { label: "debt", value: "$200.00" },
  ],
  venue: "margin",
};
const data = { health: { health_factor: "3.0", total_collateral_usd: "600.00", total_debt_usd: "200.00" } };

describe("number grounding", () => {
  it("accepts numbers that appear in the data at the precision they are written", () => {
    expect(numbersGrounded("Health factor 3.00, collateral $600.00, debt $200.00.", [JSON.stringify(data)])).toBe(true);
    expect(numbersGrounded("About $1,146.03 of collateral.", ['{"usd":"1146.0312"}'])).toBe(true);
    expect(numbersGrounded("A supply rate of 6.74%.", ['{"supply_apy_fraction":"0.0674186"}'])).toBe(true);
  });
  it("rejects any number the data does not contain", () => {
    expect(numbersGrounded("Your health factor is 4.25.", [JSON.stringify(data)])).toBe(false);
    expect(numbersGrounded("You hold $601.00.", [JSON.stringify(data)])).toBe(false);
    expect(numbersGrounded("Collateral is 12,345 dollars.", [JSON.stringify(data)])).toBe(false);
  });
  it("lets the protocol constants and small counts through", () => {
    expect(numbersGrounded("Liquidation is at 1.10 and you hold 3 assets.", ["{}"])).toBe(true);
  });
});

describe("model client seam", () => {
  it("the real Vertex path refuses cleanly when no project is configured (no silent fallback to made-up output)", () => {
    const saved = { g: process.env.GOOGLE_CLOUD_PROJECT, c: process.env.GCLOUD_PROJECT };
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GCLOUD_PROJECT;
    try {
      expect(llmConfigured()).toBe(false);
      expect(() => getLlm()).toThrow(LlmUnavailable);
    } finally {
      if (saved.g !== undefined) process.env.GOOGLE_CLOUD_PROJECT = saved.g;
      if (saved.c !== undefined) process.env.GCLOUD_PROJECT = saved.c;
    }
  });

  it("an injected client is used as-is", async () => {
    setLlmClient({ generate: async () => ({ text: "ok", calls: [], tokens: 1 }) });
    expect(llmConfigured()).toBe(true);
    expect((await getLlm().generate({ system: "s", user: "u" })).text).toBe("ok");
  });
});

describe("routing request", () => {
  it("forces a function call, offers only the declared tools, and restates the domain rules", async () => {
    let seen: Parameters<ReturnType<typeof getLlm>["generate"]>[0] | null = null;
    setLlmClient({
      generate: async (req) => {
        seen = req;
        return { text: null, calls: [{ name: "read_question", args: { kind: "price", assets: ["SOL"] } }], tokens: 42 };
      },
    });
    const r = await routeWithModel("what is sol at", [{ role: "user", text: "hi" }]);
    expect(r.tokens).toBe(42);
    expect(r.intent.lane === "read" && r.intent.read.kind).toBe("price");
    expect(seen!.forceTool).toBe(true);
    expect(seen!.tools?.map((t) => t.name)).toEqual(ROUTER_TOOLS.map((t) => t.name));
    expect(seen!.system).toMatch(/only handle Vanna Finance on Solana/);
    expect(seen!.history).toHaveLength(1);
  });

  it("the tool menu has no liquidation, admin, transfer or faucet tool to call", () => {
    const names = JSON.stringify(ROUTER_TOOLS).toLowerCase();
    for (const banned of ["liquidat", "admin", "faucet", "transfer", "arbitrary"]) expect(names.includes(`"name":"${banned}`)).toBe(false);
    const ops = JSON.stringify(ROUTER_TOOLS.find((t) => t.name === "write_action"));
    expect(ops).not.toMatch(/liquidate|admin|faucet/);
  });

  it("a response without a call is unknown, not a guess", async () => {
    setLlmClient({ generate: async () => ({ text: "sure, borrowing 500", calls: [], tokens: 5 }) });
    expect((await routeWithModel("x", [])).intent.lane).toBe("unknown");
  });

  it("lever calls are guarded", () => {
    expect(intentFromCall("lever_position", { asset: "SOL", leverage: 2 }).lane).toBe("lever");
    expect(intentFromCall("lever_position", { asset: "SOL", leverage: 50 }).lane).toBe("refuse");
    expect(intentFromCall("lever_position", { asset: "BONK", leverage: 2 }).lane).toBe("unknown");
  });
});

describe("wording", () => {
  it("returns the original answer untouched when no model is configured", async () => {
    const saved = process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    try {
      const r = await wordAnswer({ question: "hf?", answer, data });
      expect(r.used).toBe(false);
      expect(r.answer).toBe(answer);
    } finally {
      if (saved !== undefined) process.env.GOOGLE_CLOUD_PROJECT = saved;
    }
  });

  it("keeps the code-built facts and any warning note, only the headline changes", async () => {
    setLlmClient({ generate: async () => ({ text: JSON.stringify({ headline: "You are comfortably healthy at 3.00.", note: "Nothing to worry about." }), calls: [], tokens: 7 }) });
    const withNote = { ...answer, note: "At least one price is stale." };
    const r = await wordAnswer({ question: "hf?", answer: withNote, data });
    expect(r.used).toBe(true);
    expect(r.answer.headline).toBe("You are comfortably healthy at 3.00.");
    expect(r.answer.note).toBe("At least one price is stale.");
    expect(r.answer.facts).toEqual(answer.facts);
  });

  it("rejects a headline with an ungrounded number but still reports the tokens spent", async () => {
    setLlmClient({ generate: async () => ({ text: JSON.stringify({ headline: "Health factor 7.77." }), calls: [], tokens: 9 }) });
    const r = await wordAnswer({ question: "hf?", answer, data });
    expect(r.used).toBe(false);
    expect(r.tokens).toBe(9);
    expect(r.answer.headline).toBe(answer.headline);
  });
});
