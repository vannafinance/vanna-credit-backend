import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "@/proxy";
import { POST } from "@/app/api/access/route";
import { renderGatePage, safeNextPath } from "./gate-page";
import { createRateLimiter, clientIp } from "./rate-limit";
import {
  ACCESS_COOKIE_NAME,
  ACCESS_TTL_SECONDS,
  createAccessToken,
  getAccessCode,
  isValidAccessCode,
  verifyAccessToken,
} from "./token";

const saved = { code: process.env.ACCESS_CODE, secret: process.env.ACCESS_COOKIE_SECRET };

beforeEach(() => {
  process.env.ACCESS_CODE = "2861";
  delete process.env.ACCESS_COOKIE_SECRET;
});
afterEach(() => {
  if (saved.code === undefined) delete process.env.ACCESS_CODE;
  else process.env.ACCESS_CODE = saved.code;
  if (saved.secret === undefined) delete process.env.ACCESS_COOKIE_SECRET;
  else process.env.ACCESS_COOKIE_SECRET = saved.secret;
});

describe("access code", () => {
  it("fails closed when ACCESS_CODE is unset", () => {
    delete process.env.ACCESS_CODE;
    expect(getAccessCode()).toBe("");
    expect(isValidAccessCode("2861")).toBe(false);
    expect(isValidAccessCode("x")).toBe(false);
    expect(verifyAccessToken(createAccessToken())).toBe(false);
  });

  it("honours ACCESS_CODE", () => {
    expect(getAccessCode()).toBe("2861");
    expect(isValidAccessCode("2861")).toBe(true);
    expect(isValidAccessCode(" 2861 ")).toBe(true);
    expect(isValidAccessCode("2862")).toBe(false);
    expect(isValidAccessCode("")).toBe(false);
    expect(isValidAccessCode(2861)).toBe(false);
    process.env.ACCESS_CODE = "abc123";
    expect(isValidAccessCode("2861")).toBe(false);
    expect(isValidAccessCode("abc123")).toBe(true);
  });
});

describe("access token", () => {
  it("round-trips and expires", () => {
    const now = 1_700_000_000_000;
    const t = createAccessToken(now);
    expect(verifyAccessToken(t, now)).toBe(true);
    expect(verifyAccessToken(t, now + (ACCESS_TTL_SECONDS - 1) * 1000)).toBe(true);
    expect(verifyAccessToken(t, now + ACCESS_TTL_SECONDS * 1000)).toBe(false);
  });

  it("rejects tampering, garbage and over-long lifetimes", () => {
    const now = Date.now();
    const t = createAccessToken(now);
    const [v, exp, sig] = t.split(".");
    expect(verifyAccessToken(`${v}.${Number(exp) + 1}.${sig}`, now)).toBe(false);
    expect(verifyAccessToken(`${v}.${exp}.${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`, now)).toBe(false);
    expect(verifyAccessToken("", now)).toBe(false);
    expect(verifyAccessToken("1", now)).toBe(false);
    expect(verifyAccessToken(undefined, now)).toBe(false);
    // Validly signed but claiming 10 years: never issued, so never accepted.
    expect(verifyAccessToken(createAccessToken(now + 10 * 365 * 86400_000), now)).toBe(false);
  });

  it("is invalidated by rotating the code or the secret", () => {
    const t = createAccessToken();
    process.env.ACCESS_CODE = "9999";
    expect(verifyAccessToken(t)).toBe(false);
    process.env.ACCESS_CODE = "2861";
    expect(verifyAccessToken(t)).toBe(true);
    process.env.ACCESS_COOKIE_SECRET = "a-different-secret";
    expect(verifyAccessToken(t)).toBe(false);
  });
});

describe("rate limiter", () => {
  it("caps attempts per key per window", () => {
    const rl = createRateLimiter(3, 1000);
    expect(rl.hit("a", 0).allowed).toBe(true);
    expect(rl.hit("a", 1).allowed).toBe(true);
    expect(rl.hit("a", 2).allowed).toBe(true);
    expect(rl.hit("a", 3).allowed).toBe(false);
    expect(rl.hit("b", 3).allowed).toBe(true);
    expect(rl.hit("a", 1001).allowed).toBe(true);
    rl.hit("a", 1002);
    rl.hit("a", 1003);
    rl.reset("a");
    expect(rl.hit("a", 1004).allowed).toBe(true);
  });

  it("reads the client ip from x-forwarded-for", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("gate page", () => {
  it("never contains the access code and escapes the error/next", () => {
    process.env.ACCESS_CODE = "secret-code-xyz";
    const html = renderGatePage({ error: "<b>x</b>", next: '/a"><script>' });
    expect(html).not.toContain("secret-code-xyz");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain('/a"><script>');
    expect(html).toContain("Enter access code");
  });

  it("only allows same-origin return paths", () => {
    expect(safeNextPath("/margin?x=1")).toBe("/margin?x=1");
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("/\\evil.com")).toBe("/");
    expect(safeNextPath("/api/pools")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });
});

describe("proxy", () => {
  const req = (path: string, cookie?: string) =>
    new NextRequest(new URL(path, "http://localhost:3100"), {
      headers: cookie ? { cookie: `${ACCESS_COOKIE_NAME}=${cookie}` } : {},
    });

  it("serves the gate for pages and 401 for APIs without a cookie", async () => {
    const page = proxy(req("/margin"));
    expect(page.status).toBe(401);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Enter access code");

    const api = proxy(req("/api/pools"));
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ error: "access_required" });

    expect(proxy(req("/api/pools", "v1.1.bad")).status).toBe(401);
  });

  it("lets through exempt paths, static files and valid cookies", () => {
    const passes = (r: Response) => r.headers.get("x-middleware-next") === "1";
    expect(passes(proxy(req("/api/access")))).toBe(true);
    expect(passes(proxy(req("/api/copilot/health")))).toBe(true);
    expect(passes(proxy(req("/logos/vanna.png")))).toBe(true);
    expect(passes(proxy(req("/coins/sol.svg")))).toBe(true);
    // A static-looking API path is still gated.
    expect(proxy(req("/api/foo.png")).status).toBe(401);
    const token = createAccessToken();
    expect(passes(proxy(req("/", token)))).toBe(true);
    expect(passes(proxy(req("/api/pools", token)))).toBe(true);
  });
});

describe("POST /api/access", () => {
  const post = (body: unknown, ip: string) =>
    POST(
      new Request("http://localhost:3100/api/access", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(body),
      }),
    );

  it("rejects a wrong code and sets a signed httpOnly cookie for the right one", async () => {
    const bad = await post({ code: "0000" }, "9.9.9.1");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();

    const ok = await post({ code: "2861" }, "9.9.9.1");
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${ACCESS_COOKIE_NAME}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    const value = setCookie.split(";")[0].split("=")[1];
    expect(verifyAccessToken(value)).toBe(true);
  });

  it("rate limits repeated attempts from one IP", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) last = await post({ code: "1111" }, "9.9.9.2");
    expect(last?.status).toBe(429);
    // Even the right code is refused while limited.
    expect((await post({ code: "2861" }, "9.9.9.2")).status).toBe(429);
  });

  it("handles a no-JS form post with a 303 back to the page", async () => {
    const res = await POST(
      new Request("http://localhost:3100/api/access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "9.9.9.3" },
        body: new URLSearchParams({ code: "2861", next: "/earn" }).toString(),
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/earn");
    expect(res.headers.get("set-cookie")).toContain(`${ACCESS_COOKIE_NAME}=`);
  });
});
