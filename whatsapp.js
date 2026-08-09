const {
  Client,
  LocalAuth,
  MessageMedia,
  Location,
  Buttons,
  List,
  Poll,
  Contact,
} = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const db = require('./db');

let client = null;
let currentQr = null;
let readyAt = null;

/**
 * Remove stale Chrome profile locks left behind by an unclean shutdown.
 *
 * Chrome refuses to launch against a profile it believes is in use by another
 * process ("The profile appears to be in use..."), which leaves the client dead
 * on arrival after any hard restart. The container owns this profile
 * exclusively, so a leftover lock is always stale by definition.
 */
function clearStaleChromeLocks(sessionPath) {
  const profileDir = path.join(sessionPath, 'session-agentic-whatsapp');
  if (!fs.existsSync(profileDir)) return;

  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const target = path.join(profileDir, name);
    try {
      if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) {
        fs.rmSync(target, { force: true, recursive: true });
        console.log(`Cleared stale Chrome lock: ${name}`);
      }
    } catch (err) {
      // lstat throws on a dangling symlink on some platforms; force-unlink anyway
      try {
        fs.unlinkSync(target);
        console.log(`Cleared stale Chrome lock: ${name}`);
      } catch (_) {
        /* nothing to clear */
      }
    }
  }
}

/**
 * Initialize the WhatsApp client. Returns a promise that resolves when the
 * client reaches the AUTHENTICATED state (and exposes a `getStatus()` helper).
 */
function initWhatsApp({ sessionPath }) {
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  clearStaleChromeLocks(sessionPath);

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: sessionPath,
      clientId: 'agentic-whatsapp',
    }),
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-low-res-tiling',
        '--mute-audio',
      ],
    },
    webVersionCache: {
      type: 'local',
    },
  });

  client.on('qr', async (qr) => {
    try {
      currentQr = await qrcode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 1, scale: 8 });
    } catch (e) {
      currentQr = null;
    }
  });

  client.on('authenticated', () => {
    currentQr = null;
    // Authentication successful — emit status
    setStatus('AUTHENTICATED');
  });

  client.on('auth_failure', (msg) => {
    console.error('Authentication failure:', msg);
    setStatus('AUTH_FAILURE');
  });

  client.on('ready', () => {
    readyAt = Date.now();
    setStatus('READY');
  });

  client.on('disconnected', (reason) => {
    readyAt = null;
    setStatus('DISCONNECTED');
    console.log('WhatsApp disconnected:', reason);
  });

  client.on('message', async (msg) => {
    // Ignore status/broadcast feed messages — they come from 'status@broadcast'
    // and are not regular chat messages.
    if (msg.from === 'status@broadcast') return;
    try {
      await handleIncomingMessage(msg);
    } catch (err) {
      console.error('Failed to process incoming message:', err);
    }
  });

  // Message acknowledgement events
  client.on('message_ack', (msg, ack) => {
    // Ignore acks for status/broadcast feed messages.
    if (msg.from === 'status@broadcast') return;
    try {
      const ackNames = ['ERROR', 'PENDING', 'SENT', 'RECEIVED', 'READ', 'PLAYED'];
      const ackName = ackNames[ack] || `UNKNOWN_${ack}`;
      db.insertReceipt({
        messageId: serializeMessageId(msg.id),
        type: ackName,
        recipient: msg.to || (msg.from && msg.from !== 'me' ? msg.from : null),
        timestamp: Date.now(),
        raw: { ack },
      });
    } catch (err) {
      console.error('Failed to record message ack:', err);
    }
  });

  return client.initialize();
}

/**
 * Normalize a whatsapp-web.js message id into a plain string.
 *
 * `msg.id` is a MessageId object ({ fromMe, remote, id }) and `_serialized` is
 * not always present. Returning the raw object would let it reach better-sqlite3,
 * which interprets a plain object as a *named parameter* binding rather than a
 * value — producing "RangeError: Too few parameter values were provided".
 */
