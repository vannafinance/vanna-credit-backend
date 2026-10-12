/**
 * Site-wide access gate: server-only helpers shared by `proxy.ts` (cookie check on every request)
 * and `app/api/access/route.ts` (code check + cookie issue). Never import this from client code —
 * it reads ACCESS_CODE / ACCESS_COOKIE_SECRET and would leak them into the browser bundle.
 *
 * Cookie value format: `v1.<expiresAtMs>.<hex HMAC-SHA256>`, where the HMAC covers the version,
 * the expiry and a fingerprint of the current access code. Rotating ACCESS_CODE (or
 * ACCESS_COOKIE_SECRET) therefore invalidates every cookie issued before the rotation.
 * See docs/ACCESS_GATE.md.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Name of the httpOnly cookie that proves the browser passed the gate. */
export const ACCESS_COOKIE_NAME = "vanna_access";

/** How long a successful code entry is remembered (~30 days). */
export const ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60;

const TOKEN_VERSION = "v1";

/**
 * The access code users must enter (env ACCESS_CODE, trimmed). There is no built-in default: the
 * code lives only in the environment, and when it is unset the gate fails closed (no code is
 * accepted and no cookie verifies) instead of falling back to a value committed in the repo.
 */
export function getAccessCode(): string {
  return process.env.ACCESS_CODE?.trim() ?? "";
}

/**
 * HMAC key for the cookie. Prefer an explicit ACCESS_COOKIE_SECRET; otherwise derive one from the
 * access code so the gate still works with zero configuration (anyone who knows the code could
 * then mint a cookie, but they could also just enter the code — set the secret in production).
 */
function getCookieSecret(): string {
  const fromEnv = process.env.ACCESS_COOKIE_SECRET?.trim();
  if (fromEnv) return fromEnv;
  return sha256Hex(`vanna-access-gate:secret:${getAccessCode()}`);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Constant-time string equality (hashes both sides first so lengths never leak via timing). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** True when `submitted` equals the configured access code (constant-time, surrounding whitespace ignored). */
export function isValidAccessCode(submitted: unknown): boolean {
  if (typeof submitted !== "string") return false;
  // Bound the work done on attacker-controlled input.
  if (submitted.length === 0 || submitted.length > 256) return false;
  const code = getAccessCode();
  if (!code) return false;
  return safeEqual(submitted.trim(), getAccessCode());
}

function signature(expiresAtMs: number): string {
  const codeFingerprint = sha256Hex(`vanna-access-gate:code:${getAccessCode()}`);
  return createHmac("sha256", getCookieSecret())
    .update(`${TOKEN_VERSION}.${expiresAtMs}.${codeFingerprint}`)
    .digest("hex");
}

/** Mint a signed cookie value valid for {@link ACCESS_TTL_SECONDS} from `nowMs`. */
export function createAccessToken(nowMs: number = Date.now()): string {
  const expiresAtMs = nowMs + ACCESS_TTL_SECONDS * 1000;
  return `${TOKEN_VERSION}.${expiresAtMs}.${signature(expiresAtMs)}`;
}

/** True when `token` is a well-formed, correctly signed, unexpired access cookie. */
export function verifyAccessToken(token: string | undefined | null, nowMs: number = Date.now()): boolean {
  if (!token || token.length > 200) return false;
  // Gate not configured: fail closed (the derived fallback secret would be guessable).
  if (!getAccessCode()) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return false;
  const [, expiresRaw, sig] = parts;
  if (!/^\d{1,16}$/.test(expiresRaw) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expiresAtMs = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) return false;
  // Reject tokens claiming a lifetime longer than we ever issue (guards against a leaked secret
  // being used to mint "forever" cookies being silently accepted).
  if (expiresAtMs - nowMs > ACCESS_TTL_SECONDS * 1000 + 60_000) return false;
  return safeEqual(sig, signature(expiresAtMs));
}

/** Whether the configured code is digits-only (lets the gate show a numeric keypad on mobile). */
export function isNumericAccessCode(): boolean {
  return /^\d+$/.test(getAccessCode());
}
