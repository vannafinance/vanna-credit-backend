import { NextResponse } from "next/server";

/** JSON response that serialises bigint as decimal strings. */
export function jsonResponse(body: unknown, init?: ResponseInit) {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return new NextResponse(text, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
}

export function isPublicKeyString(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(value);
}
