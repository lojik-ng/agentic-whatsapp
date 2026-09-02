# agentic-whatsapp

A Dockerised WhatsApp API built on [`whatsapp-web.js`](https://github.com/wwebjs/whatsapp-web.js). It exposes a small REST API for sending & receiving messages, media, and stickers, with persistent message history stored in SQLite.

Multi-device is fully supported, video codec compatibility is provided by the official Google Chrome binary shipped inside the container, and the only GUI is a clean, auto-refreshing QR-code page served by the container itself.

---

## Features

- ✅ Multi-device support (via `MultiDevice` aware `whatsapp-web.js`)
- ✅ Send & receive text messages
- ✅ Send & receive media (images, audio, documents, video)
- ✅ Send stickers
- ✅ Quote / reply to existing messages
- ✅ Polling endpoint for receiving messages with persistent SQLite history
- ✅ On-demand media retrieval — nothing is auto-saved to disk
- ✅ React to messages with emojis
- ✅ LocalAuth — session credentials persist across container restarts
- ✅ Google Chrome Stable is installed in the container for video codec support
- ✅ Restart policy: `restart: always`
- ✅ API-key authentication for every API call

---

## Quick start

### 1. Pick an API key

Open `.env` and set `WHATSAPP_API_KEY` to any string you want:

```bash
echo "WHATSAPP_API_KEY=any-string-i-want" > .env
```

The value can be anything (a passphrase, a UUID, the name of your cat). Pick something hard to guess.

### 2. Build & run

```bash
docker compose build
docker compose up -d
```

The container is published on port **`3056`**.

### 3. Authenticate

Visit:

```
http://<host>:3056/qr/<your-api-key>
```

A styled HTML page shows the QR code. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device, and scan it. The page auto-refreshes and indicates "Connected" when the session is established.

After authentication, the session token is stored in the mounted volume `whatsapp-data`, so you can restart the container without re-scanning.

---

## Phone number formatting

`whatsapp-web.js` expects recipients in the form `[country][number]@c.us` (or `@g.us` for groups). To make the API bulletproof, the `to` field is **automatically sanitised**. All of the following are accepted:

| Input                                  | Stored form            |
|----------------------------------------|------------------------|
| `+1 (234) 567-890`                     | `1234567890@c.us`      |
| `+44 7123 456789`                      | `447123456789@c.us`    |
| `1234567890`                           | `1234567890@c.us`      |
| `447123456789@c.us`                    | `447123456789@c.us`    |
| `120363123456789@g.us` (group id)       | unchanged              |

Group ids ending in `@g.us` are passed through unchanged.

---

## Authentication

Every endpoint (except `GET /status` and `GET /qr/<api-key>...`) requires the API key. Three ways to provide it:

| Method         | Example                                    |
|----------------|--------------------------------------------|
| Header         | `x-api-key: <key>`                         |
| Query string   | `?apiKey=<key>`                            |
| JSON body      | `{ "apiKey": "<key>" }`                    |

The `/qr/<api-key>/image.png` and `/qr/<api-key>` endpoints gate access by matching the value of `<api-key>` in the URL path against the configured `WHATSAPP_API_KEY`.

---

## Endpoints

### `GET /status` — *public*

Returns the current connection state of the WhatsApp client.

```bash
curl http://localhost:3056/status
```

Response:

```json
{ "status": "READY", "readySince": 1700000000000, "hasQr": false, "lastEventAt": 1700000012345 }
```

Possible `status` values:

| Status         | Meaning                                                   |
|----------------|-----------------------------------------------------------|
| `INITIALIZING` | Client is booting up                                      |
| `QR_READY`     | (Reported via `hasQr:true` instead — see below)           |
| `AUTHENTICATED`| Authentication finished, client object alive but not yet `READY` |
| `READY`        | Fully ready to send / receive                             |
| `DISCONNECTED` | Connection dropped — restart the container                |
| `AUTH_FAILURE` | Authentication failed — restart the container             |

**Tip**: while the QR code is being shown, the response is `{"status":"INITIALIZING","hasQr":true,...}` (the QR appears with `hasQr: true`).

### `GET /qr/<api-key>` — *public, key in URL*

Renders a styled HTML page with the current QR code. Auto-refreshes every 2 seconds, and switches to a "Connected" message once the client is `READY`.

### `GET /qr/<api-key>/image.png` — *public, key in URL*

Returns the current QR code as a `image/png`. Returns 404 if no QR is currently available.

### `GET /incoming-messages` — *authenticated*

Polled by clients to retrieve received messages and (optionally) acknowledgement events.

Query parameters:

| Name              | Default | Meaning                                                  |
|-------------------|---------|----------------------------------------------------------|
| `minutes`         | `60`    | Look-back window in minutes                              |
| `since`           | (none)  | Unix-ms timestamp — only return items newer than this    |
| `includeReceipts` | `false` | Set to `1` to also return message-ack events             |
| `limit`           | `1000`  | Max messages returned (max 5000)                         |

Example:

```bash
curl -H "x-api-key: $WHATSAPP_API_KEY" "http://localhost:3056/incoming-messages?minutes=5"
```

Response:

```json
{
  "fetchedAt": 1700000000000,
  "count": 2,
  "messages": [
    {
      "id": 14,
      "messageId": "false_447123456789@c.us_ABCD1234",
      "from": "447123456789@c.us",
      "fromName": "Alice",
      "chatId": "447123456789@c.us",
      "type": "chat",
      "body": "Hello",
      "hasMedia": false,
      "timestamp": 1700000000000,
      "receivedAt": 1700000000123
    },
    {
      "id": 15,
      "messageId": "false_447123456789@c.us_ABCD1235",
      "from": "447123456789@c.us",
      "fromName": "Alice",
      "chatId": "447123456789@c.us",
      "type": "image",
      "body": "look at this",
      "hasMedia": true,
      "mimetype": "image/jpeg",
      "filename": "IMG-20240404-WA0001.jpg",
      "timestamp": 1700000001000,
      "receivedAt": 1700000001123
    }
  ],
  "receipts": [
    { "id": 4, "messageId": "true_447123456789@c.us_ABCD1230", "receipt_type": "READ",
      "recipient": "447123456789@c.us", "timestamp": 1700000010000 }
  ]
}
```

Note: the `messageId` is the canonical WhatsApp id (use it for `quotedMessageId` on `/send/text`, etc.).

### `GET /messages/:id/media` — *authenticated*

Fetch the on-demand media content for a previously received message. `:id` may be either:

- the numeric `id` from the `messages` field above, or
- the WhatsApp `messageId` string

The binary body is returned with the appropriate `Content-Type` and a `Content-Disposition: inline` header when a filename is known.

```bash
curl -H "x-api-key: $WHATSAPP_API_KEY" -o image.jpg \
  "http://localhost:3056/messages/15/media"
```

If the message has no media, returns 404.

### `POST /send/text` — *authenticated*

Send a plain text message.

```bash
curl -H "x-api-key: $WHATSAPP_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"+1 (234) 567-890","body":"Hello world"}' \
  http://localhost:3056/send/text
```

Body fields:

| Field             | Required | Description                                                   |
|-------------------|----------|---------------------------------------------------------------|
| `to`              | yes      | Phone number, formatted number, or chat id                    |
| `body`            | yes      | Message text                                                  |
| `quotedMessageId` | no       | The `messageId` (from `/incoming-messages`) to reply to       |

Response:

```json
{ "ok": true, "message": {
  "messageId": "true_447123456789@c.us_DEADBEEF1234",
  "to": "447123456789@c.us", "from": "me", "body": "Hello world",
  "type": "chat", "timestamp": 1700000000000, "ack": 1
}}
```

Error semantics (applies to `/send/text`, `/send/reply`, `/send/media`):

| Status | `code` in body | Meaning | Action |
|--------|----------------|---------|--------|
| 200    | (success)      | Message delivered to WA network. | Check `messageId`. |
| 422    | `LID_UNRESOLVED` | Recipient is a LID that has never messaged this WhatsApp account. | Wait for the recipient to message first, or invite them out-of-band. Retrying won't help. |
| 502    | `SEND_NO_MESSAGE` | `sendMessage` returned no message — session is stale or WA Web rejected the send. | Re-link via `/qr/<api-key>` or POST `/warmup`. Retrying may help. |
| 503    | `NOT_READY`     | Client is not in `READY` state. | Poll `/status` until `status:"READY"`, then retry. |
| 500    | `INTERNAL`     | Unexpected error. | Check server logs. |

The previous contract returned HTTP 200 with `message: null` whenever
`sendMessage` silently resolved to no value — that hid real outages behind
a misleading "ok". The new contract surfaces every failure mode as a
distinct status + code.

### `POST /warmup` — *authenticated*

Force WhatsApp Web to load all contacts into its in-memory map. The WA-side
contact store starts empty after every fresh READY; without warm-up, the
first round of outbound sends pays a slow page round-trip per recipient
and produces intermittent `No LID for user` errors.

```bash
curl -H "x-api-key: $WHATS...KEY" -X POST http://localhost:3056/warmup
```

Response:

```json
{ "ok": true, "contactCount": 247, "lidCacheSize": 0 }
```

Idempotent. Safe to call any time the client is `READY`. The server also
calls this automatically on every fresh `READY` event, so this endpoint is
mostly useful as a manual kick after a known-cold start or after re-pairing.

### `POST /send/reply` — *authenticated*

Reply to a specific message — alias of `/send/text` with the quote id required.

```bash
curl -H "x-api-key: $WHATSAPP_API_KEY" -H "Content-Type: application/json" \
  -d '{"to":"+1 (234) 567-890","body":"Got it","quotedMessageId":"false_447123456789@c.us_ABCD1234"}' \
  http://localhost:3056/send/reply
```

### `POST /send/media` — *authenticated*

Send media via `multipart/form-data`. The file is sent under the field name **`media`**.

```bash
curl -H "x-api-key: $WHATSAPP_API_KEY" \
  -F "to=+1 (234) 567-890" \
  -F "caption=Have a look" \
  -F 'quotedMessageId=false_447123456789@c.us_ABCD1234' \
  -F "media=@./picture.jpg" \
  http://localhost:3056/send/media
```

Body fields (multipart parts):

| Field             | Required | Description                                                |
|-------------------|----------|------------------------------------------------------------|
| `to`              | yes      | Recipient                                                  |
| `media`           | yes      | The file to send (must be a `.jpg`, `.pdf`, `.mp4`, etc.)  |
| `caption`         | no       | Optional caption text                                      |
| `quotedMessageId` | no       | The `messageId` to reply to                                |
| `type`            | no       | Force interpretation — e.g. `sticker` (for `.webp` stickers) |

### `POST /send/sticker` — *authenticated*

Shortcut for sending `.webp` stickers.

```bash
curl -H "x-api-key: $WHATSAPP_API_KEY" \
  -F "to=+1 (234) 567-890" \
  -F "media=@./sticker.webp" \
  http://localhost:3056/send/sticker
```

### `POST /messages/:id/react` — *authenticated*

Send a reaction emoji. Pass an empty string to remove a reaction.

```bash
curl -X POST -H "x-api-key: $WHATSAPP_API_KEY" -H "Content-Type: application/json" \
  -d '{"reaction":"❤️"}' \
  http://localhost:3056/messages/false_447123456789@c.us_ABCD1234/react
```

### `GET /me` — *authenticated*

Returns basic information about the authenticated WhatsApp client.

```bash
curl -H "x-api-key: $WHATSAPP_API_KEY" http://localhost:3056/me
```

### `POST /logout` — *authenticated*

Logs out the client (and clears the local session file).

```bash
curl -X POST -H "x-api-key: $WHATSAPP_API_KEY" http://localhost:3056/logout
```

---

## Persistence & SQLite

Incoming messages and message ack receipts are stored in a SQLite database at:

```
<DATA_DIR>/messages.db
```

Messages contain everything needed for clients to poll back to the moment of failure, including across container restarts. **Media bytes are NOT stored** — they are fetched on demand from WhatsApp through `/messages/:id/media`.

The schema (managed by `db.js`):

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE NOT NULL,
  from_number TEXT NOT NULL,
  from_name TEXT,
  chat_id TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT,
  has_media INTEGER DEFAULT 0,
  mimetype TEXT,
  filename TEXT,
  timestamp INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  raw TEXT
);

