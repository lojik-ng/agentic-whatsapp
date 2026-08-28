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
#   3. docker compose up -d --build using the .env-defined port/image
#   4. Wait for the container to report healthy
#   5. Print a final status snapshot
#
# Idempotent — re-running after a code change is safe.
#
# The container_name, port, and image name are read from .env on the remote
# (CONTAINER_NAME, HOST_PORT, etc.) — see docker-compose.yml for the full
# list. Each deployment repo (SO, DOS) has its own .env with the right values.

set -euo pipefail

LINE="${1:-}"
if [[ "$LINE" != "so" && "$LINE" != "dos" ]]; then
  echo "Usage: $0 <so|dos>" >&2
  exit 1
fi

HOST="102.223.186.142"
USER="leke"
SSH_TARGET="$USER@$HOST"

case "$LINE" in
  so)
    REPO_PATH="/home/leke/agentic-whatsapp"
    PORT=3056
    ;;
  dos)
    REPO_PATH="/home/leke/agentic-whatsapp-DOS"
    PORT=3057
    ;;
esac

echo ">>> Deploying $LINE to $SSH_TARGET:$REPO_PATH"
ssh "$SSH_TARGET" "cd $REPO_PATH && git fetch origin main && git reset --hard origin/main"
ssh "$SSH_TARGET" "cd $REPO_PATH && docker compose up -d --build"

# Wait for healthy. The compose project name is the directory name lowercased
# (docker compose normalizes project names to lowercase). We filter docker ps
# by that project so we never accidentally inspect the other service on the
# same host.
PROJECT_NAME=$(basename "$REPO_PATH" | tr '[:upper:]' '[:lower:]')
echo ">>> Waiting for $PROJECT_NAME container to become healthy..."
for i in {1..30}; do
  STATUS=$(ssh "$SSH_TARGET" "docker ps --filter 'label=com.docker.compose.project=$PROJECT_NAME' --format '{{.Status}}' 2>/dev/null | grep -oE '\\(health[a-z]+\\)' | head -1" || echo "(starting)")
  echo "  attempt $i: $STATUS"
  if [[ "$STATUS" == "(healthy)" ]]; then
    break
  fi
  sleep 2
done

echo ">>> Final status:"
ssh "$SSH_TARGET" "docker ps --filter 'label=com.docker.compose.project=$PROJECT_NAME' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
echo ">>> /health response:"
ssh "$SSH_TARGET" "curl -s http://localhost:$PORT/health || true"
echo ""