function serializeMessageId(id) {
  if (id === null || id === undefined) return null;
  if (typeof id === 'string') return id;
  if (typeof id !== 'object') return String(id);
  if (typeof id._serialized === 'string') return id._serialized;

  const wid = (v) => (typeof v === 'string' ? v : v?._serialized || null);
  const remote = wid(id.remote);
  if (!remote || !id.id) return typeof id.id === 'string' ? id.id : null;

  const prefix = `${Boolean(id.fromMe)}_${remote}_${id.id}`;

  // WhatsApp Web's bundler mangles property names, so `_serialized` currently
  // arrives as `$1` — and will be renamed again on some future release. Rather
  // than hard-code the mangled name, find whichever own property holds the
  // serialized form. This is preferred over rebuilding it ourselves because it
  // is whatever WhatsApp itself considers canonical.
  for (const value of Object.values(id)) {
    if (typeof value === 'string' && value.startsWith(prefix)) return value;
  }

  // Last resort: rebuild it. Group and broadcast messages serialize with a 4th
  // participant component; omitting it leaves client.getMessageById() unable to
  // resolve the message.
  const participant = wid(id.participant);
  const rebuilt = participant ? `${prefix}_${participant}` : prefix;
  console.warn(
    'MessageId had no serialized field, rebuilt as',
    rebuilt,
    'from',
    JSON.stringify(id)
  );
  return rebuilt;
}

/**
 * Persist an incoming WhatsApp message to the database.
 */
async function handleIncomingMessage(msg) {
  if (!msg || !msg.id) return;

  const messageId = serializeMessageId(msg.id);
  if (!messageId) {
    console.error('Skipping message with unusable id:', msg.id);
    return;
  }

  // Media is fetched on demand via /messages/:id/media, so we deliberately do
  // NOT download it here. `hasMedia` reflects what WhatsApp itself reports
  // (Message.hasMedia === Boolean(directPath)); deriving it from a successful
  // download instead meant every transient download failure was recorded as
  // "this message has no media", permanently and silently.
  const hasMedia = Boolean(msg.hasMedia);
  const mimetype = msg._data?.mimetype || null;
  const filename = msg._data?.filename || null;

  // We deliberately do NOT save media content. The media is on-demand via /messages/:id/media.
  db.insertMessage({
    messageId,
    from: msg.from,
    fromName: msg._data?.notifyName || msg.author || null,
    chatId: msg.fromMe ? (msg.to || msg.from) : (msg.from || msg.to),
    type: msg.type,
    body: msg.body || null,
    hasMedia,
    mimetype,
    filename,
    timestamp: Math.round((msg.timestamp || Date.now() / 1000) * 1000),
    receivedAt: Date.now(),
    raw: { id: messageId },
  });
}

/**
 * Lightweight status tracker used by /status.
 */
function setStatus(name) {
  internalStatus.name = name;
  internalStatus.lastEventAt = Date.now();
}

const internalStatus = {
  name: 'INITIALIZING',
  lastEventAt: Date.now(),
  readySince: null,
};

let initFailure = null;

/**
 * Record (or clear) a client initialization failure so /health can report it.
 */
function setInitFailure(err) {
  initFailure = err ? { message: err.message, at: Date.now() } : null;
  if (err) setStatus('INIT_FAILED');
}

function getInitFailure() {
  return initFailure;
}

function getStatus() {
  if (internalStatus.name === 'READY' && !internalStatus.readySince) {
    internalStatus.readySince = readyAt || Date.now();
  }
  return {
    status: internalStatus.name,
    readySince: internalStatus.readySince,
    hasQr: !!currentQr,
    lastEventAt: internalStatus.lastEventAt,
    ...(initFailure ? { initError: initFailure.message } : {}),
  };
}

function getCurrentQr() {
  return currentQr;
}

function getClient() {
  return client;
}

function isClientReady() {
  return !!client && internalStatus.name === 'READY';
}

/**
 * Sanitize a recipient phone number / chat id.
 * Accepts:  +1 (234) 567-890,  1234567890,  1234567890@c.us,  120363...@g.us
 * Returns:  properly formatted chat id ending with @c.us or @g.us.
 */
