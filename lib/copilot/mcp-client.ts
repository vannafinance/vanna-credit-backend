/**
 * Client for the Vanna Solana MCP server (14 dispatcher tools, each taking `{ action, ...args }`).
 *
 * Auth: the app holds one WorkOS M2M credential (client_credentials) and sends it as the bearer on
 * every call. WHO the call is for travels beside it as `X-Vanna-User-Assertion`; the MCP treats that
 * header as an unverified identity hint for per-caller rate limits and never as authorization, because
 * on Solana the user's wallet signature is the only thing that can move funds.
 * `MCP_AUTH_MODE=none` skips the bearer for a local MCP started with AUTH_ENABLED=false.
 *
 * Transport: Streamable HTTP (POST, JSON or SSE `event: message` frames, `mcp-session-id`). Sessions are
 * cached per bearer token in a process-wide map.
 *
 * Nothing here invents data: a missing field stays missing, and MCP errors surface as MCPError.
 */

import { copilotConfig } from "./config";
import { debugMcp } from "./debug";
import type { CopilotUser, UnsignedTx } from "./types";

// ── errors ──────────────────────────────────────────────────────────────────

export class MCPError extends Error {
  readonly code: string | null;
  readonly httpStatus: number | null;
  readonly retryable: boolean;

  constructor(message: string, meta: { code?: string | null; httpStatus?: number | null; retryable?: boolean } = {}) {
    super(message);
    this.name = "MCPError";
    this.code = meta.code ?? null;
    this.httpStatus = meta.httpStatus ?? null;
    this.retryable = meta.retryable ?? false;
  }
}

export interface McpCtx {
  user?: CopilotUser;
  requestId?: string;
}

/** Test seam: waiting between retries and the WorkOS clock. */
export const mcpTiming = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const MAX_RETRY_AFTER_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_GATEWAY_RETRIES = 1;
const MAX_TIMEOUT_RETRIES = 1;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const TOKEN_FETCH_ATTEMPTS = 3;
const MAX_SESSIONS = 16;

// ── WorkOS M2M bearer (cached, refreshed before expiry, single-flight) ───────

interface CachedToken {
  token: string;
  expiresAt: number;
}
let cachedToken: CachedToken | null = null;
let tokenInFlight: Promise<string> | null = null;

async function mintToken(): Promise<string> {
  const { workosClientId, workosClientSecret, workosTokenUrl, mcpResource } = copilotConfig;
  if (!workosClientId || !workosClientSecret || !workosTokenUrl) {
    throw new MCPError(
      "MCP auth is not configured: set WORKOS_M2M_CLIENT_ID, WORKOS_M2M_CLIENT_SECRET and WORKOS_M2M_TOKEN_URL.",
      { code: "mcp_auth_not_configured" },
    );
  }
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: workosClientId,
    client_secret: workosClientSecret,
  });
  if (mcpResource) form.set("resource", mcpResource);
  let res: Response | null = null;
  let lastError: unknown = null;
  // A fresh instance's first outbound call can fail while its VPC egress and NAT come up ("fetch failed").
  // Minting a token has no side effect, so a couple of short retries turn that into a normal first answer.
  for (let attempt = 0; attempt < TOKEN_FETCH_ATTEMPTS; attempt++) {
    try {
      res = await fetch(workosTokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(copilotConfig.mcpTimeoutMs),
        cache: "no-store",
      });
      break;
    } catch (e) {
      lastError = e;
      if (attempt < TOKEN_FETCH_ATTEMPTS - 1) await mcpTiming.sleep(600 * (attempt + 1));
    }
  }
  if (!res) {
    throw new MCPError(`WorkOS token endpoint unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`, {
      code: "mcp_auth_unreachable",
      retryable: true,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MCPError(`WorkOS token endpoint returned ${res.status}: ${text.slice(0, 200)}`, {
      code: "mcp_auth_failed",
      httpStatus: res.status,
    });
  }
  const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!body?.access_token) throw new MCPError("WorkOS token response has no access_token", { code: "mcp_auth_failed" });
  // A token with no stated lifetime is treated as short-lived rather than guessed long.
  const ttlMs = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in * 1000 : 60_000;
  cachedToken = { token: body.access_token, expiresAt: mcpTiming.now() + Math.max(ttlMs - TOKEN_EXPIRY_MARGIN_MS, 0) };
  return body.access_token;
}

