import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_COOKIE,
  authClock,
  clearSessionCookie,
  createSession,
  getUser,
  issueNonce,
  renewSessionCookie,
  revokeSessions,
  sessionCookieHeader,
  setNonceStoreForTests,
  setRevocationStoreForTests,
  verifyLogin,
} from "./auth";
import { setLimitStoreForTests } from "./limits";
import { MemoryRecordStore } from "./testing";

const keypair = nacl.sign.keyPair();
const wallet = new PublicKey(keypair.publicKey).toBase58();
const sign = (message: string, kp = keypair) =>
  Buffer.from(nacl.sign.detached(new Uint8Array(Buffer.from(message)), kp.secretKey)).toString("base64");

beforeEach(() => {
  vi.stubEnv("COPILOT_SESSION_SECRET", "x".repeat(40));
  vi.stubEnv("COPILOT_AUTH_DOMAIN", "app.vanna.test");
  vi.stubEnv("COPILOT_PUBLIC_ORIGIN", "https://app.vanna.test");
  setNonceStoreForTests(new MemoryRecordStore());
  setRevocationStoreForTests(new MemoryRecordStore());
  setLimitStoreForTests(new MemoryRecordStore());
  authClock.now = () => Date.now();
});
afterEach(() => {
  vi.unstubAllEnvs();
  setNonceStoreForTests(null);
  setRevocationStoreForTests(null);
  setLimitStoreForTests(null);
  authClock.now = () => Date.now();
});

describe("SIWS login", () => {
  it("issues a message naming the domain, wallet, nonce, issued-at and expiry", async () => {
    const n = await issueNonce(wallet);
    expect(n.message).toContain("app.vanna.test wants you to sign in with your Solana account:");
    expect(n.message).toContain(wallet);
    expect(n.message).toContain(`Nonce: ${n.nonce}`);
    expect(n.message).toMatch(/Issued At: \d{4}-/);
    expect(n.message).toMatch(/Expiration Time: \d{4}-/);
    expect(n.expires_at - Date.now()).toBeGreaterThan(4 * 60_000);
  });

  it("accepts a valid signature and returns the wallet identity", async () => {
    const n = await issueNonce(wallet);
    const user = await verifyLogin({ wallet, message: n.message, signature: sign(n.message) });
    expect(user.wallet).toBe(wallet);
    expect(user.subject).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a signature from a different key", async () => {
    const n = await issueNonce(wallet);
    const other = nacl.sign.keyPair();
    await expect(verifyLogin({ wallet, message: n.message, signature: sign(n.message, other) })).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });

  it("rejects a message the server did not issue, even when correctly signed", async () => {
    const n = await issueNonce(wallet);
    const forged = n.message.replace(/Expiration Time: .*/, "Expiration Time: 2099-01-01T00:00:00.000Z");
    await expect(verifyLogin({ wallet, message: forged, signature: sign(forged) })).rejects.toMatchObject({ code: "unknown_nonce" });
  });

  it("rejects a message for another domain", async () => {
    const n = await issueNonce(wallet);
    const phished = n.message.replace("app.vanna.test", "evil.example");
    await expect(verifyLogin({ wallet, message: phished, signature: sign(phished) })).rejects.toMatchObject({
      code: "wrong_domain_or_wallet",
    });
  });

  it("makes each nonce single-use, including under concurrency", async () => {
    const n = await issueNonce(wallet);
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () => verifyLogin({ wallet, message: n.message, signature: sign(n.message) })),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    await expect(verifyLogin({ wallet, message: n.message, signature: sign(n.message) })).rejects.toMatchObject({ code: "nonce_used" });
  });

  it("rejects an expired nonce (5 minute TTL)", async () => {
    const n = await issueNonce(wallet);
    authClock.now = () => Date.now() + 5 * 60_000 + 1000;
    await expect(verifyLogin({ wallet, message: n.message, signature: sign(n.message) })).rejects.toMatchObject({ code: "nonce_expired" });
  });

  it("does not burn the nonce on a bad signature", async () => {
    const n = await issueNonce(wallet);
    await expect(verifyLogin({ wallet, message: n.message, signature: sign(n.message, nacl.sign.keyPair()) })).rejects.toBeTruthy();
    await expect(verifyLogin({ wallet, message: n.message, signature: sign(n.message) })).resolves.toMatchObject({ wallet });
  });

  it("rejects malformed wallets and rate-limits nonce minting per wallet", async () => {
    await expect(issueNonce("not-a-wallet")).rejects.toMatchObject({ code: "invalid_wallet" });
    for (let i = 0; i < 10; i++) await issueNonce(wallet);
    await expect(issueNonce(wallet)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  });
});

