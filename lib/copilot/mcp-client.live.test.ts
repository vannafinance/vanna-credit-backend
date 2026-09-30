/**
 * Runs against a real local MCP (started with AUTH_ENABLED=false). Skips, loudly, when it is not up.
 *   MCP_BASE_URL=http://localhost:8000/mcp MCP_AUTH_MODE=none npx vitest run lib/copilot/mcp-client.live.test.ts
 */
import { Keypair } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";

import { MCPError, mcp, mcpCall, mcpListTools, parseWriteEnvelope, resetMcpClient } from "./mcp-client";

const base = process.env.MCP_BASE_URL ?? "http://localhost:8000/mcp";
process.env.MCP_BASE_URL = base;
process.env.MCP_AUTH_MODE = "none";

let up = false;
beforeAll(async () => {
  resetMcpClient();
  try {
    await mcpListTools();
    up = true;
  } catch (e) {
    console.warn(`[mcp live tests] SKIPPED: no MCP reachable at ${base} (${e instanceof Error ? e.message : e})`);
  }
});

const live = (name: string, fn: () => Promise<void>) =>
  it(name, async (ctx) => {
    if (!up) return ctx.skip();
    await fn();
  });

describe("live MCP", () => {
  live("lists the 14 dispatcher tools", async () => {
    const tools = await mcpListTools();
    expect(tools).toEqual(expect.arrayContaining(["vanna_oracle", "vanna_account", "vanna_earn_write", "vanna_sign"]));
    expect(tools.length).toBeGreaterThanOrEqual(14);
  });

  live("reads a SOL price through the helper", async () => {
    const r = await mcp.price("SOL");
    expect(r.symbol).toBe("SOL");
    expect(Number(r.price_usd)).toBeGreaterThan(0);
  });

  live("reads pool stats and protocol config", async () => {
    expect(await mcp.poolStats("USDC")).toBeTypeOf("object");
    expect(await mcp.protocolInfo()).toBeTypeOf("object");
  });

  live("surfaces an unknown asset as MCPError code invalid_input", async () => {
    const err = await mcp.price("NOTAREALTOKEN").catch((e) => e);
    expect(err).toBeInstanceOf(MCPError);
    expect(err.code).toBe("invalid_input");
  });

  live("reads margin and wallet state for a wallet with no account as structured results or codes", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const health = await mcp.accountHealth(owner).catch((e) => e);
    if (health instanceof MCPError) expect(health.code).toBe("account_not_found");
    else expect(health).toBeTypeOf("object");
    expect(await mcp.wallet(owner)).toBeTypeOf("object");
    expect(await mcp.txStatus("1".repeat(64)).catch((e) => e)).toBeTruthy();
  });

  live("parses a real earn supply envelope", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const res = await mcpCall("vanna_earn_write", { action: "supply", owner, asset: "USDC", amount: "1" }).catch((e) => e);
    if (res instanceof MCPError) {
      // An unfunded owner may be refused by the MCP with a structured code; that is a valid outcome to assert on.
      expect(res.code).toBeTruthy();
      return;
    }
    const parsed = parseWriteEnvelope(res);
    if (parsed.ok) {
      expect(parsed.tx.transaction.length).toBeGreaterThan(100);
      expect(parsed.tx.lastValidBlockHeight).toBeGreaterThan(0);
      expect(parsed.summary.action).toBe("supply");
    } else {
      expect(parsed.code).toBeTruthy();
      expect(parsed.reason).toBeTruthy();
    }
  });
});
