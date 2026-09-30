/**
 * Sign-In-With-Solana for the Copilot. The wallet is the only identity: it signs a server-issued
 * message (domain + nonce + issued-at + expiry), and the server answers with an AES-GCM sealed,
 * HttpOnly session cookie. Everything downstream (limits, plans, conversations) keys off that cookie,
 * never off a wallet field in a request body.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

import { copilotConfig } from "./config";
import { consumeWindow } from "./limits";
import { limitStore, type RecordStore } from "./store";
import type { CopilotUser, NonceResponse } from "./types";

export const SESSION_COOKIE = "vanna_copilot_session";

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

interface NonceRecord {
  wallet: string;
  message: string;
  expiresAt: number;
  used: boolean;
}

/** Test seams. */
export const authClock = { now: () => Date.now() };
let nonceStoreOverride: RecordStore<NonceRecord> | null = null;
export function setNonceStoreForTests(store: RecordStore<NonceRecord> | null): void {
  nonceStoreOverride = store;
}
const nonces = () => nonceStoreOverride ?? limitStore<NonceRecord>();
const nonceDoc = (nonce: string) => createHash("sha256").update(`siws-nonce:${nonce}`).digest("hex");

// ── wallet helpers ──────────────────────────────────────────────────────────

function parseWallet(wallet: unknown): PublicKey {
  if (typeof wallet !== "string" || wallet.length < 32 || wallet.length > 44) {
    throw new AuthError("invalid_wallet", "That is not a valid Solana address.", 400);
  }
  try {
    const key = new PublicKey(wallet);
    // Round-trip so only the canonical encoding is accepted.
    if (key.toBase58() !== wallet) throw new Error("non-canonical");
    return key;
  } catch {
    throw new AuthError("invalid_wallet", "That is not a valid Solana address.", 400);
  }
}

export const subjectFor = (wallet: string) => createHash("sha256").update(wallet).digest("hex");

// ── SIWS message ────────────────────────────────────────────────────────────