function sanitizeRecipient(to) {
  if (!to || typeof to !== 'string') {
    throw new Error('Recipient ("to") is required');
  }
  const original = to.trim();

  // Group ids already correct
  if (original.endsWith('@g.us')) return original;

  // Already a chat id ending in @c.us; allow as-is
  if (original.endsWith('@c.us')) {
    const numberPart = original.replace(/@c\.us$/, '');
    const digits = numberPart.replace(/\D/g, '');
    return `${digits}@c.us`;
  }

  // Strip non-digits and append @c.us
  const digits = original.replace(/\D/g, '');
  if (!digits || digits.length < 5) {
    throw new Error(`Recipient "${to}" does not contain enough digits`);
  }
  return `${digits}@c.us`;
}

/**
 * Send a text message.
 */
async function sendText({ to, body, quotedMessageId }) {
  if (!isClientReady()) throw new Error('WhatsApp client is not ready');
  const chatId = sanitizeRecipient(to);
  const options = {};
  if (quotedMessageId) {
    const quoted = await getMessageById(quotedMessageId);
    if (quoted) {
      const waMsg = await client.getMessageById(quoted.messageId);
      if (waMsg) options.quotedMessage = waMsg;
    }
  }
  const sent = await client.sendMessage(chatId, body, options);
  return serializeMessage(sent);
}

/**
 * Send media from a Buffer or file path.
 */
async function sendMedia({ to, buffer, mimetype, filename, caption, type, quotedMessageId }) {
  if (!isClientReady()) throw new Error('WhatsApp client is not ready');
  const chatId = sanitizeRecipient(to);
  const MediaCtor = MessageMedia.fromBuffer ? MessageMedia : null;
  const media = MessageMedia.fromBuffer(buffer, mimetype || 'application/octet-stream');
  media.filename = filename || 'file';
  const options = {};
  if (caption) options.caption = caption;
  if (quotedMessageId) {
    const quoted = await getMessageById(quotedMessageId);
    if (quoted) {
      const waMsg = await client.getMessageById(quoted.messageId);
      if (waMsg) options.quotedMessage = waMsg;
    }
  }
  const sent = await client.sendMessage(chatId, media, options);
  return serializeMessage(sent);
}

/**
 * Send a sticker from a webp file.
 */
async function sendSticker({ to, buffer, quotedMessageId }) {
  if (!isClientReady()) throw new Error('WhatsApp client is not ready');
  const chatId = sanitizeRecipient(to);
  const media = MessageMedia.fromBuffer(buffer, 'image/webp');
  media.filename = 'sticker.webp';
  const options = { sendStickerAsSticker: true, stickerMetadata: { author: 'agentic-whatsapp', keepScale: true } };
  if (quotedMessageId) {
    const quoted = await getMessageById(quotedMessageId);
    if (quoted) {
      const waMsg = await client.getMessageById(quoted.messageId);
      if (waMsg) options.quotedMessage = waMsg;
    }
  }
  const sent = await client.sendMessage(chatId, media, options);
  return serializeMessage(sent);
}

/**
 * Reply to a specific message — convenience wrapper around sendText with quoting.
 */
async function replyToMessage({ to, body, quotedMessageId }) {
  return sendText({ to, body, quotedMessageId });
}

/**
 * Fetch the media for a received message on demand.
 *
 * Note: `client.getMessageById` resolves against the live WhatsApp Web session's
 * message store, so media is only retrievable while the message is still loaded
 * there. After a client restart, older messages are no longer resolvable even
 * though we have their row in the DB — that is a WhatsApp Web constraint, not a
 * lookup bug. Errors are tagged so the HTTP layer can pick a sensible status.
 */
