#!/usr/bin/env bash
# Send a .webp sticker.
#
# Required environment:
#   WHATSAPP_API_URL  — base URL
#   WHATSAPP_API_KEY  — API key
#   PHONE             — recipient phone number
#   FILE              — path to a .webp file
#
# Optional environment:
#   MESSAGE_ID        — messageId to reply to
#
# Usage:
#   PHONE='+1 (234) 567-890' FILE=/tmp/sticker.webp ./send-sticker.sh

set -euo pipefail

: "${WHATSAPP_API_URL:?Set WHATSAPP_API_URL}"
: "${WHATSAPP_API_KEY:?Set WHATSAPP_API_KEY}"
: "${PHONE:?Set PHONE}"
: "${FILE:?Set FILE — path to a .webp sticker}"

args=(
  -sS -X POST
  -H "x-api-key: $WHATSAPP_API_KEY"
  -F "to=$PHONE"
  -F "media=@$FILE"
)
[[ -n "${MESSAGE_ID:-}" ]] && args+=( -F "quotedMessageId=$MESSAGE_ID" )

curl "${args[@]}" "$WHATSAPP_API_URL/send/sticker"
echo
