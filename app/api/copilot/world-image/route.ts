import { NextResponse } from "next/server";

import { WORLD_IMAGE_HOST, worldImageUrl } from "@/lib/copilot/world-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A logo is small; anything larger is not one. */
const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 300;
const cache = new Map<string, { type: string; body: ArrayBuffer }>();

/**
 * GET ?p=/<folder>/<file>.png — one World artwork image (team / event logo), fetched on the server and served from
 * this origin (see lib/copilot/world-image.ts). Only World's image host and raster image paths; kept in memory.
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams.get("p") ?? "";
  const url = worldImageUrl(`https://${WORLD_IMAGE_HOST}${p.startsWith("/") ? p : `/${p}`}`);
  if (!url) return new NextResponse(null, { status: 400 });

  let hit = cache.get(url.pathname);
  if (!hit) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "image/*" } });
      const type = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!res.ok || !/^image\/(png|jpeg|webp|gif)$/.test(type)) return new NextResponse(null, { status: 404 });
      const body = await res.arrayBuffer();
      if (body.byteLength > MAX_BYTES) return new NextResponse(null, { status: 404 });
      hit = { type, body };
      cache.set(url.pathname, hit);
      if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    } catch {
      return new NextResponse(null, { status: 502 });
    }
  }
  return new NextResponse(hit.body, {
    headers: {
      "Content-Type": hit.type,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
