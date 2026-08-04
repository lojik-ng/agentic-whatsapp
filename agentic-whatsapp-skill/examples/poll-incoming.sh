#!/usr/bin/env bash
# Poll for new incoming messages, printing each batch as it arrives.
# Persists the last-seen timestamp across iterations in $CURSOR_FILE.
#
# Required environment:
#   WHATSAPP_API_URL    — base URL of the API
#   WHATSAPP_API_KEY    — API key from .env
#
# Optional environment:
#   CURSOR_FILE         — file used to persist last-seen timestamp (default: /tmp/whatsapp-poll.cursor)
#   INTERVAL_SECONDS    — sleep between polls (default: 5)
#
# Usage:
#   ./poll-incoming.sh        # run forever
#   INTERVAL_SECONDS=10 ./poll-incoming.sh

set -euo pipefail

: "${WHATSAPP_API_URL:?Set WHATSAPP_API_URL}"
: "${WHATSAPP_API_KEY:?Set WHATSAPP_API_KEY}"

CURSOR_FILE="${CURSOR_FILE:-/tmp/whatsapp-poll.cursor}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-5}"

last_seen=0
if [[ -f "$CURSOR_FILE" ]]; then
  last_seen="$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)"
fi

echo "Polling $WHATSAPP_API_URL/incoming-messages since=$last_seen ..."
while true; do
  resp="$(curl -sS -H "x-api-key: $WHATSAPP_API_KEY" \
    "$WHATSAPP_API_URL/incoming-messages?since=$last_seen")"

  count=$(echo "$resp" | jq -r '.count // 0')
  if [[ "$count" -gt 0 ]]; then
    echo "---"
    echo "$resp" | jq '.messages'
    last_seen=$(echo "$resp" | jq -r '.fetchedAt // empty')
    [[ -n "$last_seen" ]] && echo "$last_seen" > "$CURSOR_FILE"
  fi

  sleep "$INTERVAL_SECONDS"
done