async function fetchMessageMediaByMessageId(messageId) {
  if (!isClientReady()) {
    const err = new Error('WhatsApp client is not ready');
    err.code = 'NOT_READY';
    throw err;
  }

  const waMsg = await client.getMessageById(messageId);
  if (!waMsg) {
    const err = new Error(
      `Message ${messageId} is no longer available in the WhatsApp session ` +
        `(media can only be fetched while the message is still loaded; this is ` +
        `expected for older messages after a restart)`
    );
    err.code = 'NOT_IN_SESSION';
    throw err;
  }

  if (!waMsg.hasMedia) {
    const err = new Error('Message has no media');
    err.code = 'NO_MEDIA';
    throw err;
  }

  // whatsapp-web.js's downloadMedia() ends with `}, this.id._serialized)` — it
  // passes that value into the page context to look the message up. Under the
  // current WhatsApp Web build `_serialized` is mangled to `$1`, so the library
  // passes `undefined` and the in-page lookup throws a minified error ("r").
  // Populating the field the library expects fixes it without patching the
  // library, and also repairs any other method that reads `id._serialized`.
  if (waMsg.id && typeof waMsg.id._serialized !== 'string') {
    const serialized = serializeMessageId(waMsg.id) || messageId;
    try {
      waMsg.id._serialized = serialized;
    } catch (e) {
      console.warn(`Could not set _serialized on message id: ${e.message}`);
    }
  }

  let media;
  try {
    media = await waMsg.downloadMedia();
  } catch (cause) {
    // Errors thrown inside the page context arrive minified (e.g. "r"), so log
    // the original with its stack before replacing it with something readable.
    console.error(`downloadMedia failed for ${messageId}:`, cause);
    const err = new Error(
      `Media download failed for ${messageId}: ${cause?.message || cause}`
    );
    err.code = 'DOWNLOAD_FAILED';
    err.cause = cause;
    throw err;
  }

  if (!media) {
    const err = new Error(
      'Media could not be downloaded — it may have expired or be mid-reupload'
    );
    err.code = 'DOWNLOAD_FAILED';
    throw err;
  }
  return {
    mimetype: media.mimetype,
    data: media.data, // base64 data from whatsapp-web.js
    filename: media.filename,
  };
}

/**
 * Fetch messages from a specific phone number's chat, queried directly from
 * WhatsApp Web (not from SQLite). Supports limit and fromMe filtering.
 *
 * `phone` is sanitized to a chat ID, the chat is looked up via
 * `client.getChatById`, then `chat.fetchMessages()` is called which both
 * returns the in-memory message array and lazy-loads older messages via
 * `WAWebChatLoadMessages` when the requested limit exceeds what's cached.
 */
async function fetchChatMessages({ phone, limit = 50, fromMe = null }) {
  if (!isClientReady()) throw new Error('WhatsApp client is not ready');

  const chatId = sanitizeRecipient(phone);
  const chat = await client.getChatById(chatId);
  if (!chat) throw new Error(`No active chat found for ${phone}`);

  const searchOptions = { limit: Math.min(200, Math.max(1, limit)) };
  if (fromMe === true) searchOptions.fromMe = true;
  else if (fromMe === false) searchOptions.fromMe = false;

  const messages = await chat.fetchMessages(searchOptions);

  return messages.map((msg) => serializeMessage(msg));
}

/**
 * Serialize a sent message to a clean response object.
 */
function serializeMessage(msg) {
  if (!msg) return null;
  return {
    messageId: serializeMessageId(msg.id),
    to: msg.to,
    from: msg.from,
    body: msg.body,
    type: msg.type,
    timestamp: msg.timestamp,
    ack: msg.ack,
  };
}

/**
 * Resolve a `getMessageById` callback in this module for quoted-message lookup.
 */
async function getMessageById(id) {
  // id may be either the DB id (number) or the messageId string
  if (typeof id === 'number' || /^\d+$/.test(String(id))) {
    return db.getMessageById(Number(id));
  }
  return db.getMessageByMessageId(String(id));
}

/**
 * Send a reaction emoji to a message.
 */
async function sendReaction({ to, messageId, reaction }) {
  if (!isClientReady()) throw new Error('WhatsApp client is not ready');
  // `to` is omitted (null/undefined) for reactions — the reaction is applied to
  // the message's own chat, not sent to a separate recipient.
  const chatId = to ? sanitizeRecipient(to) : null;
  const waMsg = await client.getMessageById(messageId);
  if (!waMsg) throw new Error('Message not found');
  await waMsg.react(reaction || '');
  return { ok: true, messageId, reaction };
}

module.exports = {
  initWhatsApp,
  getClient,
  getStatus,
  setInitFailure,
  getInitFailure,
  getCurrentQr,
  isClientReady,
  sanitizeRecipient,
  sendText,
  sendMedia,
  sendSticker,
  replyToMessage,
  sendReaction,
  fetchMessageMediaByMessageId,
  fetchChatMessages,
  serializeMessage,
};
