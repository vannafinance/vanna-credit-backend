import { describe, expect, it } from "vitest";

import { viaSite, worldImageUrl } from "./world-image";

describe("World artwork through the site's own route", () => {
  it("serves World logos from this origin and leaves other pictures as they are", () => {
    expect(viaSite("https://m.world.xyz/ucl/barc.png")).toBe("/api/copilot/world-image?p=%2Fucl%2Fbarc.png");
    expect(viaSite("/logos-v3/SOL.png")).toBe("/logos-v3/SOL.png");
    expect(viaSite(null)).toBeNull();
  });

  it("accepts only World's host, https and a plain raster image path", () => {
    expect(worldImageUrl("https://m.world.xyz/nfl/acar.png")?.pathname).toBe("/nfl/acar.png");
    for (const bad of [
      "http://m.world.xyz/ucl/barc.png",
      "https://evil.example/ucl/barc.png",
      "https://m.world.xyz.evil.example/ucl/barc.png",
      "https://m.world.xyz/ucl/barc.svg",
      "https://m.world.xyz/a/b/c.png",
      "https://m.world.xyz/ucl/barc.png?x=1",
      "https://m.world.xyz:8443/ucl/barc.png",
      "not a url",
    ])
      expect(worldImageUrl(bad), bad).toBeNull();
    // A dotted path is normalised by URL and still only reaches World's own host.
    expect(worldImageUrl("https://m.world.xyz/../x/y.png")?.host).toBe("m.world.xyz");
  });
});
