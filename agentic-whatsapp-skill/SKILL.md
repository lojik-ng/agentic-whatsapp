---
name: agentic-whatsapp
description: Send and receive WhatsApp messages, media, stickers, and reactions through the agentic-whatsapp HTTP API (a self-hosted whatsapp-web.js wrapper). Use this skill whenever the user asks to read, send, reply to, react to, or monitor WhatsApp messages — including images, audio, video, documents, and .webp stickers. On first use, the skill must request the API base URL and API key from the user and persist them as environment variables named `WHATSAPP_API_URL` and `WHATSAPP_API_KEY` before any call.
metadata:
  type: tool-integration
  domain: messaging / whatsapp
  transport: http
---

# agentic-whatsapp

A self-hosted WhatsApp REST API. This skill lets an agent send and receive WhatsApp messages — text, media, stickers, reactions, replies — on behalf of the user, through HTTP calls. The agent must always authenticate with the user's API key.

## 0. First-run setup (mandatory)

Before doing anything else, the agent must confirm two values with the user:

1. **Base URL** — where the agentic-whatsapp container is reachable. Examples:
   - `http://localhost:3056` (running on the same machine)
   - `http://192.168.1.10:3056` (LAN)
   - `https://wa.example.com` (reverse-proxied)
2. **API key** — the value of `WHATSAPP_API_KEY` configured in the container's `.env` file. It is the same string used to access the QR-login page (`http://<url>/qr/<api-key>`).

Ask once, then **persist them for the rest of the session** as:

```text
WHATSAPP_API_URL   = <user-supplied base URL, no trailing slash>
WHATSAPP_API_KEY   = <user-supplied API key>
```

Every request below uses these two values. If the user later changes one of them, update the agent's stored values before continuing.

If either value is missing or the user has not provided it, **stop and ask** — do not attempt to call the API.

## 1. Connection check

Before running any other workflow, verify the API is reachable:

```bash
curl -fsS "$WHATSAPP_API_URL/status"
```

If it returns, for example:

```json
{ "status": "READY", "readySince": ..., "hasQr": false, ... }
```

…then the client is authenticated and ready. Proceed normally.

If `hasQr` is `true` or `status` is not `READY`, **stop and tell the user**:

> The WhatsApp client is not authenticated yet. Open `http://<host>/qr/<api-key>` in a browser and scan the QR code with WhatsApp on your phone (Settings → Linked Devices → Link a Device). Wait until the page shows "Connected", then ask me to continue.

Do not try to send messages while the client is not `READY`. They will fail with a 5xx error.

If the connection itself fails (DNS, refused, TLS error, etc.), surface the underlying error to the user verbatim and ask them to confirm the URL.

## 2. Authentication

Every authenticated request must include the API key, in one of three ways:

```bash
# Preferred: HTTP header
-H "x-api-key: $WHATSAPP_API_KEY"

# Or: query string
"?apiKey=$WHATSAPP_API_KEY"

# Or: JSON body field
{ "apiKey": "$WHATSAPP_API_KEY" }
```

All examples in this skill use the header form. The two unauthenticated endpoints are `GET /status` and `GET /qr/<api-key>...`.

## 3. Phone-number handling — automatic

The API **always** sanitises the recipient. The agent does not need to format `to` values manually. The following all resolve to the same WhatsApp chat id:

| Input | What gets used |
|-------|----------------|
| `+1 (234) 567-890` | `1234567890@c.us` |
| `+44 7123 456789` | `447123456789@c.us` |
| `1234567890` | `1234567890@c.us` |
| `1234567890@c.us` | passed through |
| `120363123456789@g.us` (group id) | passed through |

The agent may pass any of these forms safely. Group ids (ending in `@g.us`) are preserved unchanged. Use the same convention for any phone number or chat id mentioned by the user.

## 4. Endpoints

The base URL is `$WHATSAPP_API_URL`. Use `Authorization` via `x-api-key` header in all examples.

