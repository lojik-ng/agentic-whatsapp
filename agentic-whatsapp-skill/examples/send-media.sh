#!/usr/bin/env bash
# Send an image / video / document with optional caption, optionally as a reply.
#
# Required environment:
#   WHATSAPP_API_URL  — base URL
#   WHATSAPP_API_KEY  — API key
#   PHONE             — recipient phone number
#   FILE              — path to the local file to send
#
# Optional environment:
#   CAPTION           — caption text
#   MESSAGE_ID        — messageId to reply to
#
# Usage:
#   PHONE='+1 (234) 567-890' FILE=/tmp/photo.jpg CAPTION='look at this' ./send-media.sh

set -euo pipefail

: "${WHATSAPP_API_URL:?Set WHATSAPP_API_URL}"
: "${WHATSAPP_API_KEY:?Set WHATSAPP_API_KEY}"
: "${PHONE:?Set PHONE}"
: "${FILE:?Set FILE — path to the file to send}"

args=(
  -sS -X POST
  -H "x-api-key: $WHATSAPP_API_KEY"
  -F "to=$PHONE"
  -F "media=@$FILE"
)
[[ -n "${CAPTION:-}" ]] && args+=( -F "caption=$CAPTION" )
[[ -n "${MESSAGE_ID:-}" ]] && args+=( -F "quotedMessageId=$MESSAGE_ID" )

curl "${args[@]}" "$WHATSAPP_API_URL/send/media"
echo
