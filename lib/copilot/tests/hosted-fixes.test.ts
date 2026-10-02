import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
