# ---- Vanna liquidator bot · long-running worker (GCE VM, Docker --restart=always) ----
# Build from the repo root:  docker build -f bot/liquidator/Dockerfile -t liquidator .
# The bot runs TypeScript with tsx (a dev dependency) and shares lib/ with the app, so the whole
# repo (minus .dockerignore) goes in; no Next.js build is needed.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
USER node
# Settings come from the environment (bot/liquidator/README.md); the keypair is mounted read-only
# at LIQUIDATOR_KEYPAIR_PATH by the VM startup script.
CMD ["npx", "tsx", "bot/liquidator/index.ts"]
