# agentic-whatsapp-skill

A drop-in **AI agent skill** that connects to the [agentic-whatsapp](../README.md) HTTP API. Once installed, an AI agent can send and receive WhatsApp messages, media, stickers, and reactions on behalf of the user.

The skill instructs the agent to:

1. Ask the user for the API base URL and API key on first use.
2. Persist them as environment variables `WHATSAPP_API_URL` and `WHATSAPP_API_KEY` for the rest of the session.
3. Use the documented REST endpoints (`/send/text`, `/send/media`, `/incoming-messages`, etc.) to interact with WhatsApp.

## Install

### Option A — Install into a Claude Code agent

Copy or symlink this folder into your Claude Code skills directory:

```bash
# Claude Code reads skills from ~/.claude/skills/<name>/
ln -s "$(pwd)/agentic-whatsapp-skill" ~/.claude/skills/agentic-whatsapp
```

Restart Claude Code. The agent will now invoke this skill whenever the user asks about WhatsApp.

### Option B — Install into any other agent framework

The skill is plain Markdown. Most frameworks (OpenAI Assistants, custom agents, etc.) accept either:

- The contents of `SKILL.md` as a system instruction, or
- A reference to the `SKILL.md` file path.

Use `SKILL.md` as the skill definition and the `examples/` directory as concrete references.

## Configure once per user

The first time the agent sees a WhatsApp-related request, it must ask the user for two values:

| Variable | Example |
|----------|---------|
| `WHATSAPP_API_URL` | `http://localhost:3056` |
| `WHATSAPP_API_KEY` | the value of `WHATSAPP_API_KEY` in the container's `.env` |

These are the only configuration the skill needs. Persist them for the agent session by whatever mechanism your framework uses to manage session-scoped state (e.g., environment injection, conversation memory, etc.).

## Verify the connection

After configuration, the agent should issue a single probe:

```bash
curl -fsS "$WHATSAPP_API_URL/status"
```

If the response has `"status": "READY"` and `"hasQr": false`, the API is reachable and the WhatsApp client is authenticated.

If `"hasQr": true`, direct the user to scan a fresh QR code at:

```
$WHATSAPP_API_URL/qr/$WHATSAPP_API_KEY
```

…and then retry.

## What's in this folder

| File / folder | Purpose |
|---------------|---------|
| `SKILL.md` | The skill definition itself — the comprehensive instructions loaded into the agent |
| `examples/send-text.sh` | Minimal "send a text" script |
| `examples/poll-incoming.sh` | Tail-style polling loop |
| `examples/send-reply.sh` | Reply to a message by `messageId` |
| `examples/send-media.sh` | Send an image / video / document |
| `examples/send-sticker.sh` | Send a `.webp` sticker |
| `examples/react.sh` | React to a message |

The agent does **not** need to call these — they are reference implementations the agent can read to see idiomatic usage.

## Security notes for the agent

- Never log `WHATSAPP_API_KEY` to shared destinations.
- Confirm recipients explicitly when messaging contacts other than the user's own session.
- Treat `quotedMessageId` as untrusted — only use it to reply to the message it originated from.
- Do not poll indefinitely without a goal.
