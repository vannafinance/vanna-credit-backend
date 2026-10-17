/**
 * Vanna Solana Copilot configuration, resolved lazily from process env (.env.local under Next.js).
 * Server-side only. Getters (not constants) so tests and hot reloads see env changes.
 *
 * No value here is a stand-in for real data: a missing secret is an error at the point of use,
 * never a silent default. Only tunable limits carry defaults.
 */

function env(key: string, fallback = ""): string {
  return (process.env[key] ?? fallback).trim();
}

function envNumber(key: string, fallback: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type McpAuthMode = "workos" | "none";

let warnedStoreSecret = false;

export const copilotConfig = {
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production" || !!process.env.K_SERVICE;
  },

  // ── MCP ────────────────────────────────────────────────────────────────────
  get mcpBaseUrl(): string {
    return env("MCP_BASE_URL", "http://localhost:8000/mcp");
  },
  /** `none` only for a local MCP started with AUTH_ENABLED=false. Never honoured in production. */
  get mcpAuthMode(): McpAuthMode {
    const requested = env("MCP_AUTH_MODE", "workos").toLowerCase() === "none" ? "none" : "workos";
    return requested === "none" && this.isProduction ? "workos" : requested;
  },
  get workosClientId(): string {
    return env("WORKOS_M2M_CLIENT_ID");
  },
  get workosClientSecret(): string {
    return env("WORKOS_M2M_CLIENT_SECRET");
  },
  get workosTokenUrl(): string {
    return env("WORKOS_M2M_TOKEN_URL");
  },
  /** Optional audience sent as the OAuth `resource` when minting the M2M token. */
  get mcpResource(): string {
    return env("MCP_RESOURCE");
  },
  /**
   * Set when the MCP is a Cloud Run service that requires IAM (internal ingress). Its value is the
   * service's origin, used as the audience of a Google ID token sent as `X-Serverless-Authorization`
   * so `Authorization` stays free for the WorkOS bearer. Empty = no Google token (local MCP).
   */
  get mcpIamAudience(): string {
    return env("MCP_IAM_AUDIENCE").replace(/\/$/, "");
  },
  /**
   * The public MCP connector's origin (e.g. https://vanna-mcp-solana-public-….run.app; local http://127.0.0.1:8000).
   * The approve page (/approve/<plan>) proxies its plan API, so an AI client's plan link opens on this site. Empty =
   * approvals on this site are off (the MCP's own page still works).
   */
  get mcpPlanApiUrl(): string {
    return env("MCP_PLAN_API_URL").replace(/\/$/, "");
  },
  /** Shared with the MCP's PLAN_PROXY_SECRET: lets the MCP rate-limit per end user behind this proxy. Optional. */
  get planProxySecret(): string {
    return env("PLAN_PROXY_SECRET");
  },
  get mcpTimeoutMs(): number {
    // The hosted fork's RPC sometimes needs ~22s for one oracle read; 20s cut those off.
    return envNumber("MCP_TIMEOUT_MS", 30_000);
  },

  // ── Sessions / SIWS ────────────────────────────────────────────────────────
  get sessionSecret(): string {
    return env("COPILOT_SESSION_SECRET");
  },
  /**
   * Record-encryption secret. The record and session keys are separate HKDF derivations either way; a distinct
   * secret also lets the session secret rotate without making saved plans unreadable. Falling back to the session
   * secret still works (development needs only one value), but production warns once.
   */
  get storeSecret(): string {
    const own = env("COPILOT_STORE_SECRET");
    if (own) return own;
    if (this.isProduction && !warnedStoreSecret) {
      warnedStoreSecret = true;
      console.warn("[copilot] COPILOT_STORE_SECRET is not set; records are encrypted under a key derived from COPILOT_SESSION_SECRET. Set a separate value.");
    }
    return env("COPILOT_SESSION_SECRET");
  },
  get publicOrigin(): string {
    return env("COPILOT_PUBLIC_ORIGIN").replace(/\/$/, "");
  },
  /**
   * The domain a SIWS message must name. Explicit > host of the public origin. Development
   * falls back to localhost:3000; production refuses to guess (empty string = misconfigured).
   */
  get authDomain(): string {
    const explicit = env("COPILOT_AUTH_DOMAIN");
    if (explicit) return explicit;
    const origin = this.publicOrigin;
    if (origin) {
      try {
        return new URL(origin).host;
      } catch {
        return "";
      }
    }
    return this.isProduction ? "" : "localhost:3000";
  },
  /**
   * A sign-in ends 12 hours after the wallet signed it, used or not: `sessionTtlMs` (how long past its last use) equals
   * `sessionMaxMs` (how long past the signature), so a renewal can never extend it. Sign-out still voids it at once,
   * on every device.
   */
  get sessionTtlMs(): number {
    return 12 * 60 * 60 * 1000;
  },
  get sessionMaxMs(): number {
    return 12 * 60 * 60 * 1000;
  },
  /** A renewal re-issues the cookie at most this often, not on every request. */
  get sessionRenewAfterMs(): number {
    return 60 * 60 * 1000;
  },
  get nonceTtlMs(): number {
    return 5 * 60 * 1000;
  },

  // ── Store ──────────────────────────────────────────────────────────────────
  get firestoreProject(): string {
    return env("COPILOT_FIRESTORE_PROJECT");
  },
  get firestoreDatabase(): string {
    return env("COPILOT_FIRESTORE_DATABASE", "(default)");
  },
  get collectionPrefix(): string {
    return env("COPILOT_FIRESTORE_COLLECTION_PREFIX", "solana_copilot_");
  },

  // ── LLM ────────────────────────────────────────────────────────────────────
  get googleCloudProject(): string {
    return env("GOOGLE_CLOUD_PROJECT") || env("GCLOUD_PROJECT");
  },
  get googleCloudLocation(): string {
    return env("GOOGLE_CLOUD_LOCATION", "global");
  },
  get vertexModel(): string {
    return env("VERTEX_MODEL", "gemini-3.8-flash");
  },

  /**
   * Investigation (lib/copilot/investigation): Gemini reads the account through tools and decides, like the Stellar
   * Copilot. Off = the keyword router alone (also the fallback when the model is unreachable).
   */
  get investigationEnabled(): boolean {
    return env("COPILOT_INVESTIGATION", "on") !== "off";
  },
  get investigationThinking(): "LOW" | "MEDIUM" | "HIGH" {
    const v = env("COPILOT_THINKING_LEVEL", "MEDIUM").toUpperCase();
    return v === "LOW" || v === "HIGH" ? v : "MEDIUM";
  },
  /** Thinking for turns that only turn gathered evidence into a decision (not the first turn, not a correction). */
  get followupThinking(): "LOW" | "MEDIUM" | "HIGH" {
    const v = env("COPILOT_FOLLOWUP_THINKING_LEVEL", "LOW").toUpperCase();
    return v === "MEDIUM" || v === "HIGH" ? v : "LOW";
  },
  get investigationMaxTurns(): number {
    return Math.min(10, Math.max(2, envNumber("COPILOT_INVESTIGATION_MAX_TURNS", 6)));
  },
  get investigationTimeoutMs(): number {
    return Math.min(90_000, Math.max(10_000, envNumber("COPILOT_INVESTIGATION_TIMEOUT_MS", 50_000)));
  },

  // ── Limits ─────────────────────────────────────────────────────────────────
  get rateChatPerMin(): number {
    return envNumber("COPILOT_RATE_CHAT_PER_MIN", 20);
  },
  get rateWritePerMin(): number {
    return envNumber("COPILOT_RATE_WRITE_PER_MIN", 6);
  },
  get dailyTokenCap(): number {
    return envNumber("COPILOT_DAILY_TOKEN_CAP", 2_000_000);
  },
  /**
   * USD value of one action / of a UTC day's actions per wallet. No limit unless set (Infinity); set a positive number to
   * turn a limit on. The health-factor floor applies either way.
   */
  get maxActionUsd(): number {
    return envNumber("COPILOT_MAX_ACTION_USD", Infinity);
  },
  get maxDailyUsd(): number {
    return envNumber("COPILOT_MAX_DAILY_USD", Infinity);
  },

  /** Protocol liquidates at 1.10; the Copilot sizes to this floor. */
  get minHealthFactor(): number {
    return envNumber("MIN_HEALTH_FACTOR", 1.15);
  },
};
