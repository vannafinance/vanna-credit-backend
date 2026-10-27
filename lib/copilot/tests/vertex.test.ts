import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("explicit prompt cache failure", () => {
  it("a cached call that never returns is repeated with the prompt in full, and the cache is not used again", async () => {
    // 26 Oct, live: gemini-3.8-flash created a cache and the first call that read it hung until the investigation's own
    // deadline, so the keyword router answered. A cached call is time-boxed and repeated in full instead.
    const { VertexClient } = await import("../vertex");
    vi.stubEnv("COPILOT_CACHED_CALL_TIMEOUT_MS", "40");
    const seen: Array<{ cached: boolean }> = [];
    const fake = {
      caches: { create: async () => ({ name: "cachedContents/test", expireTime: new Date(Date.now() + 600_000).toISOString() }) },
      models: {
        generateContent: (arg: { config: { cachedContent?: string; abortSignal?: AbortSignal } }) => {
          const cached = !!arg.config.cachedContent;
          const warmup = JSON.stringify((arg as unknown as { contents: unknown }).contents).includes("Reply with OK.");
          if (warmup) return Promise.resolve({ text: "OK" }); // the background call that reads a new cache first
          seen.push({ cached });
          if (!cached) return Promise.resolve({ text: "ok", usageMetadata: { totalTokenCount: 5 } });
          return new Promise((_, reject) => arg.config.abortSignal?.addEventListener("abort", () => reject(new Error("This operation was aborted"))));
        },
      },
    };
    const client = new VertexClient("p", "global", fake as never);
    const req = { system: "s", user: "u", tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }], cachePrefix: true } as never;
    await client.generate(req); // no cache yet: sent in full while one is created in the background
    await new Promise((r) => setTimeout(r, 60));
    const second = await client.generate(req); // reads the cache, which hangs, then repeats in full
    expect(second.text).toBe("ok");
    expect(seen.map((s) => s.cached)).toEqual([false, true, false]);
    await client.generate(req); // the failed cache is not tried again
    expect(seen.map((s) => s.cached)).toEqual([false, true, false, false]);
    vi.unstubAllEnvs();
  });
});

