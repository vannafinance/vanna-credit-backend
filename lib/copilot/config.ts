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
  get mcpTimeoutMs(): number {
    // The hosted fork's RPC sometimes needs ~22s for one oracle read; 20s cut those off.
    return envNumber("MCP_TIMEOUT_MS", 30_000);
  },

  // ── Sessions / SIWS ────────────────────────────────────────────────────────
  get sessionSecret(): string {
    return env("COPILOT_SESSION_SECRET");
  },
  /** Record-encryption secret; falls back to the session secret so one value is enough. */
  get storeSecret(): string {
    return env("COPILOT_STORE_SECRET") || env("COPILOT_SESSION_SECRET");
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
  get sessionTtlMs(): number {
    return 12 * 60 * 60 * 1000;
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
  get maxActionUsd(): number {
    return envNumber("COPILOT_MAX_ACTION_USD", 5_000);
  },
  get maxDailyUsd(): number {
    return envNumber("COPILOT_MAX_DAILY_USD", 25_000);
  },

  /** Protocol liquidates at 1.10; the Copilot sizes to this floor. */
  get minHealthFactor(): number {
    return envNumber("MIN_HEALTH_FACTOR", 1.15);
  },
};
