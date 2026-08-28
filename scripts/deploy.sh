#!/usr/bin/env bash
#
# Deploy the agentic-whatsapp service to a target host.
#
# Usage: scripts/deploy.sh <line>
#   line: 'so' (Sales Officer, port 3056) or 'dos' (Director of Sales, port 3057)
#
# What it does:
#   1. SSH into the host
#   2. git fetch + reset --hard origin/main
#   3. docker compose up -d --build using the right override file
#   4. Wait for the container to report healthy
#   5. Print a final status snapshot
#
# Idempotent — re-running after a code change is safe.

set -euo pipefail

LINE="${1:-}"
if [[ "$LINE" != "so" && "$LINE" != "dos" ]]; then
  echo "Usage: $0 <so|dos>" >&2
  exit 1
fi

HOST="102.223.186.142"

case "$LINE" in
  so)
    REPO_PATH="/home/leke/agentic-whatsapp"
    CONTAINER="agentic-whatsapp"
    COMPOSE_FLAGS="-f docker-compose.yml"
    PORT=3056
    ;;
  dos)
    REPO_PATH="/home/leke/agentic-whatsapp-DOS"
    CONTAINER="agentic-whatsapp-dos"
    COMPOSE_FLAGS="-f docker-compose.yml -f docker-compose.dos.yml"
    PORT=3057
    ;;
esac

echo ">>> Deploying $LINE to $HOST:$REPO_PATH"
ssh "$HOST" "cd $REPO_PATH && git fetch origin main && git reset --hard origin/main"
ssh "$HOST" "cd $REPO_PATH && docker compose $COMPOSE_FLAGS up -d --build"

echo ">>> Waiting for $CONTAINER to become healthy..."
for i in {1..30}; do
  STATUS=$(ssh "$HOST" "docker inspect --format='{{.State.Health.Status}}' $CONTAINER 2>/dev/null" || echo "missing")
  echo "  attempt $i: $STATUS"
  if [[ "$STATUS" == "healthy" ]]; then
    break
  fi
  sleep 2
done

echo ">>> Final status:"
ssh "$HOST" "docker ps --filter name=$CONTAINER --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
echo ">>> /health response:"
ssh "$HOST" "curl -s http://localhost:$PORT/health || true"
echo ""
