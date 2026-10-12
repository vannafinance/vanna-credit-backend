import { NextResponse } from "next/server";

/**
 * Strips anything credential-like from text bound for a client. Upstream RPC errors echo their full
 * request URL (e.g. the Surfpool fork reports `…for url (https://solana-mainnet.g.alchemy.com/v2/<key>)`),
 * so every URL keeps only its scheme + host, and bare provider keys / `api-key=` params are masked.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b((?:https?|wss?):\/\/[^\s/"'()<>]+)[^\s"'()<>]*/gi, "$1/[redacted]")
    .replace(/\balch_[A-Za-z0-9_-]+/g, "alch_[redacted]")
    .replace(/((?:api[-_]?key|apikey|token|secret)=)[^&\s"']+/gi, "$1[redacted]");
}

/** Keys whose string values carry error text and are passed through {@link redactSecrets}. */
const ERROR_KEYS = new Set(["error", "message", "detail", "details", "reason"]);

/**
 * JSON response that serialises bigint as decimal strings. Only error-text fields ({@link ERROR_KEYS})
 * are redacted: data URLs such as market images must reach the client intact.
 */
export function jsonResponse(body: unknown, init?: ResponseInit) {
  const text = JSON.stringify(body, (k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "string" && ERROR_KEYS.has(k) ? redactSecrets(v) : v));
  return new NextResponse(text, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
}

export function isPublicKeyString(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}