function siwsMessage(domain: string, wallet: string, nonce: string, issuedAt: number, expiresAt: number): string {
  const origin = copilotConfig.publicOrigin || `${copilotConfig.isProduction ? "https" : "http"}://${domain}`;
  return [
    `${domain} wants you to sign in with your Solana account:`,
    wallet,
    "",
    "Sign in to the Vanna Copilot. This only proves you own this wallet; it does not move funds or grant spending rights.",
    "",
    `URI: ${origin}`,
    "Version: 1",
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(expiresAt).toISOString()}`,
  ].join("\n");
}

export async function issueNonce(wallet: string): Promise<NonceResponse> {
  parseWallet(wallet);
  const domain = copilotConfig.authDomain;
  if (!domain) throw new AuthError("auth_not_configured", "Sign-in is not configured (COPILOT_AUTH_DOMAIN).", 503);

  // Nonces are cheap but unauthenticated; cap how many one wallet can mint.
  const gate = await consumeWindow(`nonce:${wallet}`, 10, 60_000);
  if (!gate.ok) throw new AuthError("rate_limited", gate.message, 429);

  const now = authClock.now();
  const expiresAt = now + copilotConfig.nonceTtlMs;
  const nonce = randomBytes(16).toString("hex");
  const message = siwsMessage(domain, wallet, nonce, now, expiresAt);
  const created = await nonces().write(nonceDoc(nonce), null, { wallet, message, expiresAt, used: false });
  if (!created) throw new AuthError("nonce_collision", "Could not issue a nonce; try again.", 503);
  return { nonce, message, expires_at: expiresAt };
}

export async function verifyLogin(input: { wallet: string; message: string; signature: string }): Promise<CopilotUser> {
  const key = parseWallet(input.wallet);
  const { message, signature } = input;
  if (typeof message !== "string" || message.length > 2_000 || typeof signature !== "string" || signature.length > 200) {
    throw new AuthError("invalid_request", "Malformed sign-in request.", 400);
  }

  const domain = copilotConfig.authDomain;
  if (!domain) throw new AuthError("auth_not_configured", "Sign-in is not configured (COPILOT_AUTH_DOMAIN).", 503);
  if (!message.startsWith(`${domain} wants you to sign in with your Solana account:\n${input.wallet}\n`)) {
    throw new AuthError("wrong_domain_or_wallet", "The sign-in message is not for this site and wallet.");
  }
  const nonce = /\nNonce: ([a-f0-9]{32})\n/.exec(message)?.[1];
  if (!nonce) throw new AuthError("invalid_message", "The sign-in message has no valid nonce.");

  const sigBytes = Buffer.from(signature, "base64");
  if (sigBytes.length !== nacl.sign.signatureLength) throw new AuthError("invalid_signature", "The signature is not valid.");
  // Verify over the exact bytes the wallet was shown, before touching the nonce, so a bad signature cannot burn it.
  if (!nacl.sign.detached.verify(new Uint8Array(Buffer.from(message, "utf8")), new Uint8Array(sigBytes), key.toBytes())) {
    throw new AuthError("invalid_signature", "The signature is not valid.");
  }

  const s = nonces();
  const id = nonceDoc(nonce);
  const record = await s.read(id);
  const now = authClock.now();
  // The stored message is the source of truth: the client cannot alter issued-at or expiry.
  if (!record || record.value.message !== message || record.value.wallet !== input.wallet) {
    throw new AuthError("unknown_nonce", "This sign-in request was not issued by the server.");
  }
  if (record.value.used) throw new AuthError("nonce_used", "This sign-in request was already used.");
  if (now >= record.value.expiresAt) throw new AuthError("nonce_expired", "This sign-in request expired. Try again.");
  // Compare-and-set: two concurrent verifies of one nonce cannot both succeed.
  if (!(await s.write(id, record.version, { ...record.value, used: true }))) {
    throw new AuthError("nonce_used", "This sign-in request was already used.");
  }
  return userFor(input.wallet, now + copilotConfig.sessionTtlMs);
}

const userFor = (wallet: string, expiresAt: number): CopilotUser => ({ wallet, subject: subjectFor(wallet), expiresAt });

// ── session cookie ──────────────────────────────────────────────────────────

function sessionKey(): Buffer {
  const secret = copilotConfig.sessionSecret;
  if (secret.length < 32) throw new AuthError("session_secret_required", "COPILOT_SESSION_SECRET (32+ chars) is required.", 503);
  return Buffer.from(hkdfSync("sha256", secret, "vanna-solana-copilot", "session-v1", 32));
}

export function createSession(wallet: string): { value: string; expiresAt: number; maxAgeS: number } {
  parseWallet(wallet);
  const expiresAt = authClock.now() + copilotConfig.sessionTtlMs;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey(), iv);
  cipher.setAAD(Buffer.from("copilot-session"));
  const data = Buffer.concat([cipher.update(JSON.stringify({ w: wallet, exp: expiresAt }), "utf8"), cipher.final()]);
  const value = [iv, cipher.getAuthTag(), data].map((p) => p.toString("base64url")).join(".");
  return { value, expiresAt, maxAgeS: Math.floor(copilotConfig.sessionTtlMs / 1000) };
}

function unseal(value: string): { wallet: string; expiresAt: number } | null {
  try {
    const [iv, tag, data, extra] = value.split(".");
    if (!iv || !tag || !data || extra || value.length > 1_000) return null;
    const decipher = createDecipheriv("aes-256-gcm", sessionKey(), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from("copilot-session"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")) as {
      w?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.w !== "string" || typeof parsed.exp !== "number") return null;
    return { wallet: parsed.w, expiresAt: parsed.exp };
  } catch {
    return null;
  }
}

function cookieAttributes(maxAgeS: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${copilotConfig.isProduction ? "; Secure" : ""}`;
}

/** Set-Cookie header value that establishes the session. */
export function sessionCookieHeader(session: { value: string; maxAgeS: number }): string {
  return `${SESSION_COOKIE}=${session.value}; ${cookieAttributes(session.maxAgeS)}`;
}

/** Set-Cookie header value that ends the session. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(0)}`;
}

function cookieFrom(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The signed-in wallet for this request, or null. The only source of identity for Copilot routes. */
export async function getUser(req: Request): Promise<CopilotUser | null> {
  const raw = cookieFrom(req.headers.get("cookie"), SESSION_COOKIE);
  if (!raw) return null;
  const session = unseal(raw);
  if (!session || authClock.now() >= session.expiresAt) return null;
  try {
    parseWallet(session.wallet);
  } catch {
    return null;
  }
  return userFor(session.wallet, session.expiresAt);
}
