#!/bin/bash
# GCE startup script for the liquidator VM (runs as root on every boot).
# Installs Docker once, fetches the keypair from Secret Manager into tmpfs, pulls the image and
# (re)starts the container with --restart=always. Settings come from instance metadata:
#   liquidator-image   Artifact Registry image, e.g. us-central1-docker.pkg.dev/<project>/vanna-credit/liquidator:<tag>
#   liquidator-secret  Secret Manager secret holding the keypair JSON (default: liquidator-keypair)
#   liquidator-env     newline-separated KEY=VALUE bot settings (DRY_RUN, POLL_MS, TELEGRAM_CHAT_ID, ...)
#   liquidator-telegram-secret  optional: Secret Manager secret holding the Telegram bot token
set -euo pipefail

md() { curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true; }

IMAGE="$(md liquidator-image)"
SECRET="$(md liquidator-secret)"; SECRET="${SECRET:-liquidator-keypair}"
TG_SECRET="$(md liquidator-telegram-secret)"
[ -n "$IMAGE" ] || { echo "liquidator: no liquidator-image metadata, nothing to run"; exit 0; }

if ! command -v docker >/dev/null; then
  apt-get update -y
  apt-get install -y docker.io
  systemctl enable --now docker
fi

# On boot Docker restarts the old container (--restart=always) before this script runs, while
# the tmpfs is still empty, and creates each missing bind-mount source as a DIRECTORY. Stop it and
# clear those first, then write the secrets and start it again below.
docker rm -f liquidator >/dev/null 2>&1 || true
for f in /run/liquidator/keypair.json /run/liquidator/telegram-token; do [ -d "$f" ] && rm -rf "$f"; done

# The keypair lives only in memory (tmpfs), readable by the container's user (node, uid 1000).
mkdir -p /run/liquidator
mountpoint -q /run/liquidator || mount -t tmpfs -o size=1m,mode=0700 tmpfs /run/liquidator
gcloud secrets versions access latest --secret="$SECRET" > /run/liquidator/keypair.json
chown 1000:1000 /run/liquidator /run/liquidator/keypair.json
chmod 0400 /run/liquidator/keypair.json

TG_ARGS=()
if [ -n "$TG_SECRET" ]; then
  gcloud secrets versions access latest --secret="$TG_SECRET" > /run/liquidator/telegram-token
  chown 1000:1000 /run/liquidator/telegram-token
  chmod 0400 /run/liquidator/telegram-token
  TG_ARGS=(-e TELEGRAM_BOT_TOKEN_PATH=/run/liquidator/telegram-token -v /run/liquidator/telegram-token:/run/liquidator/telegram-token:ro)
fi

md liquidator-env > /run/liquidator/bot.env

REGISTRY="${IMAGE%%/*}"
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "https://$REGISTRY"
docker pull "$IMAGE"

docker rm -f liquidator >/dev/null 2>&1 || true
docker run -d --name liquidator --restart=always \
  --log-driver=gcplogs \
  --env-file /run/liquidator/bot.env \
  -e LIQUIDATOR_KEYPAIR_PATH=/run/liquidator/keypair.json \
  -v /run/liquidator/keypair.json:/run/liquidator/keypair.json:ro \
  "${TG_ARGS[@]}" \
  "$IMAGE"
echo "liquidator: started $IMAGE"