### 4.1 `GET /status` — *public*

Returns the client state. Always safe to call.

```bash
curl -s "$WHATSAPP_API_URL/status"
```

Response fields:

| Field | Meaning |
|-------|---------|
| `status` | `INITIALIZING` / `AUTHENTICATED` / `READY` / `DISCONNECTED` / `AUTH_FAILURE` |
| `readySince` | Unix-ms when `READY` was first reached (else `null`) |
| `hasQr` | `true` when a QR code is currently being shown |
| `lastEventAt` | Unix-ms of the most recent state change |

### 4.2 `GET /incoming-messages` — *authenticated*

Polled by the agent to retrieve messages that arrived in a look-back window. The server stores incoming messages in SQLite, so messages survive container restarts.

Query parameters:

| Name | Default | Notes |
|------|---------|-------|
| `minutes` | `60` | Look-back window in minutes |
| `since` | (none) | Unix-ms — return only items newer than this. Use it to implement "fetch only what's new" loops. |
| `includeReceipts` | `false` | Set to `1` to also include message-ack (delivered/read) events |
| `limit` | `1000` | Max messages returned (max 5000) |

```bash
curl -s -H "x-api-key: $WHATSAPP_API_KEY" \
  "$WHATSAPP_API_URL/incoming-messages?minutes=5"
```

Response shape:

```jsonc
{
  "fetchedAt": 1700000000000,
  "count": 2,
  "messages": [
    {
      "id": 14,                                      // numeric DB id
      "messageId": "false_447123456789@c.us_AB12",   // WhatsApp msg id (use this for replies)
      "from": "447123456789@c.us",                   // sender
      "fromName": "Alice",                           // display name when known
      "chatId": "447123456789@c.us",
      "type": "chat",                                // chat | image | video | ptv | audio | document | sticker | vcard | location | ...
      "body": "Hello",
      "hasMedia": false,
      "mimetype": null,
      "filename": null,
      "timestamp": 1700000000000,                    // when sent by sender (ms)
      "receivedAt": 1700000000123                    // when the API received it (ms)
    }
  ],
  "receipts": [ /* present only when includeReceipts=1 */ ]
}
```

For an efficient poll loop, persist the last `fetchedAt` you observed and pass it as `since` next time.

### 4.3 `GET /messages/:id/media` — *authenticated*

Fetch the on-demand media bytes for a stored message. `:id` may be either the numeric DB `id` or the WhatsApp `messageId`. The body is the binary file with the correct `Content-Type`.

```bash
# Save an image received in message id 15
curl -s -H "x-api-key: $WHATSAPP_API_KEY" \
  -o /tmp/picture.jpg \
  "$WHATSAPP_API_URL/messages/15/media"
```

If the message has no media, returns 404. Media bytes are **never** stored on disk by the server — this endpoint downloads them straight from WhatsApp.

### 4.4 `POST /send/text` — *authenticated*

Send a plain text message (optionally as a reply).

Body parameters:

| Field | Required | Description |
|-------|----------|-------------|
| `to` | yes | Recipient — anything that can be sanitised |
| `body` | yes | Message text |
| `quotedMessageId` | no | `messageId` of a previous incoming message to reply to |

```bash
curl -s -H "x-api-key: $WHATSAPP_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"+1 (234) 567-890","body":"Hello"}' \
  "$WHATSAPP_API_URL/send/text"
```

### 4.5 `POST /send/reply` — *authenticated*

Convenience wrapper around `/send/text` that **requires** a quote.

```bash
curl -s -H "x-api-key: $WHATSAPP_API_KEY" -H "Content-Type: application/json" \
  -d '{
        "to": "+1 (234) 567-890",
        "body": "Got it, thanks!",
        "quotedMessageId": "false_447123456789@c.us_AB12"
      }' \
  "$WHATSAPP_API_URL/send/reply"
```

### 4.6 `POST /send/media` — *authenticated*

Send media using `multipart/form-data`. The file must be uploaded under the field name `media`.

