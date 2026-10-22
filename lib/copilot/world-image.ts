/**
 * World's market artwork (team / event logos) served through the Copilot's own route.
 *
 * The Predict data points at `https://m.world.xyz/...`. A browser that cannot reach that host (an ISP that redirects
 * it, a blocker, a firewall) would show every logo as a letter. `/api/copilot/world-image` fetches the picture on the
 * server and serves it from the site's own origin, so the logos show wherever the site itself loads.
 */

export const WORLD_IMAGE_HOST = "m.world.xyz";
const WORLD_IMAGE_PATH = /^\/[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_.-]{1,80}\.(png|jpe?g|webp|gif)$/;

/** The World artwork URL if it is one (https, World's host, a plain raster image path); else null. */
export function worldImageUrl(src: string | null | undefined): URL | null {
  if (!src) return null;
  try {
    const u = new URL(src);
    if (u.protocol !== "https:" || u.hostname !== WORLD_IMAGE_HOST || u.port || u.search || u.hash || u.username) return null;
    return WORLD_IMAGE_PATH.test(u.pathname) ? u : null;
  } catch {
    return null;
  }
}

/** The address the page should load: World artwork through the site's route, anything else as given. */
export function viaSite(src: string | null | undefined): string | null {
  if (!src) return null;
  const u = worldImageUrl(src);
  return u ? `/api/copilot/world-image?p=${encodeURIComponent(u.pathname)}` : src;
}
