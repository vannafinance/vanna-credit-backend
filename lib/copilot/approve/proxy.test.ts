import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/copilot/plan/[planId]/route";
import { POST } from "@/app/api/copilot/plan/[planId]/[action]/route";
import { clientIp } from "./proxy";

const PLAN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
const view = (planId: string) => ({ params: Promise.resolve({ planId }) });
const act = (planId: string, action: string) => ({ params: Promise.resolve({ planId, action }) });

function upstreamReturning(body: unknown, status = 200, headers: Record<string, string> = {}) {
  // The (url, init) signature types `mock.calls` for the assertions below.
  return vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
}

beforeEach(() => {
  vi.stubEnv("MCP_PLAN_API_URL", "http://127.0.0.1:8000/");
  vi.stubEnv("PLAN_PROXY_SECRET", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("/api/copilot/plan proxy", () => {
  it("forwards a view to the MCP's plan API and returns its answer, never cached", async () => {
    const fetchMock = upstreamReturning({ plan_id: PLAN, status: "awaiting_approval" });
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(new Request(`http://site.test/api/copilot/plan/${PLAN}`), view(PLAN));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ plan_id: PLAN });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`http://127.0.0.1:8000/api/plan/${PLAN}`);
    expect(init?.method).toBe("GET");
  });

  it("forwards the run token and the body of a same-origin POST, and passes the MCP's status through", async () => {
    const fetchMock = upstreamReturning({ error: "not_authorized", message: "Confirm with your wallet." }, 401);
    vi.stubGlobal("fetch", fetchMock);
    const req = new Request(`http://site.test/api/copilot/plan/${PLAN}/next`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json", origin: "http://site.test", host: "site.test", "x-plan-token": "tok" },
    });
    const res = await POST(req, act(PLAN, "next"));
    expect(res.status).toBe(401);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Plan-Token"]).toBe("tok");
    expect(init.body).toBe("{}");
  });

  it("refuses a cross-site POST, an unknown action and a malformed plan id without calling the MCP", async () => {
    const fetchMock = upstreamReturning({});
    vi.stubGlobal("fetch", fetchMock);
    const cross = new Request(`http://site.test/api/copilot/plan/${PLAN}/approve`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json", origin: "https://evil.example", host: "site.test" },
    });
    expect((await POST(cross, act(PLAN, "approve"))).status).toBe(403);
    const same = { method: "POST", body: "{}", headers: { "content-type": "application/json", origin: "http://site.test", host: "site.test" } };
    expect((await POST(new Request(`http://site.test/api/copilot/plan/${PLAN}/delete`, same), act(PLAN, "delete"))).status).toBe(404);
    expect((await GET(new Request("http://site.test/api/copilot/plan/x"), view("../../oauth"))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps the body and requires a JSON object", async () => {
    vi.stubGlobal("fetch", upstreamReturning({}));
    const big = new Request(`http://site.test/api/copilot/plan/${PLAN}/submit`, {
      method: "POST", body: JSON.stringify({ signed: "x".repeat(20_000) }), headers: { "content-type": "application/json", host: "site.test" },
    });
    expect((await POST(big, act(PLAN, "submit"))).status).toBe(413);
    const bad = new Request(`http://site.test/api/copilot/plan/${PLAN}/submit`, { method: "POST", body: "[1]", headers: { host: "site.test" } });
    expect((await POST(bad, act(PLAN, "submit"))).status).toBe(400);
  });

  it("is off without an upstream, and never proxies to plain http outside localhost", async () => {
    const fetchMock = upstreamReturning({});
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MCP_PLAN_API_URL", "");
    expect((await GET(new Request(`http://site.test/api/copilot/plan/${PLAN}`), view(PLAN))).status).toBe(503);
    vi.stubEnv("MCP_PLAN_API_URL", "http://mcp.example");
    expect((await GET(new Request(`http://site.test/api/copilot/plan/${PLAN}`), view(PLAN))).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the shared secret and the user's address only when PLAN_PROXY_SECRET is set", async () => {
    const fetchMock = upstreamReturning({ plan_id: PLAN });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("PLAN_PROXY_SECRET", "s3cret");
    await GET(new Request(`http://site.test/api/copilot/plan/${PLAN}`, { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.5" } }), view(PLAN));
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Vanna-Proxy-Secret"]).toBe("s3cret");
    expect(headers["X-Vanna-Client-Ip"]).toBe("203.0.113.5"); // the hop Cloud Run appended, not a client-supplied one
  });

  it("answers 502 in plain words when the MCP is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const res = await GET(new Request(`http://site.test/api/copilot/plan/${PLAN}`), view(PLAN));
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/Nothing was sent/);
  });

  it("takes the right-most forwarded address", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } }))).toBe("2.2.2.2");
    expect(clientIp(new Request("http://x"))).toBe("");
  });
});