Form fields:

| Field | Required | Description |
|-------|----------|-------------|
| `media` | yes | The file to send |
| `to` | yes | Recipient |
| `caption` | no | Caption text (ignored for stickers) |
| `quotedMessageId` | no | Reply to a specific message |
| `type` | no | Force interpretation. Use `sticker` for `.webp` stickers. |

```bash
# Send a photo with caption
curl -s -H "x-api-key: $WHATSAPP_API_KEY" \
  -F "to=+1 (234) 567-890" \
  -F "caption=Look at this" \
  -F "media=@/tmp/picture.jpg" \
  "$WHATSAPP_API_URL/send/media"

# Send a video
curl -s -H "x-api-key: $WHATSAPP_API_KEY" \
  -F "to=+1 (234) 567-890" \
  -F "media=@/tmp/clip.mp4" \
  "$WHATSAPP_API_URL/send/media"

# Reply to a specific message with an image
curl -s -H "x-api-key: $WHATSAPP_API_KEY" \
  -F "to=+1 (234) 567-890" \
  -F 'quotedMessageId=false_447123456789@c.us_AB12' \
  -F "media=@/tmp/picture.jpg" \
  "$WHATSAPP_API_URL/send/media"
```

### 4.7 `POST /send/sticker` — *authenticated*

Shortcut for sending `.webp` stickers. The file is treated as a sticker (not a generic image).

```bash
curl -s -H "x-api-key: $WHATSAPP_API_KEY" \
  -F "to=+1 (234) 567-890" \
  -F "media=@/tmp/sticker.webp" \
  "$WHATSAPP_API_URL/send/sticker"
```

### 4.8 `POST /messages/:id/react` — *authenticated*

Send a reaction emoji. Use an empty string to remove a reaction. `:id` is a numeric DB id or a WhatsApp `messageId`.

```bash
curl -s -X POST -H "x-api-key: $WHATSAPP_API_KEY" -H "Content-Type: application/json" \
  -d '{"reaction":"❤️"}' \
  "$WHATSAPP_API_URL/messages/14/react"
```

### 4.9 `GET /me` — *authenticated*

Information about the authenticated WhatsApp client:

```bash
curl -s -H "x-api-key: $WHATSAPP_API_KEY" "$WHATSAPP_API_URL/me"
```

Returns `{ id, pushname, platform, phone }`.

### 4.10 `POST /logout` — *authenticated*

Clear the local session and log out of WhatsApp. The user will have to re-scan a QR code to log back in.

```bash
curl -s -X POST -H "x-api-key: $WHATSAPP_API_KEY" "$WHATSAPP_API_URL/logout"
```

## 5. Common workflows for the agent

### 5.1 Send a one-off message

```bash
# 1. Verify the client is ready
status=$(curl -s "$WHATSAPP_API_URL/status" | grep -o '"status":"[A-Z_]*"' | head -1)
[ "$status" = '"status":"READY"' ] || { echo "Not ready"; exit 1; }

# 2. Send
curl -s -H "x-api-key: $WHATSAPP_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"'"$PHONE"'","body":"'"$MESSAGE"'"}' \
  "$WHATSAPP_API_URL/send/text"
```

### 5.2 Poll for new messages (incremental)

Keep a local cursor (e.g. last-seen `fetchedAt`) and pass it as `since`:

```bash
last_seen=0
while true; do
  resp=$(curl -s -H "x-api-key: $WHATSAPP_API_KEY" \
    "$WHATSAPP_API_URL/incoming-messages?since=$last_seen")
  echo "$resp"
  last_seen=$(echo "$resp" | grep -o '"fetchedAt":[0-9]*' | head -1 | cut -d: -f2)
  sleep 5
done
```

### 5.3 Reply to a received message

The `messageId` from an incoming message is the canonical id used for replies:

