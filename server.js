require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const wa = require('./whatsapp');

const PORT = parseInt(process.env.PORT || '3056', 10);
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY;
const API_KEY = WHATSAPP_API_KEY; // shorter local alias
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_DIR = path.join(DATA_DIR, 'session');

if (!WHATSAPP_API_KEY || WHATSAPP_API_KEY.length === 0) {
  console.error('WHATSAPP_API_KEY environment variable is required (set it to any non-empty string)');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure multer for handling file uploads (memory storage — we never persist media)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

// ===== Middleware =====

/**
 * API Key middleware.
 *   - For GET /qr/:apiKey, validates the key in the URL path.
 *   - For /status, the endpoint is public (clients poll it for liveness info).
 *   - For everything else, require the key via `x-api-key` header or `?apiKey=` query.
 */
function requireApiKey(req, res, next) {
  if (req.method === 'GET' && req.path === '/status') return next();
  // /qr/<apiKey> and /qr/<apiKey>/image.png are gated by the key in the URL path
  const qrMatch = req.path.match(/^\/qr\/([^/]+)(\/image\.png)?\/?$/);
  if (qrMatch) {
    const provided = decodeURIComponent(qrMatch[1]);
    if (provided && provided === API_KEY) return next();
    return res.status(401).send('Invalid API key');
  }

  const headerKey = req.header('x-api-key');
  const queryKey = req.query.apiKey;
  const bodyKey = req.body && req.body.apiKey;

  const provided = headerKey || queryKey || bodyKey;
  if (!provided) {
    return res.status(401).json({ error: 'API key required (x-api-key header, ?apiKey= query, or body.apiKey)' });
  }
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

app.use((req, res, next) => {
  // `/qr/<apiKey>` (with optional image.png) and `/status` are public-ish (key in path for qr)
  const isQr = req.method === 'GET' && /^\/qr\/[^/]+(\/image\.png)?\/?$/.test(req.path);
  const isStatus = req.method === 'GET' && req.path === '/status';
  if (isQr || isStatus) return next();
  return requireApiKey(req, res, next);
});

// ===== Public endpoints =====

/**
 * GET /status  — returns the current status of the WhatsApp client.
 * Always public so clients can poll readiness.
 */
app.get('/status', (req, res) => {
  res.json(wa.getStatus());
});

/**
 * GET /health  — liveness for the container healthcheck.
 *
 * Distinct from /status, which always returns 200 and is polled by clients.
 * A 200 here means the WhatsApp client is actually usable (or legitimately
 * waiting for a QR scan); anything else is a real outage. The old healthcheck
 * pointed at /status, so a dead client still reported "healthy".
 */
app.get('/health', (req, res) => {
  const status = wa.getStatus();
  const initFailure = wa.getInitFailure();

  // Waiting for a QR scan or still starting up is not a failure.
  const healthy =
    !initFailure &&
    ['READY', 'AUTHENTICATED', 'INITIALIZING'].includes(status.status);

  res.status(healthy ? 200 : 503).json({
    healthy,
    ...status,
    ...(initFailure ? { initFailure } : {}),
  });
});

/**
 * GET /qr/<api-key>  — renders a styled HTML page with the QR code when auth is needed.
 * Auto-refreshes every 2 seconds while QR is active. Once the client is READY,
 * it shows a "Connected" page.
 */
app.get('/qr/:apiKey', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});

/**
 * GET /qr/<api-key>/image.png  — returns the current QR code as a PNG image.
 * If no QR code is available, returns a 404.
 */
app.get('/qr/:apiKey/image.png', (req, res) => {
  const dataUrl = wa.getCurrentQr();
  if (!dataUrl) return res.status(404).end();
  const m = dataUrl.match(/^data:(image\/png);base64,(.+)$/);
  if (!m) return res.status(404).end();
  const buffer = Buffer.from(m[2], 'base64');
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(buffer);
});

// ===== Authenticated endpoints =====

/**
 * GET /incoming-messages
 *   Polled by clients to retrieve messages received within the last `minutes` window.
 *   Pass `?since=<unix-ms>` to fetch messages newer than a specific timestamp.
 *   Also returns recent receipt (ack) events by default.
 *
 *   Query params:
 *     minutes  — number, default 60
 *     since    — number (unix ms), default null
 *     includeReceipts — '1' to include message ack events
 *     limit    — cap the number of messages returned (default 1000)
 */
app.get('/incoming-messages', (req, res) => {
  try {
    const minutes = req.query.minutes ? Math.max(1, parseInt(req.query.minutes, 10)) : 60;
    const since = req.query.since ? parseInt(req.query.since, 10) : null;
    const includeReceipts = req.query.includeReceipts === '1' || req.query.includeReceipts === 'true';
    const limit = req.query.limit ? Math.min(5000, Math.max(1, parseInt(req.query.limit, 10))) : 1000;

    const messages = db.getIncomingMessages({ minutes, since }).slice(-limit);

    const response = {
      fetchedAt: Date.now(),
      count: messages.length,
      messages,
    };

    if (includeReceipts) {
      response.receipts = db.getReceipts({ minutes, since });
    }

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /messages/:id/media  — on-demand media retrieval for a stored incoming message.
 *   `:id` may be either the numeric DB id or the WhatsApp messageId.
 *   Streams base64-decoded binary data back to the client.
 */
app.get('/messages/:id/media', async (req, res) => {
  try {
    const { id } = req.params;
    let stored;
    if (/^\d+$/.test(id)) {
      stored = db.getMessageById(parseInt(id, 10));
    } else {
      // A WhatsApp messageId must be looked up by message_id, not by the
      // numeric primary key — getMessageById() here could never match.
      stored = db.getMessageByMessageId(decodeURIComponent(id));
    }
    if (!stored) return res.status(404).json({ error: 'Message not found' });
    if (!stored.hasMedia) return res.status(404).json({ error: 'Message has no media' });

    const media = await wa.fetchMessageMediaByMessageId(stored.messageId);
    const buffer = Buffer.from(media.data, 'base64');

    res.set('Content-Type', media.mimetype || 'application/octet-stream');
    if (media.filename) {
      res.set('Content-Disposition', `inline; filename="${encodeURIComponent(media.filename)}"`);
    }
    res.send(buffer);
  } catch (err) {
    // Distinguish "we can't give you this" from "something broke".
    const status = {
      NOT_IN_SESSION: 410,
      NO_MEDIA: 404,
      NOT_READY: 503,
      DOWNLOAD_FAILED: 502,
    }[err.code] || 500;
    if (status >= 500) console.error('Media retrieval failed:', err);
    res.status(status).json({ error: err.message, code: err.code || 'INTERNAL' });
  }
});

/**
 * POST /send/text  — send a text message (optionally replying to another message).
 *   Body: { to: string, body: string, quotedMessageId?: string|number }
 */
app.post('/send/text', async (req, res) => {
  try {
    const { to, body, quotedMessageId } = req.body || {};
    if (!to) return res.status(400).json({ error: '"to" is required' });
    if (!body) return res.status(400).json({ error: '"body" is required' });

    const sent = await wa.sendText({ to, body, quotedMessageId });
    res.json({ ok: true, message: sent });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /send/reply  — reply to a specific message (alias of /send/text with quotedMessageId).
 *   Body: { to: string, body: string, quotedMessageId: string }
 */
app.post('/send/reply', async (req, res) => {
  try {
    const { to, body, quotedMessageId } = req.body || {};
    if (!to || !body || !quotedMessageId) {
      return res.status(400).json({ error: '"to", "body" and "quotedMessageId" are required' });
    }
    const sent = await wa.replyToMessage({ to, body, quotedMessageId });
    res.json({ ok: true, message: sent });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /send/media  — send media using multipart/form-data.
 *   Fields:
 *     to          — recipient (phone number, chat id, or group id)
 *     caption     — optional caption text
 *     quotedMessageId — optional, for replying to a specific message
 *     media       — the uploaded file (single file, field name "media")
 *   The MediaType is detected from the file mimetype unless `type` is supplied.
 */
app.post('/send/media', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '"media" file upload is required (multipart/form-data)' });
    const { to, caption, quotedMessageId, type } = req.body || {};
    if (!to) return res.status(400).json({ error: '"to" is required' });

    const buffer = req.file.buffer;
    const mimetype = req.file.mimetype || 'application/octet-stream';
    const filename = req.file.originalname || 'file';

    let sent;
    if (mimetype === 'image/webp' && type === 'sticker') {
      sent = await wa.sendSticker({ to, buffer, quotedMessageId });
    } else {
      sent = await wa.sendMedia({ to, buffer, mimetype, filename, caption, type, quotedMessageId });
    }

    res.json({ ok: true, message: sent });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /send/sticker  — shorthand for sending image/webp stickers.
 */
app.post('/send/sticker', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '"media" file upload is required (multipart/form-data)' });
    const { to, quotedMessageId } = req.body || {};
    if (!to) return res.status(400).json({ error: '"to" is required' });
    const sent = await wa.sendSticker({ to, buffer: req.file.buffer, quotedMessageId });
    res.json({ ok: true, message: sent });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /messages/:id/react  — send a reaction emoji to a message.
 *   Body: { reaction: string }
 *   `:id` may be either the numeric DB id or the WhatsApp messageId.
 *   Use an empty string `""` to clear a reaction.
 */
app.post('/messages/:id/react', async (req, res) => {
  try {
    const { id } = req.params;
    let messageId = id;
    if (/^\d+$/.test(id)) {
      const stored = db.getMessageById(parseInt(id, 10));
      if (!stored) return res.status(404).json({ error: 'Message not found' });
      messageId = stored.messageId;
    }
    const reaction = (req.body && req.body.reaction) || '';
    const result = await wa.sendReaction({ to: null, messageId, reaction });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /me  — get information about the authenticated client.
 */
app.get('/me', async (req, res) => {
  try {
    if (!wa.isClientReady()) return res.status(503).json({ error: 'Client not ready' });
    const client = wa.getClient();
    const info = client.info;
    res.json({
      id: info.wid?._serialized,
      pushname: info.pushname,
      platform: info.platform,
      phone: info.wid?.user,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /chat-messages
 *   Fetch messages for a specific phone number directly from WhatsApp Web.
 *   `phone` is required and is auto-sanitized to a proper chat ID.
 *
 *   Query params:
 *     limit   — number, default 50, max 200
 *     fromMe  — 'true' / 'false' to filter; omit for both directions
 */
app.get('/chat-messages', async (req, res) => {
  try {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: '"phone" query parameter is required' });

    const limit = req.query.limit
      ? Math.min(200, Math.max(1, parseInt(req.query.limit, 10)))
      : 50;
    const fromMe =
      req.query.fromMe === 'true'
        ? true
        : req.query.fromMe === 'false'
          ? false
          : null;

    const messages = await wa.fetchChatMessages({ phone, limit, fromMe });
    res.json({ fetchedAt: Date.now(), count: messages.length, messages });
  } catch (err) {
    const status = { 'No active chat found': 404 }[err.message] || 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /logout
 */
app.post('/logout', async (req, res) => {
  try {
    if (!wa.isClientReady() && !wa.getClient()) {
      return res.status(503).json({ error: 'Client not initialized' });
    }
    await wa.getClient().logout();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== 404 fallback =====

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ===== Boot =====

(async () => {
  db.initDb(DATA_DIR);

  // A failed initialize used to be logged and then forgotten, leaving the client
  // permanently dead while the process kept serving HTTP — an invisible outage.
  // Retry with backoff instead, and let /health report the failure.
  const startWhatsApp = async (attempt = 1) => {
    try {
      await wa.initWhatsApp({ sessionPath: SESSION_DIR });
      wa.setInitFailure(null);
    } catch (err) {
      const delay = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
      console.error(
        `Failed to initialize WhatsApp client (attempt ${attempt}), ` +
          `retrying in ${delay / 1000}s:`,
        err.message
      );
      wa.setInitFailure(err);
      setTimeout(() => startWhatsApp(attempt + 1), delay);
    }
  };

  await startWhatsApp();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`agentic-whatsapp API listening on http://0.0.0.0:${PORT}`);
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    try { await wa.getClient()?.destroy(); } catch (_) {}
    db.closeDb();
    process.exit(0);
  });
})();
