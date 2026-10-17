import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // This repo sits beside another package-lock.json. Pin tracing/build scope
    // to this application instead of letting Next infer the parent workspace.
    root: process.cwd(),
  },
  // Emit a self-contained .next/standalone/server.js (only the traced runtime
  // deps) so the Cloud Run container image stays slim. Required by the Docker
  // build — without it there is no standalone server to copy into the runner.
  output: "standalone",

  // /trade/perps has no page of its own: open the default market. Done here rather than with a
  // redirect() page, which trips Next's dev-mode timing ("cannot have a negative time stamp").
  async redirects() {
    return [{ source: "/trade/perps", destination: "/trade/perps/ethusdc", permanent: false }];
  },

  // The approve page signs plans an AI client drew through the public MCP: never framed (no clickjacking of the
  // wallet prompt), never cached, and its URL (a plan's capability id) never sent on as a referrer.
  async headers() {
    const strict = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "no-store" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
    ];
    return [
      { source: "/approve/:path*", headers: strict },
      { source: "/api/copilot/plan/:path*", headers: strict },
    ];
  },

  compiler: {
    // Strip console.* from production bundles at build time so the 167 dev log
    // calls across the app never ship to users — smaller bundles, no main-thread
    // logging cost, and no internal detail leaked in the console. console.error
    // is kept so genuine production errors remain visible (e.g. to monitoring).
    // Dev builds keep all logging.
    removeConsole:
      process.env.NODE_ENV === "production" ? { exclude: ["error"] } : false,
  },
};

export default nextConfig;