const HOUR = 3600_000;
const HOUR12 = 12 * HOUR;

describe("session cookie", () => {
  const reqWith = (cookie: string) => new Request("http://x.test/api", { headers: { cookie } });

  it("round-trips and sets HttpOnly / SameSite=Lax", async () => {
    const s = createSession(wallet);
    const header = sessionCookieHeader(s);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Secure"); // the test env is not production
    expect(s.maxAgeS).toBe(12 * 3600);
    const user = await getUser(reqWith(`other=1; ${SESSION_COOKIE}=${s.value}`));
    expect(user?.wallet).toBe(wallet);
  });

  it("is Secure in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(sessionCookieHeader(createSession(wallet))).toContain("Secure");
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  it("rejects tampered, expired and foreign-secret cookies, and a missing cookie", async () => {
    const s = createSession(wallet);
    const tampered = s.value.slice(0, -2) + (s.value.endsWith("AA") ? "BB" : "AA");
    expect(await getUser(reqWith(`${SESSION_COOKIE}=${tampered}`))).toBeNull();
    expect(await getUser(reqWith(`${SESSION_COOKIE}=garbage`))).toBeNull();
    expect(await getUser(new Request("http://x.test"))).toBeNull();
    authClock.now = () => Date.now() + HOUR12 + 1000;
    expect(await getUser(reqWith(`${SESSION_COOKIE}=${s.value}`))).toBeNull();
    authClock.now = () => Date.now();
    vi.stubEnv("COPILOT_SESSION_SECRET", "y".repeat(40));
    expect(await getUser(reqWith(`${SESSION_COOKIE}=${s.value}`))).toBeNull();
  });

  it("sign-out voids every earlier session for the wallet, and a new sign-in works", async () => {
    let t = 1_000_000;
    authClock.now = () => t;
    const phone = createSession(wallet);
    t += 10;
    const laptop = createSession(wallet);
    t += 10;
    await revokeSessions(wallet);
    expect(await getUser(reqWith(`${SESSION_COOKIE}=${phone.value}`))).toBeNull();
    expect(await getUser(reqWith(`${SESSION_COOKIE}=${laptop.value}`))).toBeNull();
    t += 10;
    const fresh = createSession(wallet);
    expect((await getUser(reqWith(`${SESSION_COOKIE}=${fresh.value}`)))?.wallet).toBe(wallet);
  });

  it("ends 12 hours after the sign-in, however often it is used", async () => {
    let t = 1_000_000_000;
    authClock.now = () => t;
    const first = createSession(wallet);
    const cookie = `${SESSION_COOKIE}=${first.value}`;
    // Used every hour: never renewed past the 12 hours, and it keeps working until then.
    for (let i = 0; i < 11; i++) {
      t += HOUR;
      expect(renewSessionCookie(await getUser(reqWith(cookie)))).toBeNull();
      expect((await getUser(reqWith(cookie)))?.wallet).toBe(wallet);
    }
    t = 1_000_000_000 + HOUR12 + 1;
    expect(await getUser(reqWith(cookie))).toBeNull();
    expect(renewSessionCookie(null)).toBeNull();
  });

  it("refuses to seal with a short secret", () => {
    vi.stubEnv("COPILOT_SESSION_SECRET", "short");
    expect(() => createSession(wallet)).toThrow();
  });
});