async function getBearer(): Promise<string | null> {
  if (copilotConfig.mcpAuthMode === "none") return null;
  if (cachedToken && mcpTiming.now() < cachedToken.expiresAt) return cachedToken.token;
  tokenInFlight ??= mintToken().finally(() => {
    tokenInFlight = null;
  });
  return tokenInFlight;
}

// ── sessions, keyed by bearer ───────────────────────────────────────────────

const sessions = new Map<string, string>();
const handshakes = new Map<string, Promise<string>>();
let rpcId = 100;

const sessionKey = (bearer: string | null) => `${copilotConfig.mcpBaseUrl}|${bearer ?? "none"}`;

function baseHeaders(bearer: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return headers;
}

// ── Google ID token for a Cloud Run MCP that requires IAM ────────────────────

interface CachedIdToken {
  token: string;
  audience: string;
  expiresAt: number;
}
let cachedIdToken: CachedIdToken | null = null;
let idTokenInFlight: Promise<string> | null = null;
const ID_TOKEN_TTL_MS = 50 * 60_000; // Google ID tokens last an hour

async function mintIdToken(audience: string): Promise<string> {
  const url =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" +
    encodeURIComponent(audience);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(copilotConfig.mcpTimeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    throw new MCPError(`Google identity token unavailable: ${e instanceof Error ? e.message : String(e)}`, {
      code: "mcp_iam_unavailable",
      retryable: true,
    });
  }
  if (!res.ok) {
    throw new MCPError(`Google identity token request returned ${res.status}`, { code: "mcp_iam_unavailable", httpStatus: res.status });
  }
  const token = (await res.text()).trim();
  if (!token) throw new MCPError("Google identity token response was empty", { code: "mcp_iam_unavailable" });
  cachedIdToken = { token, audience, expiresAt: mcpTiming.now() + ID_TOKEN_TTL_MS };
  return token;
}

async function iamHeaders(): Promise<Record<string, string>> {
  const audience = copilotConfig.mcpIamAudience;
  if (!audience) return {};
  if (cachedIdToken && cachedIdToken.audience === audience && mcpTiming.now() < cachedIdToken.expiresAt) {
    return { "X-Serverless-Authorization": `Bearer ${cachedIdToken.token}` };
  }
  idTokenInFlight ??= mintIdToken(audience).finally(() => {
    idTokenInFlight = null;
  });
  return { "X-Serverless-Authorization": `Bearer ${await idTokenInFlight}` };
}

async function post(headers: Record<string, string>, body: unknown): Promise<Response> {
  const iam = await iamHeaders();
  try {
    const res = await fetch(copilotConfig.mcpBaseUrl, {
      method: "POST",
      headers: { ...headers, ...iam },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(copilotConfig.mcpTimeoutMs),
      cache: "no-store",
    });
    // Read the body inside the same try: the response head can arrive early while the answer is slow, and a
    // timeout while reading it used to escape as a raw "operation was aborted" error that was never retried.
    const text = await res.text();
    return new Response(text === "" ? null : text, { status: res.status, headers: res.headers });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const timedOut = /abort|timeout/i.test(message);
    throw new MCPError(
      timedOut
        ? `MCP did not answer within ${copilotConfig.mcpTimeoutMs / 1000}s`
        : `MCP unreachable at ${copilotConfig.mcpBaseUrl}: ${message}`,
      { code: timedOut ? "mcp_timeout" : "mcp_unreachable", retryable: true },
    );
  }
}

