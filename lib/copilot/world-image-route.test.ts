import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/copilot/world-image/route";

afterEach(() => vi.unstubAllGlobals());

describe("/api/copilot/world-image", () => {
  it("fetches a World logo on the server and serves it from this origin", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const fetchMock = vi.fn(async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(new Request("http://x.test/api/copilot/world-image?p=%2Fucl%2Fbarc.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://m.world.xyz/ucl/barc.png");
  });

  it("refuses other paths and anything that is not a raster image", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } })));
    expect((await GET(new Request("http://x.test/api/copilot/world-image?p=%2Fa%2Fb%2Fc.png"))).status).toBe(400);
    expect((await GET(new Request("http://x.test/api/copilot/world-image?p=%2Fucl%2Fodd.gif"))).status).toBe(404);
  });
});
