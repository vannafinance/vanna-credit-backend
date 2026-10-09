# ---- Vanna Credit (Solana) · production image for Cloud Run ----
# Multi-stage. Next.js 16 standalone output (next.config.ts `output: "standalone"`).

# 1. deps
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci

# 2. builder
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# NEXT_PUBLIC_* are inlined into the browser bundle at BUILD time (cloudbuild.yaml passes them).
# Defaults match the test deployment. An empty value (how Cloud Build sends an unset optional) is
# unset before the build so the app's own `?? fallback` applies instead of a baked "".
ARG NEXT_PUBLIC_SITE_URL=https://test.solana.vanna.finance
ARG NEXT_PUBLIC_SOLANA_RPC_URL=https://rpc-devnet.solana.vanna.finance
ARG NEXT_PUBLIC_SOLANA_WS_URL=wss://rpc-devnet.solana.vanna.finance
ARG NEXT_PUBLIC_VANNA_PROGRAM_ID=H37YVBG3eGtz89ofd7iDLc2PJgn12778392XeU2QJcGC
RUN set -eu; \
    for v in NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_SOLANA_RPC_URL NEXT_PUBLIC_SOLANA_WS_URL NEXT_PUBLIC_VANNA_PROGRAM_ID; do \
      if [ -n "$(printenv "$v" || true)" ]; then echo "  set    $v=$(printenv "$v")"; \
      else unset "$v"; echo "  unset  $v (app default applies)"; fi; \
    done; \
    npm run build

# 3. runner (minimal)
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run injects PORT=8080; the Next standalone server honours PORT + HOSTNAME.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static     ./.next/static
COPY --from=builder /app/public           ./public
RUN chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
