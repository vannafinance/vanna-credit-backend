import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MCPError, mcp, mcpCall, mcpTiming, parseWriteEnvelope, resetMcpClient } from "./mcp-client";
import type { CopilotUser } from "./types";

type Handler = (req: { url: string; headers: Record<string, string>; body: Record<string, unknown> }) => Response | Promise<Response>;

const sse = (payload: unknown, headers: Record<string, string> = {}) =>
  new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
const toolResult = (structured: unknown, isError = false) =>
  sse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError } });

/** A scripted MCP: handles the handshake itself and delegates tools/call to `onCall`. */
function fakeMcp(onCall: Handler) {
  const log: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  let sessions = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      if (String(url).includes("workos")) {
        log.push({ url, method: "token", headers });
        return new Response(JSON.stringify({ access_token: `tok-${log.length}`, expires_in: 300 }), { status: 200 });
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      log.push({ url, method: String(body.method), headers });
      if (body.method === "initialize") return sse({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": `sess-${++sessions}` });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return onCall({ url, headers, body });
    }),
  );
  return { log, sessions: () => sessions };
}

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
  mcpTiming.now = () => Date.now();
});

describe("handshake and result parsing", () => {
  it("initializes once, reuses the session, and parses structuredContent", async () => {
    const f = fakeMcp(() => toolResult({ symbol: "SOL", price_usd: "100" }));
    expect(await mcpCall("vanna_oracle", { action: "price", asset: "SOL" })).toEqual({ symbol: "SOL", price_usd: "100" });
    await mcpCall("vanna_oracle", { action: "price", asset: "SOL" });
    expect(f.sessions()).toBe(1);
    expect(f.log.map((l) => l.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
    expect(f.log[2].headers["mcp-session-id"]).toBe("sess-1");
    expect(f.log[2].headers.authorization).toBeUndefined();
  });

  it("falls back to JSON text content when structuredContent is absent", async () => {
    fakeMcp(() => sse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"a":1}' }] } }));
    expect(await mcpCall("t", {})).toEqual({ a: 1 });
  });

  it("throws MCPError carrying the MCP's error code and message", async () => {
    fakeMcp(() => toolResult({ error: "invalid_input", message: "'NOPE' has no registered AssetConfig" }));
    await expect(mcpCall("vanna_oracle", { action: "price", asset: "NOPE" })).rejects.toMatchObject({
      name: "MCPError",
      code: "invalid_input",
      message: "'NOPE' has no registered AssetConfig",
    });
  });

  it("does not treat a write envelope's `error: null` as an error", async () => {
    fakeMcp(() => toolResult({ error: null, simulation_success: true }));
    await expect(mcpCall("vanna_earn_write", {})).resolves.toMatchObject({ simulation_success: true });
  });

  it("surfaces a JSON-RPC error", async () => {
    fakeMcp(() => sse({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } }));
    await expect(mcpCall("t", {})).rejects.toMatchObject({ code: "mcp_rpc_error" });
  });
});

describe("Cloud Run IAM (MCP_IAM_AUDIENCE)", () => {
  it("sends a Google ID token in X-Serverless-Authorization and mints it once", async () => {
    vi.stubEnv("MCP_IAM_AUDIENCE", "https://mcp.run.test/");
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
        seen.push({ url: String(url), headers });
        if (String(url).includes("metadata.google.internal")) return new Response("google-id-token", { status: 200 });
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.method === "initialize") return sse({ jsonrpc: "2.0", id: 1, result: {} }, { "mcp-session-id": "sess-1" });
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        return toolResult({ ok: true });
      }),
    );
    await mcpCall("vanna_oracle", { action: "price", asset: "SOL" });
    await mcpCall("vanna_oracle", { action: "price", asset: "SOL" });

    const metadata = seen.filter((s) => s.url.includes("metadata.google.internal"));
    expect(metadata).toHaveLength(1);
    expect(metadata[0].url).toContain("audience=" + encodeURIComponent("https://mcp.run.test"));
    expect(metadata[0].headers["metadata-flavor"]).toBe("Google");
    const mcpCalls = seen.filter((s) => !s.url.includes("metadata.google.internal"));
    expect(mcpCalls.every((c) => c.headers["x-serverless-authorization"] === "Bearer google-id-token")).toBe(true);
  });

  it("does not call the metadata server when MCP_IAM_AUDIENCE is unset", async () => {
    const f = fakeMcp(() => toolResult({ ok: true }));
    await mcpCall("vanna_oracle", { action: "price", asset: "SOL" });
    expect(f.log.every((l) => l.headers["x-serverless-authorization"] === undefined)).toBe(true);
  });
});

