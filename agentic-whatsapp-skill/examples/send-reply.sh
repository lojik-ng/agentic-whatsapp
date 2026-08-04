#!/usr/bin/env bash
# Reply to a specific received message (quoted reply).
#
# Required environment:
#   WHATSAPP_API_URL  — base URL
#   WHATSAPP_API_KEY  — API key
#   PHONE             — recipient phone number
#   MESSAGE_ID        — WhatsApp messageId from /incoming-messages
#   REPLY             — the reply text
#
# Usage:
#   PHONE='+1 (234) 567-890' \
#   MESSAGE_ID='false_447123456789@c.us_AB12' \
#   REPLY='Got it, thanks!' \
#   ./send-reply.sh

set -euo pipefail

: "${WHATSAPP_API_URL:?Set WHATSAPP_API_URL}"
: "${WHATSAPP_API_KEY:?Set WHATSAPP_API_KEY}"
: "${PHONE:?Set PHONE}"
: "${MESSAGE_ID:?Set MESSAGE_ID — the messageId to reply to}"
: "${REPLY:?Set REPLY — reply text}"

curl -sS -X POST \
  -H "x-api-key: $WHATSAPP_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
        --arg to "$PHONE" \
        --arg body "$REPLY" \
        --arg qmid "$MESSAGE_ID" \
        '{to:$to, body:$body, quotedMessageId:$qmid}')" \
  "$WHATSAPP_API_URL/send/reply"
echo