async function handshake(bearer: string | null): Promise<string> {
  const key = sessionKey(bearer);
  const known = sessions.get(key);
  if (known) return known;
  const pending = handshakes.get(key);
  if (pending) return pending;

  const run = (async () => {
    const headers = baseHeaders(bearer);
    const init = await post(headers, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vanna-solana-copilot", version: "1.0.0" } },
    });
    if (!init.ok) {
      const text = await init.text().catch(() => "");
      throw httpError("initialize", init.status, text);
    }
    const id = init.headers.get("mcp-session-id");
    await init.text().catch(() => "");
    if (!id) throw new MCPError("MCP initialize response has no mcp-session-id", { code: "mcp_protocol_error" });
    // Required by Streamable HTTP; a failure here is not fatal to the session.
    await post({ ...headers, "mcp-session-id": id }, { jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
    sessions.set(key, id);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
    return id;
  })().finally(() => handshakes.delete(key));
  handshakes.set(key, run);
  return run;
}

// ── response parsing ────────────────────────────────────────────────────────

interface RpcEnvelope {
  error?: { code?: number; message?: string };
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    tools?: unknown[];
  };
}

async function readRpc(res: Response): Promise<RpcEnvelope | null> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      return JSON.parse(text) as RpcEnvelope;
    } catch {
      return null;
    }
  }
  let last: RpcEnvelope | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      last = JSON.parse(raw) as RpcEnvelope;
    } catch {
      /* keep scanning */
    }
  }
  return last;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function httpError(what: string, status: number, text: string): MCPError {
  let code: string | null = null;
  let detail = text.slice(0, 200);
  try {
    const parsed: unknown = JSON.parse(text);
    if (isObject(parsed)) {
      const c = parsed.error ?? parsed.code;
      if (typeof c === "string") code = c.toLowerCase();
      const d = parsed.detail ?? parsed.message;
      if (typeof d === "string") detail = d;
    }
  } catch {
    /* plain text body */
  }
  if (status === 401 || status === 403) code ??= "unauthorized";
  if (status === 429) code ??= "rate_limited";
  return new MCPError(`MCP ${what} failed (${status}): ${detail}`, {
    code,
    httpStatus: status,
    retryable: status === 429 || status >= 500,
  });
}

function toolPayload(tool: string, rpc: RpcEnvelope): Record<string, unknown> {
  if (rpc.error) {
    throw new MCPError(`MCP '${tool}' error: ${rpc.error.message ?? "unknown"}`, { code: "mcp_rpc_error" });
  }
  const result = rpc.result;
  if (!result) throw new MCPError(`MCP '${tool}' returned no result`, { code: "mcp_protocol_error" });

  let payload: unknown = result.structuredContent;
  if (!isObject(payload)) {
    const text = (result.content ?? []).map((b) => b.text ?? "").join("\n").trim();
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!isObject(payload)) {
      if (result.isError) throw new MCPError(`MCP '${tool}' failed: ${text.slice(0, 200)}`, { code: "tool_error" });
      throw new MCPError(`MCP '${tool}' returned a non-JSON result`, { code: "mcp_protocol_error" });
    }
  }
  // The server reports domain errors as a normal result: {"error": "<code>", "message": "..."}.
  // Write envelopes carry `error: null` on success, so only a string counts.
  if (typeof payload.error === "string" && payload.error) {
    const message = typeof payload.message === "string" ? payload.message : payload.error;
    throw new MCPError(message, { code: payload.error.toLowerCase() });
  }
  if (result.isError) {
    throw new MCPError(`MCP '${tool}' reported an error`, { code: "tool_error" });
  }
  return payload;
}

// ── call ────────────────────────────────────────────────────────────────────

/**
 * Identity hint for the MCP's per-caller rate limit. Only the wallet (public) is sent, never the
 * session cookie or anything secret.
 */
function assertion(user: CopilotUser | undefined): string | null {
  return user?.wallet ? `wallet:${user.wallet}` : null;
}

