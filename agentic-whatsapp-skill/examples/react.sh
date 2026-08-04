#!/usr/bin/env bash
# React to a message with an emoji. Use empty REACTION to clear.
#
# Required environment:
#   WHATSAPP_API_URL  — base URL
#   WHATSAPP_API_KEY  — API key
#   MESSAGE_ID        — numeric DB id or WhatsApp messageId
#   REACTION          — the emoji to react with (empty string to remove)
#
# Usage:
#   MESSAGE_ID=14 REACTION='❤️' ./react.sh
#   MESSAGE_ID=14 REACTION='' ./react.sh     # clear reaction

set -euo pipefail

: "${WHATSAPP_API_URL:?Set WHATSAPP_API_URL}"
: "${WHATSAPP_API_KEY:?Set WHATSAPP_API_KEY}"
: "${MESSAGE_ID:?Set MESSAGE_ID}"
: "${REACTION:?Set REACTION — the emoji, or empty string to clear}"

curl -sS -X POST \
  -H "x-api-key: $WHATSAPP_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg r "$REACTION" '{reaction:$r}')" \
  "$WHATSAPP_API_URL/messages/$MESSAGE_ID/react"
echo