describe("resilience", () => {
  it("re-handshakes once on a 404 (session expired) and replays the call", async () => {
    let first = true;
    const f = fakeMcp(() => {
      if (first) {
        first = false;
        return new Response('{"error":{"message":"Session not found"}}', { status: 404 });
      }
      return toolResult({ ok: true });
    });
    expect(await mcpCall("t", {})).toEqual({ ok: true });
    expect(f.sessions()).toBe(2);
  });

  it("does not loop on repeated 404s", async () => {
    fakeMcp(() => new Response("gone", { status: 404 }));
    await expect(mcpCall("t", {})).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("retries 429 honoring Retry-After, at most twice", async () => {
    let calls = 0;
    fakeMcp(() => {
      calls++;
      return calls <= 2 ? new Response('{"error":"rate_limited"}', { status: 429, headers: { "retry-after": "2" } }) : toolResult({ ok: true });
    });
    expect(await mcpCall("t", {})).toEqual({ ok: true });
    expect(mcpTiming.sleep).toHaveBeenCalledTimes(2);
    expect(mcpTiming.sleep).toHaveBeenCalledWith(2000);

    resetMcpClient();
    calls = -100;
    fakeMcp(() => new Response('{"error":"rate_limited"}', { status: 429, headers: { "retry-after": "1" } }));
    const err = await mcpCall("t", {}).catch((e) => e);
    expect(err).toBeInstanceOf(MCPError);
    expect(err).toMatchObject({ code: "rate_limited", httpStatus: 429, retryable: true });
  });

  it("does not sleep through a long Retry-After", async () => {
    fakeMcp(() => new Response('{"error":"rate_limited"}', { status: 429, headers: { "retry-after": "60" } }));
    await expect(mcpCall("t", {})).rejects.toMatchObject({ httpStatus: 429 });
    expect(mcpTiming.sleep).not.toHaveBeenCalled();
  });

  it("retries 502/503 once", async () => {
    let calls = 0;
    fakeMcp(() => (++calls === 1 ? new Response("bad gateway", { status: 502 }) : toolResult({ ok: true })));
    expect(await mcpCall("t", {})).toEqual({ ok: true });
    expect(calls).toBe(2);

    resetMcpClient();
    calls = 0;
    fakeMcp(() => {
      calls++;
      return new Response("unavailable", { status: 503 });
    });
    await expect(mcpCall("t", {})).rejects.toMatchObject({ httpStatus: 503, retryable: true });
    expect(calls).toBe(2);
  });

  it("reports an unreachable server as a retryable MCPError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(mcpCall("t", {})).rejects.toMatchObject({ code: "mcp_unreachable", retryable: true });
  });
});

describe("identity headers", () => {
  const user: CopilotUser = { wallet: "So11111111111111111111111111111111111111112", subject: "s", expiresAt: 1 };

  it("sends the wallet assertion and request id on calls, not on the handshake", async () => {
    const f = fakeMcp(() => toolResult({}));
    await mcpCall("t", {}, { user, requestId: "req-1" });
    const init = f.log.find((l) => l.method === "initialize")!;
    const call = f.log.find((l) => l.method === "tools/call")!;
    expect(init.headers["x-vanna-user-assertion"]).toBeUndefined();
    expect(call.headers["x-vanna-user-assertion"]).toBe(`wallet:${user.wallet}`);
    expect(call.headers["x-request-id"]).toBe("req-1");
  });

  it("omits the assertion when nobody is signed in", async () => {
    const f = fakeMcp(() => toolResult({}));
    await mcpCall("t", {});
    expect(f.log.find((l) => l.method === "tools/call")!.headers["x-vanna-user-assertion"]).toBeUndefined();
  });
});

describe("WorkOS M2M bearer", () => {
  beforeEach(() => {
    vi.stubEnv("MCP_AUTH_MODE", "workos");
    vi.stubEnv("WORKOS_M2M_CLIENT_ID", "client_1");
    vi.stubEnv("WORKOS_M2M_CLIENT_SECRET", "secret_1");
    vi.stubEnv("WORKOS_M2M_TOKEN_URL", "https://workos.test/oauth2/token");
  });

  it("fetches one token for concurrent calls, sends it as bearer, and keeps a session per bearer", async () => {
    const f = fakeMcp(() => toolResult({}));
    await Promise.all([mcpCall("a", {}), mcpCall("b", {}), mcpCall("c", {})]);
    expect(f.log.filter((l) => l.url.includes("workos"))).toHaveLength(1);
    expect(f.log.filter((l) => l.method === "tools/call").every((l) => l.headers.authorization?.startsWith("Bearer tok-"))).toBe(true);
    expect(f.sessions()).toBe(1);
  });

  it("refreshes before expiry and opens a new session under the new bearer", async () => {
    const f = fakeMcp(() => toolResult({}));
    let now = 1_000_000;
    mcpTiming.now = () => now;
    await mcpCall("a", {});
    now += 241_000; // 300s lifetime minus the 60s safety margin has passed
    await mcpCall("a", {});
    expect(f.log.filter((l) => l.url.includes("workos"))).toHaveLength(2);
    expect(f.sessions()).toBe(2);
  });

  it("refuses to call without M2M credentials instead of going unauthenticated", async () => {
    vi.stubEnv("WORKOS_M2M_CLIENT_SECRET", "");
    fakeMcp(() => toolResult({}));
    await expect(mcpCall("a", {})).rejects.toMatchObject({ code: "mcp_auth_not_configured" });
  });

  it("drops the token and session after a 401 so the next call starts clean", async () => {
    let n = 0;
    const f = fakeMcp(() => (++n === 1 ? new Response('{"error":"unauthorized","detail":"Token has expired"}', { status: 401 }) : toolResult({})));
    await expect(mcpCall("a", {})).rejects.toMatchObject({ httpStatus: 401, code: "unauthorized" });
    await mcpCall("a", {});
    expect(f.log.filter((l) => l.url.includes("workos"))).toHaveLength(2);
  });

  it("never honours MCP_AUTH_MODE=none in production", async () => {
    vi.stubEnv("MCP_AUTH_MODE", "none");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WORKOS_M2M_CLIENT_SECRET", "");
    fakeMcp(() => toolResult({}));
    await expect(mcpCall("a", {})).rejects.toMatchObject({ code: "mcp_auth_not_configured" });
  });
});

describe("typed helpers send the real dispatcher arguments", () => {
  it("maps each helper to its dispatcher, action and argument names", async () => {
    const seen: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    fakeMcp(({ body }) => {
      seen.push((body.params as { name: string; arguments: Record<string, unknown> }));
      return toolResult({});
    });
    await mcp.protocolInfo();
    await mcp.price("SOL");
    await mcp.prices(["SOL", "USDC"]);
    await mcp.poolStats("USDC");
    await mcp.accountHealth("W");
    await mcp.marginCollateral("W");
    await mcp.wallet("W");
    await mcp.earnPosition("W", "USDC");
    await mcp.farmMarkets();
    await mcp.swapQuote({ from_asset: "SOL", to_asset: "USDC", amount: "1" });
    await mcp.canBorrow({ authority: "W", asset: "USDC", amount: "5" });
    await mcp.canWithdraw({ authority: "W", asset: "SOL", amount: "1" });
    await mcp.txStatus("SIG");
    expect(seen).toEqual([
      { name: "vanna_protocol_info", arguments: { action: "config" } },
      { name: "vanna_oracle", arguments: { action: "price", asset: "SOL" } },
      { name: "vanna_oracle", arguments: { action: "prices", assets: ["SOL", "USDC"] } },
      { name: "vanna_earn_market", arguments: { action: "pool_stats", asset: "USDC" } },
      { name: "vanna_account", arguments: { action: "health", authority: "W" } },
      { name: "vanna_margin_status", arguments: { action: "collateral", authority: "W" } },
      { name: "vanna_wallet", arguments: { action: "summary", authority: "W" } },
      { name: "vanna_earn_position", arguments: { action: "deposited_balance", owner: "W", asset: "USDC" } },
      { name: "vanna_farm_overview", arguments: { action: "markets" } },
      { name: "vanna_swap", arguments: { action: "quote", from_asset: "SOL", to_asset: "USDC", amount: "1" } },
      { name: "vanna_margin_status", arguments: { action: "can_borrow", authority: "W", asset: "USDC", amount: "5" } },
      { name: "vanna_margin_status", arguments: { action: "can_withdraw", authority: "W", asset: "SOL", amount: "1" } },
      { name: "vanna_sign", arguments: { action: "tx_status", signature: "SIG" } },
    ]);
  });
});

describe("parseWriteEnvelope", () => {
  const good = () => ({
    schemaVersion: "1",
    transactions: [
      {
        id: "action",
        unsignedTransaction: "AQAB",
        blockhash: "BH",
        lastValidBlockHeight: "225773",
        simulation: { status: "success", err: null },
      },
    ],
    summary: { action: "supply", asset: "USDC", amount: "1" },
    preview: { healthFactorAfter: "1.3" },
    error: null,
    code: null,
    reason: null,
    simulation_success: true,
  });

  it("reads the first transaction and converts lastValidBlockHeight from a string", () => {
    const r = parseWriteEnvelope(good());
    expect(r).toMatchObject({
      ok: true,
      tx: { transaction: "AQAB", blockhash: "BH", lastValidBlockHeight: 225773, simulation_success: true },
      summary: { action: "supply" },
      preview: { healthFactorAfter: "1.3" },
    });
  });

  it("returns a null preview when the MCP gives none", () => {
    const e = { ...good(), preview: null };
    expect(parseWriteEnvelope(e)).toMatchObject({ ok: true, preview: null });
  });

  it("refuses a failed simulation with the MCP's code and reason", () => {
    expect(parseWriteEnvelope({ ...good(), simulation_success: false, code: "simulation_failed", reason: "custom program error: 0x1" })).toEqual({
      ok: false,
      code: "simulation_failed",
      reason: "custom program error: 0x1",
    });
  });

  it("refuses a structured tool error shape", () => {
    expect(parseWriteEnvelope({ error: "asset_not_offered", message: "JUPSOL cannot be borrowed" })).toEqual({
      ok: false,
      code: "asset_not_offered",
      reason: "JUPSOL cannot be borrowed",
    });
  });

  it("refuses multi-transaction (setup dependency) and empty envelopes", () => {
    const g = good();
    expect(parseWriteEnvelope({ ...g, transactions: [g.transactions[0], g.transactions[0]] })).toMatchObject({ ok: false, code: "multi_transaction_envelope" });
    expect(parseWriteEnvelope({ ...g, transactions: [] })).toMatchObject({ ok: false, code: "no_transaction" });
  });

  it("refuses a transaction with no message, bad expiry, or unsimulated status", () => {
    const g = good();
    const withTx = (patch: Record<string, unknown>) => ({ ...g, transactions: [{ ...g.transactions[0], ...patch }] });
    expect(parseWriteEnvelope(withTx({ unsignedTransaction: null }))).toMatchObject({ ok: false, code: "malformed_envelope" });
    expect(parseWriteEnvelope(withTx({ lastValidBlockHeight: "abc" }))).toMatchObject({ ok: false, code: "malformed_envelope" });
    expect(parseWriteEnvelope(withTx({ simulation: { status: "not_run_dependency", err: null } }))).toMatchObject({ ok: false, code: "simulation_failed" });
  });
});