async function withRetries(send: () => Promise<Response>): Promise<Response> {
  let rateRetries = 0;
  let gatewayRetries = 0;
  let timeoutRetries = 0;
  for (;;) {
    let res: Response;
    try {
      res = await send();
    } catch (e) {
      // The hosted fork is sometimes slow or drops a connection. The MCP never signs or sends, so repeating
      // a call is always safe; one retry turns most of these into a normal answer instead of "unavailable".
      if (e instanceof MCPError && (e.code === "mcp_timeout" || e.code === "mcp_unreachable") && timeoutRetries < MAX_TIMEOUT_RETRIES) {
        timeoutRetries++;
        await mcpTiming.sleep(400);
        continue;
      }
      throw e;
    }
    if (res.status === 429 && rateRetries < MAX_RATE_LIMIT_RETRIES) {
      const seconds = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 500 * 2 ** rateRetries;
      // A long Retry-After is the server telling us to stop, not to sleep inside a request.
      if (waitMs > MAX_RETRY_AFTER_MS) return res;
      rateRetries++;
      await mcpTiming.sleep(waitMs);
      continue;
    }
    if ((res.status === 502 || res.status === 503) && gatewayRetries < MAX_GATEWAY_RETRIES) {
      gatewayRetries++;
      await mcpTiming.sleep(300);
      continue;
    }
    return res;
  }
}

async function rpcCall(
  method: "tools/call" | "tools/list",
  params: Record<string, unknown> | undefined,
  label: string,
  ctx: McpCtx,
): Promise<RpcEnvelope> {
  const exec = async (allowRehandshake: boolean): Promise<RpcEnvelope> => {
    const bearer = await getBearer();
    const sessionId = await handshake(bearer);
    const headers: Record<string, string> = { ...baseHeaders(bearer), "mcp-session-id": sessionId };
    const who = assertion(ctx.user);
    if (who) headers["X-Vanna-User-Assertion"] = who;
    if (ctx.requestId) headers["X-Request-Id"] = ctx.requestId;

    const res = await withRetries(() =>
      post(headers, { jsonrpc: "2.0", id: rpcId++, method, ...(params ? { params } : {}) }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        // Drop the cached token and session so the next call starts clean instead of replaying a rejected token.
        cachedToken = null;
        cachedIdToken = null;
        sessions.delete(sessionKey(bearer));
      }
      const staleSession = res.status === 404 || (res.status === 400 && /session/i.test(text));
      if (staleSession && allowRehandshake) {
        sessions.delete(sessionKey(bearer));
        return exec(false);
      }
      throw httpError(label, res.status, text);
    }
    const rpc = await readRpc(res);
    if (!rpc) throw new MCPError(`MCP '${label}' returned an unreadable response`, { code: "mcp_protocol_error" });
    return rpc;
  };
  return exec(true);
}

/** Calls one MCP tool and returns its parsed JSON result. Throws MCPError (code = the MCP's own `error`). */
export async function mcpCall(
  tool: string,
  args: Record<string, unknown>,
  ctx: McpCtx = {},
): Promise<Record<string, unknown>> {
  const rpc = await rpcCall("tools/call", { name: tool, arguments: args }, tool, ctx);
  try {
    const payload = toolPayload(tool, rpc);
    debugMcp(tool, args, true, payload);
    return payload;
  } catch (e) {
    debugMcp(tool, args, false, e instanceof MCPError ? { error: e.code, message: e.message } : String(e));
    throw e;
  }
}

/** Tool names the server exposes; used by the health probe. */
export async function mcpListTools(ctx: McpCtx = {}): Promise<string[]> {
  const rpc = await rpcCall("tools/list", {}, "tools/list", ctx);
  if (rpc.error) throw new MCPError(`MCP tools/list error: ${rpc.error.message ?? "unknown"}`, { code: "mcp_rpc_error" });
  const tools = rpc.result?.tools;
  if (!Array.isArray(tools)) throw new MCPError("MCP tools/list returned no tools array", { code: "mcp_protocol_error" });
  return tools.flatMap((t) => (isObject(t) && typeof t.name === "string" ? [t.name] : []));
}

/** Test helper / hot-reload safety. */
export function resetMcpClient(): void {
  cachedToken = null;
  tokenInFlight = null;
  cachedIdToken = null;
  idTokenInFlight = null;
  sessions.clear();
  handshakes.clear();
}

