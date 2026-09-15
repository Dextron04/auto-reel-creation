#!/bin/sh
set -eu

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

if [ ! -f .env.prod ]; then
  echo "Missing $REPO_ROOT/.env.prod" >&2
  exit 1
fi

echo "Running renderer regression suite..."
npm --prefix renderer test

echo "Running dashboard regression suite..."
npm --prefix dashboard test

echo "Running n8n workflow regression suite..."
node --test n8n/workflows/research-workflow.test.mjs

echo "Running deployment regression suite..."
node --test scripts/update-production-checkout.test.mjs

echo "Rebuilding and restarting containers..."
docker compose up -d --build --remove-orphans

check() {
  name=$1
  url=$2
  attempt=1
  while [ "$attempt" -le 30 ]; do
    if curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
      echo "$name is healthy ($url)."
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  echo "$name health check failed ($url)." >&2
  return 1
}

status=0
check renderer http://127.0.0.1:3001/health || status=1
check n8n http://127.0.0.1:5678/healthz || status=1
check dashboard http://127.0.0.1:4000/health || status=1

if [ "$status" -ne 0 ]; then
  echo "--- container status ---" >&2
  docker compose ps >&2
  echo "--- recent logs ---" >&2
  docker compose logs --tail=100 renderer n8n dashboard >&2
  exit 1
fi

echo "Syncing n8n workflow definitions..."
set -a
. ./.env.prod
set +a
for workflow in n8n/workflows/*.json; do
  node scripts/sync-n8n-workflow.mjs "$workflow"
done

echo "auto-reel-creation deployment is healthy."