CREATE TABLE receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  receipt_type TEXT NOT NULL,
  recipient TEXT,
  timestamp INTEGER NOT NULL,
  raw TEXT
);
```

---

## Environment variables

| Variable                    | Default                             | Description                                            |
|-----------------------------|-------------------------------------|--------------------------------------------------------|
| `PORT`                      | `3056`                              | Port the API listens on                                |
| `WHATSAPP_API_KEY`          | *(required, any non-empty string)*   | API key required for every authenticated call          |
| `DATA_DIR`                  | `./data`                            | Volume-mounted data directory (session + SQLite)       |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/google-chrome-stable`     | Chrome Stable binary installed in the container        |

---

## Data layout

```
data/
├── session/                  # LocalAuth credentials (auto-managed by whatsapp-web.js)
│   └── session-mirai/        # (or whatever the client-id resolves to)
└── messages.db               # SQLite database of incoming messages & receipts
```

Bind this entire `data/` directory to a Docker volume to make sessions persistent.

---

## Architecture

```
docker container: agentic-whatsapp
┌───────────────────────────────────────────────┐
│  Node.js (Express) — port 3056                │
│   ├── /status, /qr/<key>                      │
│   ├── /incoming-messages  ◄── poll            │
│   ├── /send/text, /send/media, /send/sticker  │
│   ├── /send/reply, /messages/:id/react        │
│   └── /messages/:id/media                     │
│                                               │
│  whatsapp-web.js Client (LocalAuth)           │
│   └── Puppeteer → /usr/bin/google-chrome-stable│
│                                               │
│  SQLite (better-sqlite3)                      │
└───────────────────────────────────────────────┘
```

---

## Troubleshooting

| Problem                                            | Fix                                                           |
|----------------------------------------------------|---------------------------------------------------------------|
| Container exits with `WHATSAPP_API_KEY environment variable is required` | Set `WHATSAPP_API_KEY` in `.env` or in `docker-compose.yml` environment |
| Container builds forever at npm install             | Be patient; `better-sqlite3` compiles native bindings        |
| API returns `503 Client not ready`                 | Visit `/qr/<api-key>` and complete authentication             |
| Sending a video fails                              | Make sure Google Chrome was installed — check `which google-chrome-stable` inside the container (`docker exec agentic-whatsapp which google-chrome-stable`) |
| QR code never appears                              | Check container logs: `docker logs -f agentic-whatsapp` for stderr from puppeteer/chrome |
| Stuck on `AUTHENTICATED`                           | The page will refresh shortly; if it persists, restart       |

---

## License

MIT
