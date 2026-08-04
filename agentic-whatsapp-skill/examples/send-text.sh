#!/usr/bin/env bash
# Send a single text message via the agentic-whatsapp API.
#
# Required environment:
#   WHATSAPP_API_URL  — base URL, e.g. http://localhost:3056 (no trailing slash)
#   WHATSAPP_API_KEY  — the API key configured in the container
#
# Usage:
#   PHONE='+1 (234) 567-890' MESSAGE='Hello world' ./send-text.sh

set -euo pipefail

: "${WHATSAPP_API_URL:?Set WHATSAPP_API_URL — base URL of the agentic-whatsapp API}"
: "${WHATSAPP_API_KEY:?Set WHATSAPP_API_KEY — the API key from the .env file}"
: "${PHONE:?Set PHONE — recipient phone number}"
: "${MESSAGE:?Set MESSAGE — message text}"

curl -sS -X POST \
  -H "x-api-key: $WHATSAPP_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg to "$PHONE" --arg body "$MESSAGE" '{to:$to, body:$body}')" \
  "$WHATSAPP_API_URL/send/text"
echo
