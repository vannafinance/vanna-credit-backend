import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateFirewall } from "../domain-firewall";
import { humanizeFailure } from "../explain";
import { mcpCall, mcpTiming, resetMcpClient } from "../mcp-client";
import { labelFor, type StepSpec } from "../plan";
import { keywordRoute } from "../router";

describe("raw program errors never reach the user", () => {
  it("maps Anchor 3005 / AccountNotEnoughKeys to the stale-pool sentence", () => {
    expect(humanizeFailure("TransactionErrorInstructionError((6, Tagged(Custom(InstructionErrorCustom(3005)))))")).toMatch(/pool data looks out of date/);
    expect(humanizeFailure("AccountNotEnoughKeys")).toMatch(/pool data looks out of date/);
  });

  it("replaces any other raw runtime error with a plain sentence", () => {
    const out = humanizeFailure("TransactionErrorInstructionError((2, Custom(9999)))");
    expect(out).toMatch(/network rejected this step/);
    expect(out).not.toMatch(/InstructionError|Custom\(/);
  });

  it("leaves ordinary sentences alone", () => {
    expect(humanizeFailure("Something specific and readable")).toBe("Something specific and readable");
  });
});

describe("Kamino redeem names receipt tokens, not the underlying", () => {
  const step = (amount: string | null): StepSpec => ({ kind: "write", op: "farm_redeem", asset: "SOL", amount, slots: {} }) as unknown as StepSpec;

  it("a resolved receipt amount is shown as kSOL", () => {
    expect(labelFor(step("86.616454"))).toBe("Redeem 86.616454 kSOL from Kamino (farm) back to margin");
  });

  it("'all' reads as all your kSOL", () => {
    expect(labelFor(step("all"))).toBe("Redeem all your kSOL from Kamino (farm) back to margin");
  });

  it("never prints the receipt amount as SOL", () => {
    expect(labelFor(step("86.616454"))).not.toMatch(/86\.616454 SOL/);
  });
});

describe("the domain firewall lets exit requests through", () => {
  it.each(["close everything", "please close everything", "exit all", "unwind my positions", "can you close out everything?", "deleverage me"])("%s", (m) => {
    expect(evaluateFirewall(m).allow).toBe(true);
  });

  it("still blocks unrelated chat", () => {
    for (const m of ["close the door", "what is the weather", "exit vim"]) expect(evaluateFirewall(m).allow).toBe(false);
  });
});

describe("a price question about a coin outside the product", () => {
  it.each([
    ["what is the price of Bitcoin?", "Bitcoin"],
    ["price of dogecoin", "Dogecoin"],
    ["eth price", "ETH"],
  ])("%s is refused naming the coin", (p, coin) => {
    const r = keywordRoute(p);
    expect(r.lane).toBe("refuse");
    if (r.lane === "refuse") expect(r.message).toContain(`${coin} is not part of the Vanna Copilot product`);
  });

  it("product prices are unaffected", () => {
    expect(keywordRoute("price of SOL").lane).toBe("read");
    expect(keywordRoute("what's the price of jupsol").lane).toBe("read");
    expect(keywordRoute("prices").lane).toBe("read");
  });
});

describe("swapping an asset for itself", () => {
  it("is refused with a clear sentence, not a generic question", () => {
    const r = keywordRoute("swap 5 SOL to SOL");
    expect(r.lane).toBe("refuse");
    if (r.lane === "refuse") expect(r.message).toMatch(/two different assets/);
  });

  it("a swap that names no target still asks", () => {
    expect(keywordRoute("swap SOL").lane).toBe("ask");
  });

  it("a normal swap is unaffected", () => {
    const r = keywordRoute("swap 0.1 SOL to USDC");
    expect(r.lane).toBe("write");
  });
});

describe("'deposit X and borrow Y with Nx leverage' is one leverage request", () => {
  const lever = (p: string) => {
    const r = keywordRoute(p);
    expect(r.lane).toBe("lever");
    return (r as Extract<typeof r, { lane: "lever" }>).lever;
  };

  it("the reported sentence becomes lever 1 JupSOL 3x borrowing USDC", () => {
    expect(lever("can you deposit 1 jupSOL and borrow USDC again with 3x leverage?")).toMatchObject({ asset: "JupSOL", leverage: 3, borrow_asset: "USDC", amount: "1" });
  });

  it("works for SOL and 2x", () => {
    expect(lever("deposit 1 SOL and borrow USDC with 2x leverage")).toMatchObject({ asset: "SOL", leverage: 2, borrow_asset: "USDC", amount: "1" });
  });

  it("carries a stated health floor", () => {
    expect(lever("deposit 2 SOL and lever 2x borrowing USDT keeping health factor above 1.4")).toMatchObject({ asset: "SOL", borrow_asset: "USDT", amount: "2", min_hf: 1.4 });
  });

  it("levers the collateral, not the stable being borrowed", () => {
    expect(lever("borrow USDC with 3x leverage against my jupSOL")).toMatchObject({ asset: "JupSOL", leverage: 3, borrow_asset: "USDC" });
  });

  it("a plain lever request is unchanged", () => {
    expect(lever("lever 1 jupSOL 3x borrowing USDC")).toMatchObject({ asset: "JupSOL", leverage: 3, borrow_asset: "USDC", amount: "1" });
  });

  it("leverage mixed with other real steps is still refused as its own request", () => {
    const r = keywordRoute("deposit 1 SOL then supply 5 USDC and lever 2x");
    expect(r.lane).toBe("ask");
  });

  it("a deposit-and-borrow chain without leverage is unaffected", () => {
    const r = keywordRoute("deposit 1 SOL as collateral and borrow 20 USDC");
    expect(r.lane).toBe("chain");
  });
});

describe("a timeout while reading the MCP answer is retried, not shown as a raw abort", () => {
  beforeEach(() => {
    resetMcpClient();
    vi.stubEnv("MCP_AUTH_MODE", "none");
    vi.stubEnv("MCP_BASE_URL", "http://mcp.test/mcp");
    mcpTiming.sleep = vi.fn(async () => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mcpTiming.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  });

  const sse = (payload: unknown, headers: Record<string, string> = {}) =>
    new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });

  it("retries once and returns the answer", async () => {
    let toolCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.method === "initialize") return sse({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "s1" });
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        toolCalls++;
        if (toolCalls === 1) {
          const slow = new Response("x", { status: 200, headers: { "content-type": "text/event-stream" } });
          slow.text = async () => {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          };
          return slow;
        }
        const payload = { price_usd: "120" };
        return sse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload } });
      }),
    );
    await expect(mcpCall("vanna_oracle", { action: "price", asset: "SOL" })).resolves.toEqual({ price_usd: "120" });
    expect(toolCalls).toBe(2);
  });

  it("a fresh instance's first WorkOS call failing ('fetch failed') is retried, not shown to the user", async () => {
    vi.stubEnv("MCP_AUTH_MODE", "workos");
    vi.stubEnv("WORKOS_M2M_CLIENT_ID", "client_x");
    vi.stubEnv("WORKOS_M2M_CLIENT_SECRET", "secret_x");
    vi.stubEnv("WORKOS_M2M_TOKEN_URL", "https://auth.test/oauth2/token");
    let tokenCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (String(url).includes("auth.test")) {
          tokenCalls++;
          if (tokenCalls < 3) throw new TypeError("fetch failed");
          return new Response(JSON.stringify({ access_token: "tok", expires_in: 300 }), { status: 200 });
        }
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.method === "initialize") return sse({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "s1" });
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const payload = { ok: true };
        return sse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload } });
      }),
    );
    await expect(mcpCall("vanna_oracle", { action: "price", asset: "SOL" })).resolves.toEqual({ ok: true });
    expect(tokenCalls).toBe(3);
  });

  it("a WorkOS endpoint that stays unreachable still reports a typed error", async () => {
    vi.stubEnv("MCP_AUTH_MODE", "workos");
    vi.stubEnv("WORKOS_M2M_CLIENT_ID", "client_x");
    vi.stubEnv("WORKOS_M2M_CLIENT_SECRET", "secret_x");
    vi.stubEnv("WORKOS_M2M_TOKEN_URL", "https://auth.test/oauth2/token");
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(mcpCall("vanna_oracle", { action: "price", asset: "SOL" })).rejects.toMatchObject({ code: "mcp_auth_unreachable", retryable: true });
  });

  it("a second timeout surfaces as a typed MCPError, not a raw DOMException", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.method === "initialize") return sse({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "s1" });
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const slow = new Response("x", { status: 200 });
        slow.text = async () => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        };
        return slow;
      }),
    );
    await expect(mcpCall("vanna_oracle", { action: "price", asset: "SOL" })).rejects.toMatchObject({ name: "MCPError", code: "mcp_timeout" });
  });
});