// ── write envelope ──────────────────────────────────────────────────────────

export type WriteEnvelopeResult =
  | { ok: true; tx: UnsignedTx; summary: Record<string, unknown>; preview: Record<string, unknown> | null }
  | { ok: false; code: string; reason: string };

/**
 * Reads the schema-v1 envelope of a write action. Fails closed: anything short of one simulated,
 * signable transaction is a refusal, because handing a wallet a half-built or failed-simulation
 * transaction is the one mistake this layer must never make.
 *
 * A setup-dependency envelope (lookup-table setup transactions before the action) is refused with
 * `multi_transaction_envelope` rather than silently dropping the later transactions.
 */
export function parseWriteEnvelope(result: Record<string, unknown>): WriteEnvelopeResult {
  const summary = isObject(result.summary) ? result.summary : {};
  const preview = isObject(result.preview) ? result.preview : null;
  const simulationOk = result.simulation_success === true;

  const errorCode = (typeof result.code === "string" && result.code) || (typeof result.error === "string" && result.error) || null;
  if (!simulationOk) {
    const reason =
      (typeof result.reason === "string" && result.reason) ||
      (typeof result.message === "string" && result.message) ||
      "The simulation did not succeed.";
    return { ok: false, code: errorCode ?? "simulation_failed", reason };
  }
  if (errorCode) {
    const reason = typeof result.reason === "string" && result.reason ? result.reason : errorCode;
    return { ok: false, code: errorCode, reason };
  }

  const txs = Array.isArray(result.transactions) ? result.transactions : [];
  if (txs.length !== 1) {
    return {
      ok: false,
      code: txs.length === 0 ? "no_transaction" : "multi_transaction_envelope",
      reason:
        txs.length === 0
          ? "The MCP returned no transaction."
          : "This action needs more than one transaction (setup required first); it cannot be run as a single step.",
    };
  }
  const first = txs[0];
  if (!isObject(first)) return { ok: false, code: "malformed_envelope", reason: "The transaction entry is malformed." };

  const sim = isObject(first.simulation) ? first.simulation : null;
  const unsigned = first.unsignedTransaction;
  const blockhash = first.blockhash;
  const lastValid = Number(first.lastValidBlockHeight);
  if (sim?.status !== "success") {
    const err = typeof sim?.err === "string" && sim.err ? sim.err : "The transaction was not simulated successfully.";
    return { ok: false, code: "simulation_failed", reason: err };
  }
  if (typeof unsigned !== "string" || !unsigned || typeof blockhash !== "string" || !blockhash || !Number.isSafeInteger(lastValid)) {
    return { ok: false, code: "malformed_envelope", reason: "The transaction is missing its message, blockhash or expiry." };
  }
  return {
    ok: true,
    tx: {
      transaction: unsigned,
      blockhash,
      lastValidBlockHeight: lastValid,
      simulation_success: true,
      ...(typeof summary.action === "string" ? { summary: summary.action } : {}),
      ...(summary.prerequisite === true ? { prerequisite: true } : {}),
    },
    summary,
    preview,
  };
}

// ── typed helpers (one per MCP action the brain needs) ───────────────────────

export interface SwapArgs {
  from_asset: string;
  to_asset: string;
  amount: string;
  slippage_bps?: number;
  /** "jupiter" | "titan"; omitted = the better quote at build time. */
  provider?: string;
}

/** A quote can include Titan only for a wallet (Titan builds per address): the user's, and margin mode for its margin. */
export type SwapQuoteArgs = Omit<SwapArgs, "provider"> & { authority?: string; mode?: "wallet" | "margin" };
export interface MarginAmountArgs {
  authority: string;
  asset: string;
  amount: string;
}

