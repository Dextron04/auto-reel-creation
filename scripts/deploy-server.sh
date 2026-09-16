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
node --test scripts/dashboard-deployment.test.mjs

echo "Rebuilding containers..."
docker compose build renderer dashboard

# docker compose's in-place recreate (stop -> rename to a temp id-prefixed name -> create ->
# remove old) has been hitting a container-name conflict against itself on this host's colima
# daemon, so recreating a service goes through an explicit stop+remove+create instead, which
# sidesteps that rename step entirely. But recreating BOTH services on every deploy meant a
# dashboard-only change also bounced the renderer mid-render (killed an in-flight n8n render
# request with ECONNRESET) — only recreate a service whose source actually changed since the
# last successful deploy. (Image-id comparison doesn't work here: Docker embeds a build
# timestamp in the image config, so the id changes on every build even with a 100% cache hit.)
STATE_FILE=".deploy-state/last-deployed-commit"
mkdir -p "$(dirname "$STATE_FILE")"
current_commit=$(git rev-parse HEAD)
last_commit=$(cat "$STATE_FILE" 2>/dev/null || true)

recreate_if_source_changed() {
  service=$1
  path=$2
  if [ -z "$last_commit" ] || ! git cat-file -e "$last_commit" 2>/dev/null || ! git diff --quiet "$last_commit" HEAD -- "$path"; then
    echo "$service source changed (or no prior deploy recorded), recreating..."
    docker compose rm -sf "$service"
  else
    echo "$service source unchanged since last deploy, leaving it running."
  fi
}
recreate_if_source_changed renderer renderer/
recreate_if_source_changed dashboard dashboard/

docker compose up -d --remove-orphans

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
if ! node scripts/check-dashboard-status.mjs http://127.0.0.1:4000/api/status; then
  status=1
fi

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

echo "$current_commit" > "$STATE_FILE"
echo "auto-reel-creation deployment is healthy."