describe("model lanes and failover", () => {
  afterEach(() => vi.unstubAllEnvs());
  const ok = (text = "ok") => ({ text, usageMetadata: { totalTokenCount: 5 } });
  const req = { system: "s", user: "u" } as never;
  const setup = (handler: (model: string, signal?: AbortSignal) => Promise<unknown>) => {
    const models: string[] = [];
    const fake = { models: { generateContent: (arg: { model: string; config: { abortSignal?: AbortSignal } }) => { models.push(arg.model); return handler(arg.model, arg.config.abortSignal); } } };
    return { models, build: async () => new (await import("../vertex")).VertexClient("p", "global", fake as never) };
  };
  const hangs = (signal?: AbortSignal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("This operation was aborted"))));
  const env = () => { vi.stubEnv("VERTEX_MODEL", "primary"); vi.stubEnv("VERTEX_COMPOSE_MODEL", "composer"); vi.stubEnv("VERTEX_FALLBACK_MODEL", "backup"); vi.stubEnv("COPILOT_MODEL_SLOW_MS", "40"); vi.stubEnv("COPILOT_MODEL_BREAKER_MS", "60000"); };

  it("research goes to the research model and wording to the compose model", async () => {
    env();
    const { models, build } = setup(async () => ok());
    const client = await build();
    await client.generate(req);
    await client.generate({ ...(req as object), lane: "compose" } as never);
    expect(models).toEqual(["primary", "composer"]);
  });

  it("a slow primary call is answered from the fallback, and the primary is left alone afterwards", async () => {
    env();
    const { models, build } = setup((model, signal) => (model === "primary" ? hangs(signal) : Promise.resolve(ok("from backup"))));
    const client = await build();
    expect((await client.generate(req)).text).toBe("from backup");
    expect((await client.generate(req)).text).toBe("from backup");
    expect(models).toEqual(["primary", "backup", "backup"]); // the second call never touched the primary
  });

  it("an overloaded primary (429 / 503) fails over at once", async () => {
    env();
    const { models, build } = setup((model) => (model === "primary" ? Promise.reject(Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 })) : Promise.resolve(ok())));
    const client = await build();
    await client.generate(req);
    expect(models).toEqual(["primary", "backup"]);
  });

  it("a cached call that runs out of time moves to the fallback at once, instead of repeating the call on the slow model", async () => {
    env();
    vi.stubEnv("COPILOT_CACHED_CALL_TIMEOUT_MS", "40");
    vi.stubEnv("COPILOT_MODEL_SLOW_MS", "60000"); // only the cache limit may end the call, not the general slow limit
    const seen: string[] = [];
    let primaryCalls = 0;
    const fake = {
      caches: { create: async () => ({ name: "cachedContents/t", expireTime: new Date(Date.now() + 600_000).toISOString() }) },
      models: {
        generateContent: (arg: { model: string; contents: unknown; config: { cachedContent?: string; abortSignal?: AbortSignal } }) => {
          if (JSON.stringify(arg.contents).includes("Reply with OK.")) return Promise.resolve({ text: "OK" }); // the warm-up that reads a new cache
          seen.push(`${arg.model}${arg.config.cachedContent ? ":cached" : ""}`);
          if (arg.model === "primary") {
            primaryCalls++;
            if (arg.config.cachedContent) return new Promise((_, reject) => arg.config.abortSignal?.addEventListener("abort", () => reject(new Error("This operation was aborted"))));
          }
          return Promise.resolve({ text: arg.model === "primary" ? "from primary" : "from backup", usageMetadata: { totalTokenCount: 5 } });
        },
      },
    };
    const client = new (await import("../vertex")).VertexClient("p", "global", fake as never);
    const withTools = { system: "s", user: "u", tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }], cachePrefix: true } as never;
    expect((await client.generate(withTools)).text).toBe("from primary"); // no cache yet: sent in full while one is created
    await new Promise((r) => setTimeout(r, 60));
    expect((await client.generate(withTools)).text).toBe("from backup"); // reads the cache, which hangs: the fallback answers, no repeat on the primary
    expect(seen).toEqual(["primary", "primary:cached", "backup"]);
    expect(primaryCalls).toBe(2);
  });

  it("a cache that failed to create is tried again after a minute, not left off for ten", async () => {
    env();
    const base = Date.now();
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => base + offset);
    let creates = 0;
    const seen: string[] = [];
    const fake = {
      caches: { create: async () => { creates++; if (creates === 1) throw new Error("This operation was aborted"); return { name: "cachedContents/t", expireTime: new Date(base + 600_000).toISOString() }; } },
      models: { generateContent: (arg: { config: { cachedContent?: string }; contents: unknown }) => { if (!JSON.stringify(arg.contents).includes("Reply with OK.")) seen.push(arg.config.cachedContent ? "cached" : "full"); return Promise.resolve({ text: "ok", usageMetadata: { totalTokenCount: 5 } }); } },
    };
    const client = new (await import("../vertex")).VertexClient("p", "global", fake as never);
    const withTools = { system: "s", user: "u", tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }], cachePrefix: true } as never;
    const tick = () => new Promise((r) => setTimeout(r, 20));
    await client.generate(withTools); await tick();
    expect(creates).toBe(1);
    offset = 30_000; await client.generate(withTools); await tick();
    expect(creates).toBe(1); // too soon: no second attempt yet
    offset = 61_000; await client.generate(withTools); await tick();
    expect(creates).toBe(2); // a minute on: tried again
    await client.generate(withTools);
    expect(seen).toEqual(["full", "full", "full", "cached"]);
    vi.restoreAllMocks();
  });

  it("a bad request is an error, not a reason to switch models", async () => {
    env();
    const { models, build } = setup(() => Promise.reject(Object.assign(new Error("invalid argument"), { status: 400 })));
    const client = await build();
    await expect(client.generate(req)).rejects.toThrow("invalid argument");
    expect(models).toEqual(["primary"]);
  });

  it("the caller cancelling is never taken for a slow model", async () => {
    env();
    const { models, build } = setup((_m, signal) => hangs(signal));
    const client = await build();
    const controller = new AbortController();
    const pending = client.generate({ ...(req as object), signal: controller.signal } as never);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(models).toEqual(["primary"]);
  });

  it("no failover when the fallback is the same model or unset", async () => {
    env();
    vi.stubEnv("VERTEX_FALLBACK_MODEL", "primary");
    const { models, build } = setup(() => Promise.reject(Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 })));
    const client = await build();
    await expect(client.generate(req)).rejects.toThrow();
    expect(models).toEqual(["primary"]);
  });
});