export const mcp = {
  call: mcpCall,
  parseWriteEnvelope,

  protocolInfo: (action: "config" | "assets" | "integrations" = "config", ctx: McpCtx = {}) =>
    mcpCall("vanna_protocol_info", { action }, ctx),
  price: (symbol: string, ctx: McpCtx = {}) => mcpCall("vanna_oracle", { action: "price", asset: symbol }, ctx),
  prices: (symbols: string[], ctx: McpCtx = {}) => mcpCall("vanna_oracle", { action: "prices", assets: symbols }, ctx),
  poolStats: (symbol: string, ctx: McpCtx = {}) => mcpCall("vanna_earn_market", { action: "pool_stats", asset: symbol }, ctx),
  accountHealth: (owner: string, ctx: McpCtx = {}) => mcpCall("vanna_account", { action: "health", authority: owner }, ctx),
  accountResolve: (owner: string, ctx: McpCtx = {}) => mcpCall("vanna_account", { action: "resolve", authority: owner }, ctx),
  marginCollateral: (owner: string, ctx: McpCtx = {}) =>
    mcpCall("vanna_margin_status", { action: "collateral", authority: owner }, ctx),
  marginDebt: (owner: string, ctx: McpCtx = {}) => mcpCall("vanna_margin_status", { action: "debt", authority: owner }, ctx),
  wallet: (owner: string, ctx: McpCtx = {}) => mcpCall("vanna_wallet", { action: "summary", authority: owner }, ctx),
  earnPosition: (owner: string, symbol: string, ctx: McpCtx = {}) =>
    mcpCall("vanna_earn_position", { action: "deposited_balance", owner, asset: symbol }, ctx),
  farmMarkets: (ctx: McpCtx = {}) => mcpCall("vanna_farm_overview", { action: "markets" }, ctx),
  swapQuote: (args: SwapQuoteArgs, ctx: McpCtx = {}) => mcpCall("vanna_swap", { action: "quote", ...args }, ctx),
  canBorrow: (args: MarginAmountArgs, ctx: McpCtx = {}) =>
    mcpCall("vanna_margin_status", { action: "can_borrow", ...args }, ctx),
  canWithdraw: (args: MarginAmountArgs, ctx: McpCtx = {}) =>
    mcpCall("vanna_margin_status", { action: "can_withdraw", ...args }, ctx),
  maxBorrow: (owner: string, asset: string, ctx: McpCtx = {}) =>
    mcpCall("vanna_margin_status", { action: "max_borrow", authority: owner, asset }, ctx),
  maxWithdraw: (owner: string, asset: string, ctx: McpCtx = {}) =>
    mcpCall("vanna_margin_status", { action: "max_withdraw", authority: owner, asset }, ctx),
  canSwap: (args: SwapArgs & { authority: string }, ctx: McpCtx = {}) =>
    mcpCall("vanna_swap", { action: "can_swap", ...args }, ctx),
  txStatus: (signature: string, ctx: McpCtx = {}) => mcpCall("vanna_sign", { action: "tx_status", signature }, ctx),
  perpsMarkets: (ctx: McpCtx = {}) => mcpCall("vanna_perps", { action: "markets" }, ctx),
  perpsPositions: (owner: string, ctx: McpCtx = {}) => mcpCall("vanna_perps", { action: "positions", authority: owner }, ctx),
  perpsWrite: (args: Record<string, unknown>, ctx: McpCtx = {}) => mcpCall("vanna_perps", args, ctx),
  vaultsList: (ctx: McpCtx = {}) => mcpCall("vanna_vaults", { action: "list" }, ctx),
  vaultsPositions: (owner: string, ctx: McpCtx = {}) => mcpCall("vanna_vaults", { action: "positions", authority: owner }, ctx),
  vaultsPreview: (args: { authority: string; vault: string; call: "deposit" | "withdraw"; amount: string }, ctx: McpCtx = {}) =>
    mcpCall("vanna_vaults", { action: "preview", ...args }, ctx),
  perpsPreview: (
    args: { authority: string; market: string; side: "long" | "short"; collateral_usdc: string; leverage: number; slippage_bps?: number },
    ctx: McpCtx = {},
  ) => mcpCall("vanna_perps", { action: "preview", ...args }, ctx),
};