```bash
msgid="false_447123456789@c.us_AB12"
curl -s -H "x-api-key: $WHATSAPP_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"+44 7123 456789","body":"Got it","quotedMessageId":"'"$msgid"'"}' \
  "$WHATSAPP_API_URL/send/reply"
```

### 5.4 Send an image attachment

```bash
curl -s -H "x-api-key: $WHATSAPP_API_KEY" \
  -F "to=$PHONE" -F "caption=$CAPTION" \
  -F "media=@/path/to/file.jpg" \
  "$WHATSAPP_API_URL/send/media"
```

### 5.5 Send a sticker

```bash
curl -s -H "x-api-key: $WHATSAPP_API_KEY" \
  -F "to=$PHONE" \
  -F "media=@/path/to/sticker.webp" \
  "$WHATSAPP_API_URL/send/sticker"
```

### 5.6 React to a message

```bash
curl -s -X POST -H "x-api-key: $WHATSAPP_API_KEY" -H "Content-Type: application/json" \
  -d '{"reaction":"👍"}' \
  "$WHATSAPP_API_URL/messages/$MESSAGE_NUMERIC_ID/react"
```

### 5.7 Pull a media file that was just received

```bash
curl -s -H "x-api-key: $WHATSAPP_API_KEY" \
  -o received.bin \
  "$WHATSAPP_API_URL/messages/$MESSAGE_NUMERIC_ID/media"
```

Inspect `received.bin` based on its header bytes — they match the WhatsApp media format.

### 5.8 Confirm a number is the user's own (avoid sending to yourself)

Compare the result of `/me` with the message's `from` to filter out self-sent messages, or compare a recipient's chat id with `/me`'s `phone@…` value.

```bash
me=$(curl -s -H "x-api-key: $WHATSAPP_API_KEY" "$WHATSAPP_API_URL/me")
my_phone=$(echo "$me" | grep -o '"phone":"[0-9]*' | cut -d'"' -f4)
echo "Authenticated phone: $my_phone"
```

## 6. Error handling

| Symptom | Likely cause | Agent action |
|---------|--------------|--------------|
| `401` body `Invalid API key` | Wrong `WHATSAPP_API_KEY` | Ask the user for the key again |
| `401` body `API key required` | Missing auth | Add `x-api-key` header (or `?apiKey=` / JSON `apiKey`) |
| `503 Client not ready` | WhatsApp client not authenticated yet | Direct the user to scan the QR at `/qr/<api-key>`, then retry |
| `400 "to" is required` | Missing recipient | Add `to` field |
| `400 "body" is required` | Empty body on `/send/text` | Provide a non-empty `body` |
| `404 Message not found` | Wrong numeric id in `/messages/:id/...` | Re-fetch `/incoming-messages` to get a fresh id |
| Connection refused / DNS error | Wrong `WHATSAPP_API_URL` or container down | Confirm URL with user |
| Media upload fails after a successful text send | Likely media mimetype not supported by WhatsApp | Re-encode (e.g. `.webp` → `.jpg`) or try a smaller file |

**Always surface the response body to the user when something fails.** Do not swallow errors.

## 7. Safety and etiquette

- **Never** send messages on behalf of the user without explicit confirmation for every action involving a recipient who is not the user themselves.
- **Batch confirmations** sensibly: if the user asks for a single send, send it. If they ask for a bulk action, list recipients first.
- **Group messages**: respect that WhatsApp groups are visible to everyone in the group. Confirm before sending.
- **Don't poll forever without a reason.** A polling loop should have a clear goal (e.g., waiting for a reply). When the goal is achieved, stop.
- **PII**: messages, contact numbers, and media may contain PII. Don't log message bodies to shared destinations without the user's consent.

## 8. Quick reference — env vars for the agent session

```text
WHATSAPP_API_URL    = http://localhost:3056     # base URL, no trailing slash
WHATSAPP_API_KEY    = sk-WA-...                 # API key from .env in the agentic-whatsapp container
```

Always read both before any call. If a call fails with 401, ask the user to re-confirm them before retrying.
