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
    // After READY, warm the WA-side contact store in the background. The
    // store is empty until something asks for it, and the first round of
    // sends after a fresh start is the worst time to discover that — every
    // outbound `getContact(LID)` becomes a slow page round-trip. We fire
    // and forget; failures are logged but never block startup.
    setImmediate(() => {
      warmContactCache()
        .then((count) => console.log(`warmed WA contact store (${count} contacts)`))
        .catch((err) => console.warn('warmContactCache failed:', err.message));
    });
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
      // Also notify any in-flight send waiter that this ack matches.
      // Used by the "sendMessage returned null" recovery path — see
      // waitForMatchingAck / notifyMatchingAck.
      if (msg.fromMe && msg.to && typeof msg.body === 'string') {
        const ackMessageId = serializeMessageId(msg.id);
        notifyMatchingAck({ chatId: msg.to, body: msg.body, messageId: ackMessageId });
      }
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
    contactCacheSize: contactCache.size(),
    waContactCount,
    // `lidCacheSize` is the public alias for the in-memory LID → phone
    // resolution cache. The two names exist because operators diagnose
    // the failure as "LID cache empty" while the implementation stores
    // it as `contactCacheSize`. Both are kept for backward compatibility.
    lidCacheSize: contactCache.size(),
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
 * Accepts:  +1 (234) 567-890,  1234567890,  1234567890@c.us,  120363...@g.us,
 *           146900934197276@lid  (WhatsApp LID — opaque local identifier)
 * Returns:  properly formatted chat id ending with @c.us, @g.us, or @lid.
 */
function sanitizeRecipient(to) {
  if (!to || typeof to !== 'string') {
    throw new Error('Recipient ("to") is required');
  }
  const original = to.trim();

  // Group ids already correct
  if (original.endsWith('@g.us')) return original;

  // LID (WhatsApp Local Identifier) — opaque internal handle. Must be sent
  // verbatim as @lid. Stripping the suffix and treating the digits as a
  // phone number produces "No LID for user" on the server. Pass through.
  if (original.endsWith('@lid')) return original;

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
 * Retry a function with exponential backoff.
 *
 * Useful for transient failures (WA Web client still warming up, contact
 * cache not yet populated after a fresh session, network blip). The function
 * is retried up to `maxAttempts` times with delays of `baseDelayMs * 2^(n-1)`.
 *
 * `shouldRetry` controls which errors warrant a retry. By default we retry
 * any error — for transient WA Web issues that's the right call, since
 * these errors are usually self-healing within seconds.
 */
async function retryWithBackoff(fn, { maxAttempts = 3, baseDelayMs = 2000, shouldRetry = () => true, onRetry = null } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err)) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      if (onRetry) onRetry(attempt, err, delay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Send a text message.
 *
 * For LID chats (`@lid` suffix) — which are how WhatsApp represents contacts
 * whose phone numbers are not visible to us — `client.sendMessage` will
 * silently resolve to `null` because the client has no way to address the
 * chat without resolving the underlying contact. We use `client.getContact`
 * to ask WhatsApp Web for the real phone number (`id._serialized`), then
 * send to that phone-format chat ID instead. If the contact is unknown to
 * the WhatsApp Web session we fall back to loading the chat via
 * `getChatById` (which can succeed for chats with a recent message sync).
 *
 * Retries: `sendText` is wrapped in retryWithBackoff (3 attempts, 2s/4s/8s)
 * so transient failures (WA Web warming up after restart, contact cache
 * still populating) self-heal without surfacing to the caller.
 */
async function sendText({ to, body, quotedMessageId }) {
  if (!isClientReady()) {
    const err = new Error('WhatsApp client is not ready');
    err.code = 'NOT_READY';
    throw err;
  }
  let chatId = sanitizeRecipient(to);
  const options = {};
  if (quotedMessageId) {
    const quoted = await getMessageById(quotedMessageId);
    if (quoted) {
      const waMsg = await client.getMessageById(quoted.messageId);
      if (waMsg) options.quotedMessage = waMsg;
    }
  }

  const sent = await retryWithBackoff(
    async () => {
      return sendOnceWithAckRecovery({
        chatId,
        content: body,
        options,
        contentKind: 'text',
      });
    },
    {
      maxAttempts: 3,
      baseDelayMs: 2000,
      shouldRetry: (err) =>
        err.code !== 'LID_UNRESOLVED' && err.code !== 'NO_LID_FOR_USER',
      onRetry: (attempt, err, delay) =>
        console.warn(`sendText retry ${attempt} after ${delay}ms: ${err.message}`),
    }
  );

  // Persist the outbound message immediately — the message_ack event may never
  // fire (session crash, network drop) and would otherwise leave the DB with
  // no record of a message we know we sent. The ack event will still update
  // the receipt table when it does arrive.
  if (sent) {
    try {
      db.insertMessage({
        messageId: sent.messageId,
        from: 'me',
        fromName: null,
        chatId: sent.to || chatId,
        type: sent.type || 'chat',
        body: sent.body || null,
        hasMedia: sent.type === 'ptt' ? 0 : 0,
        timestamp: sent.timestamp ? sent.timestamp * 1000 : Date.now(),
        receivedAt: Date.now(),
      });
    } catch (_) { /* non-fatal — ack event will still cover us */ }
  }
  return serializeMessage(sent);
}

/**
 * Send media from a Buffer or file path.
 */
async function sendMedia({ to, buffer, mimetype, filename, caption, type, quotedMessageId }) {
  if (!isClientReady()) {
    const err = new Error('WhatsApp client is not ready');
    err.code = 'NOT_READY';
    throw err;
  }
  const chatId = sanitizeRecipient(to);
  // whatsapp-web.js's MessageMedia does not expose fromBuffer(). Construct
  // via the public constructor signature (mimetype, base64-string, filename,
  // filesize). The buffer comes from multer memoryStorage (req.file.buffer),
  // so it's a real Node Buffer — toString('base64') gives the exact form the
  // constructor expects.
  const resolvedMimetype = mimetype || 'application/octet-stream';
  const resolvedFilename = filename || 'file';
  const media = new MessageMedia(
    resolvedMimetype,
    buffer.toString('base64'),
    resolvedFilename,
    buffer.length
  );
  const options = {};
  if (caption) options.caption = caption;
  if (quotedMessageId) {
    const quoted = await getMessageById(quotedMessageId);
    if (quoted) {
      const waMsg = await client.getMessageById(quoted.messageId);
      if (waMsg) options.quotedMessage = waMsg;
    }
  }

  const sent = await retryWithBackoff(
    async () => {
      return sendOnceWithAckRecovery({
        chatId,
        content: media,
        options,
        contentKind: 'image',
      });
    },
    {
      maxAttempts: 3,
      baseDelayMs: 2000,
      shouldRetry: (err) =>
        err.code !== 'LID_UNRESOLVED' && err.code !== 'NO_LID_FOR_USER',
      onRetry: (attempt, err, delay) =>
        console.warn(`sendMedia retry ${attempt} after ${delay}ms: ${err.message}`),
    }
  );

  if (sent) {
    try {
      db.insertMessage({
        messageId: sent.messageId,
        from: 'me',
        fromName: null,
        chatId: sent.to || chatId,
        type: sent.type || 'image',
        body: sent.body || null,
        hasMedia: 1,
        mimetype: mimetype || null,
        filename: filename || null,
        timestamp: sent.timestamp ? sent.timestamp * 1000 : Date.now(),
        receivedAt: Date.now(),
      });
    } catch (_) { /* non-fatal */ }
  }
  return serializeMessage(sent);
}

/**
 * Send a sticker from a webp file.
 */
async function sendSticker({ to, buffer, quotedMessageId }) {
  if (!isClientReady()) {
    const err = new Error('WhatsApp client is not ready');
    err.code = 'NOT_READY';
    throw err;
  }
  const chatId = sanitizeRecipient(to);
  // Same constructor pattern as sendMedia — see the comment there for why
  // fromBuffer() doesn't exist on MessageMedia.
  const media = new MessageMedia(
    'image/webp',
    buffer.toString('base64'),
    'sticker.webp',
    buffer.length
  );
  const options = { sendStickerAsSticker: true, stickerMetadata: { author: 'agentic-whatsapp', keepScale: true } };
  if (quotedMessageId) {
    const quoted = await getMessageById(quotedMessageId);
    if (quoted) {
      const waMsg = await client.getMessageById(quoted.messageId);
      if (waMsg) options.quotedMessage = waMsg;
    }
  }

  const sent = await retryWithBackoff(
    async () => {
      return sendOnceWithAckRecovery({
        chatId,
        content: media,
        options,
        contentKind: 'sticker',
      });
    },
    {
      maxAttempts: 3,
      baseDelayMs: 2000,
      shouldRetry: (err) =>
        err.code !== 'LID_UNRESOLVED' && err.code !== 'NO_LID_FOR_USER',
      onRetry: (attempt, err, delay) =>
        console.warn(`sendSticker retry ${attempt} after ${delay}ms: ${err.message}`),
    }
  );

  if (sent) {
    try {
      db.insertMessage({
        messageId: sent.messageId,
        from: 'me',
        fromName: null,
        chatId: sent.to || chatId,
        type: 'sticker',
        body: null,
        hasMedia: 1,
        mimetype: 'image/webp',
        filename: 'sticker.webp',
        timestamp: sent.timestamp ? sent.timestamp * 1000 : Date.now(),
        receivedAt: Date.now(),
      });
    } catch (_) { /* non-fatal */ }
  }
  return serializeMessage(sent);
}

/**
 * Tiny LRU cache for resolved contacts.
 *
 * `client.getContact(LID)` is an expensive WA Web round-trip; if the cron
 * runs every 5 minutes against the same 30 prospects, we want to avoid
 * hammering the contact store. The cache is in-memory only — when the
 * WA Web session restarts we lose the cache, which is fine because we
 * re-resolve on demand anyway.
 */
function createLruCache({ max = 500, ttlMs = 5 * 60 * 1000 } = {}) {
  const store = new Map(); // key -> { value, expiresAt }
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt < Date.now()) {
        store.delete(key);
        return undefined;
      }
      // Refresh insertion order for true LRU semantics.
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      if (store.has(key)) store.delete(key);
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      // Evict oldest entries until we're under the cap.
      while (store.size > max) {
        const oldest = store.keys().next().value;
        store.delete(oldest);
      }
    },
    clear() {
      store.clear();
    },
    size() {
      return store.size;
    },
  };
}

const contactCache = createLruCache({ max: 500, ttlMs: 5 * 60 * 1000 });

/**
 * Resolve a LID chat ID (`xxx@lid`) to a phone-format chat ID that
 * `client.sendMessage` can actually deliver to.
 *
 * Strategy:
 *   0. Cache hit  → return immediately (no WA round-trip).
 *   1. Ask WhatsApp Web for the contact. If known, return its `id._serialized`
 *      (e.g. `234XXXXXXXXXX@c.us`).
 *   2. If the contact is unknown but the chat can be loaded via
 *      `getChatById`, fall back to loading it and returning the original LID —
 *      the subsequent `sendMessage` may succeed because the chat has just
 *      been registered locally.
 *   3. If both fail, throw a clear error.
 *
 * Non-LID inputs are returned unchanged.
 */
async function resolveLidToPhoneChatId(chatId) {
  if (!chatId.endsWith('@lid')) return chatId;

  // 0. Cache hit — fast path, no WA round-trip.
  const cached = contactCache.get(chatId);
  if (cached !== undefined) return cached;

  // 0b. SQLite fallback — survives session restarts where the in-memory LRU
  //     is gone. The WA round-trip below will refresh this on success.
  try {
    const dbContact = db.getContactByLid(chatId);
    if (dbContact && dbContact.chatId) {
      contactCache.set(chatId, dbContact.chatId);
      return dbContact.chatId;
    }
  } catch (_) { /* non-fatal — DB may not be ready in tests */ }

  let resolved = null;
  let contactMeta = null;

  // 1. Try the contact lookup first — gives us the real phone number.
  try {
    const contact = await client.getContact(chatId);
    if (contact && contact.id && contact.id._serialized) {
      resolved = contact.id._serialized;
      contactMeta = {
        phone: contact.number || null,
        name: contact.pushname || contact.name || null,
        isBusiness: !!contact.isBusiness,
        isEnterprise: !!contact.isEnterprise,
      };
    }
  } catch (err) {
    // Unknown contact — fall through to chat-load attempt.
  }

  // 2. Fallback: load the chat so the client has it in its cache.
  if (!resolved) {
    try {
      await client.getChatById(chatId);
      resolved = chatId;
    } catch (err) {
      // Cold LID: the recipient has never messaged this WhatsApp account,
      // so WA Web has no contact mapping and cannot load the chat. This is
      // NOT a session/bug condition — the operator must wait for the
      // recipient to message first, or invite them out-of-band. Tag with a
      // stable error code so the HTTP layer can return 422 instead of 500.
      const e = new Error(
        `LID chat "${chatId}" could not be resolved: contact unknown and chat ` +
          `could not be loaded (${err.message}). The recipient has likely never ` +
          `messaged this WhatsApp account.`
      );
      e.code = 'LID_UNRESOLVED';
      e.retryable = false;
      throw e;
    }
  }

  // Persist to both caches so subsequent runs are fast.
  contactCache.set(chatId, resolved);
  try {
    db.upsertContact({
      lid: chatId,
      phone: contactMeta?.phone ?? null,
      chatId: resolved,
      name: contactMeta?.name ?? null,
      isBusiness: contactMeta?.isBusiness ?? false,
      isEnterprise: contactMeta?.isEnterprise ?? false,
    });
  } catch (_) { /* non-fatal — DB write failures must not block sends */ }

  return resolved;
}

/**
 * Active phone → chatId resolver. Calls `client.getNumberId(phone)` —
 * the official WA Web method that returns `{ _serialized, user, server }`
 * for phone numbers this account has a LID mapping for, or `null` when
 * the phone is not in the linked phone's contact list.
 *
 * Why this exists: in WA Web Multi-Device (post-2024), `client.sendMessage`
 * resolves to `null` (without throwing) when given a phone number that
 * has no LID mapping for the current account. The message *still goes
 * out* — WA's server delivers it and fires a `message_ack` event — but
 * the wrapper has no messageId to return. Pre-resolving the phone via
 * `getNumberId` lets us catch the "phone not in your contacts" case up
 * front (return 422) AND lets us send to the resolved LID when we have
 * one, which makes the response reliable.
 *
 * Returns null when the phone is unknown — caller should treat as
 * `PHONE_NOT_IN_CONTACTS`. Throws only on hard errors.
 */
async function resolvePhoneToChatId(phoneNumber) {
  if (!client || !isClientReady()) return null;
  try {
    const numberId = await client.getNumberId(phoneNumber);
    if (numberId && typeof numberId._serialized === 'string') {
      return numberId._serialized;
    }
    return null;
  } catch (_) {
    return null; // getNumberId sometimes throws for unknown numbers; treat as unknown
  }
}

/**
 * Wait briefly for a `message_ack` event matching `chatId`+`body`.
 *
 * Used after `client.sendMessage()` resolves to `null`/`undefined` to
 * recover the real `messageId` from the ack event that WA Web fires once
 * the message has been delivered to its server. This is the "phone not
 * in contacts" case where sendMessage returns no value but the message
 * still goes out.
 *
 * Correlation is best-effort: matches on `msg.to === chatId && msg.body === body
 * && msg.fromMe === true` for any ack arriving within `timeoutMs`. Two
 * concurrent identical sends to the same chat would race; the first ack
 * we see wins. For the wrapper's use case (1–2 sends per minute per
 * operator) this is reliable enough.
 *
 * Returns the ack event's serialized messageId, or null if no match
 * arrives in time.
 */
let pendingAckWaiters = []; // [{ chatId, body, resolve, timer }]
function waitForMatchingAck({ chatId, body, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const entry = { chatId, body, resolve, timer: null };
    entry.timer = setTimeout(() => {
      // Remove this waiter; resolve with null.
      pendingAckWaiters = pendingAckWaiters.filter((w) => w !== entry);
      resolve(null);
    }, timeoutMs);
    pendingAckWaiters.push(entry);
  });
}

// Called from the `message_ack` event handler. Resolves the first waiter
// whose chatId+body match the ack.
function notifyMatchingAck({ chatId, body, messageId }) {
  if (pendingAckWaiters.length === 0) return;
  const idx = pendingAckWaiters.findIndex(
    (w) => w.chatId === chatId && w.body === body
  );
  if (idx === -1) return;
  const waiter = pendingAckWaiters[idx];
  pendingAckWaiters.splice(idx, 1);
  clearTimeout(waiter.timer);
  waiter.resolve(messageId);
}

/**
 * Resolve a chatId to its send-target form and run one send attempt.
 * Shared by sendText/sendMedia/sendSticker so the multi-device quirk
 * (sendMessage returns null but the message goes out) is handled in
 * exactly one place.
 *
 * Behaviour:
 *   - Phone-format input: pre-resolve via client.getNumberId. If the
 *     account has no LID mapping, throw PHONE_NOT_IN_CONTACTS (422).
 *     Otherwise send to the resolved chatId.
 *   - LID input: resolveLidToPhoneChatId (cache + getChatById fallback).
 *     Throws LID_UNRESOLVED (422) for genuinely cold LIDs.
 *   - sendMessage returning null: wait up to 5s for a matching ack. If
 *     one arrives, synthesize a Message-like object with the real
 *     messageId so the rest of the pipeline records it. If no ack in
 *     5s, throw SEND_NO_MESSAGE (502) — the message may still arrive
 *     but we can't confirm.
 */
async function sendOnceWithAckRecovery({ chatId, content, options, contentKind }) {
  let resolved = chatId;
  let phoneNotInContacts = false;
  if (chatId.endsWith('@c.us') || (!chatId.includes('@') && /^\+?\d+$/.test(chatId))) {
    // Phone-format input — try client.getNumberId() to get a reliable
    // @c.us id. If the account has no LID mapping, getNumberId returns
    // null. We DO NOT reject the send in that case: WA Web Multi-Device
    // will still deliver the message (and fire message_ack) — it just
    // doesn't give us a Message object back. The ack-correlation
    // window below recovers the real messageId when the message
    // actually went out.
    const viaNumber = await resolvePhoneToChatId(chatId);
    if (viaNumber) {
      resolved = viaNumber;
    } else {
      phoneNotInContacts = true;
      // Log but don't throw — let sendMessage try anyway.
      console.warn(
        `[${contentKind}] phone ${chatId} is not in this WA account's ` +
          `contact set; attempting send anyway and waiting for ack`
      );
    }
  } else if (chatId.endsWith('@lid')) {
    resolved = await resolveLidToPhoneChatId(chatId);
  }
  // contentKind === 'text' uses `body` as the ack-correlation key;
  // media/sticker use `caption` (which may be null) — fall back to a
  // empty-string correlation in that case (acks for media still carry
  // the caption as msg.body).
  const correlationKey =
    contentKind === 'text' ? options.bodyForAck || content :
    typeof content === 'string' ? content :
    (options && options.caption) || '';

  let result;
  try {
    result = await client.sendMessage(resolved, content, options);
  } catch (err) {
    // Tag the WA Web server-side errors that mean "this phone is not
    // in your account's contact set" so the API layer can return a
    // stable code. The raw error message is minified (e.g. "No LID for
    // user\ns (https://static.whatsapp.net/rsrc.php/.../...js:84:180)")
    // because it originates in the WA Web page context.
    const msg = (err && err.message) || '';
    if (
      /No LID for user/i.test(msg) ||
      /LID chat.*could not be resolved/i.test(msg) ||
      /\(r\)/i.test(msg) ||
      /\(t\)/i.test(msg)
    ) {
      const wrapped = new Error(
        `WA Web rejected the send: phone "${chatId}" has no LID mapping ` +
          `for this account. The recipient may not be in the linked ` +
          `phone's contacts, or the WA Web session's contact cache is ` +
          `stale. Re-link via /qr or POST /warmup, and verify the phone ` +
          `is added to the linked phone's contacts.`
      );
      wrapped.code = 'NO_LID_FOR_USER';
      wrapped.retryable = false;
      wrapped.cause = err;
      throw wrapped;
    }
    // Anything else is a real session/network failure — bubble as-is.
    throw err;
  }
  if (result !== null && result !== undefined) return result;

  // sendMessage returned no Message object. WA Web Multi-Device does
  // this for phone-format recipients where there's no LID mapping for
  // this account — the message often still goes out, and a
  // message_ack event fires ~1–10 seconds later. Wait for it.
  const ackMessageId = await waitForMatchingAck({
    chatId: resolved,
    body: correlationKey,
    timeoutMs: 10000,
  });
  if (ackMessageId) {
    return {
      messageId: ackMessageId,
      to: resolved,
      from: 'me',
      body: correlationKey,
      type: contentKind === 'text' ? 'chat' : contentKind,
      timestamp: Math.floor(Date.now() / 1000),
      ack: 1,
      _synthesizedFromAck: true,
      _phoneNotInContacts: phoneNotInContacts || undefined,
    };
  }
  const e = new Error(
    `sendMessage (${contentKind}) returned no message and no matching ack ` +
      `arrived within 10s — message may not have been delivered; check ` +
      `/incoming-messages for the recipient's reply to confirm`
  );
  e.code = 'SEND_NO_MESSAGE';
  e.retryable = true;
  throw e;
}

/**
 * Warm a chat by LID — calls `client.getChatById` so the WA Web client
 * loads the chat into its local cache. Useful as a pre-step before a
 * batch of sends, especially right after a fresh session start.
 */
async function warmChat(chatId) {
  if (!chatId.endsWith('@lid') && !chatId.endsWith('@c.us') && !chatId.endsWith('@g.us')) {
    throw new Error(`Invalid chat ID: ${chatId}`);
  }
  try {
    const chat = await client.getChatById(chatId);
    return { ok: true, chatId, loaded: !!chat };
  } catch (err) {
    return { ok: false, chatId, error: err.message };
  }
}

/**
 * Warm the WhatsApp-side contact store by pulling all contacts into the
 * client's in-memory map. Without this, the first `client.getContact(LID)`
 * after a fresh READY is the round-trip that the user pays; after warm-up,
 * every contact lookup is an in-memory hit.
 *
 * Returns the number of contacts loaded. Safe to call any time the client
 * is READY; idempotent (re-calling just refreshes).
 */
let warmContactCachePromise = null;
let waContactCount = 0; // updated each time warmContactCache resolves
async function warmContactCache() {
  if (!isClientReady()) return 0;
  // Coalesce concurrent calls — multiple routes asking for warm-up at once
  // should hit the same round-trip, not stampede the WA Web page.
  if (warmContactCachePromise) return warmContactCachePromise;
  warmContactCachePromise = (async () => {
    try {
      const contacts = await client.getContacts();
      waContactCount = Array.isArray(contacts) ? contacts.length : 0;
      return waContactCount;
    } catch (err) {
      warmContactCachePromise = null; // allow a retry after a failure
      throw err;
    } finally {
      // Resolve the in-flight promise but clear the slot only after a delay
      // so back-to-back callers within the same second share the result.
      setTimeout(() => { warmContactCachePromise = null; }, 1000);
    }
  })();
  return warmContactCachePromise;
}

/**
 * Best-effort count of contacts WA Web has loaded in its in-memory map.
 * Returns the cached count from the last successful warmContactCache call;
 * falls back to 0 if warm-up hasn't run yet (which is also the right
 * answer — the WA-side store really is empty until warm-up completes).
 */
function getContactCount() {
  return waContactCount;
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
  if (!isClientReady()) {
    const err = new Error('WhatsApp client is not ready');
    err.code = 'NOT_READY';
    throw err;
  }

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
  if (!isClientReady()) {
    const err = new Error('WhatsApp client is not ready');
    err.code = 'NOT_READY';
    throw err;
  }
  // `to` is omitted (null/undefined) for reactions — the reaction is applied to
  // the message's own chat, not sent to a separate recipient.
  const chatId = to ? sanitizeRecipient(to) : null;
  const waMsg = await client.getMessageById(messageId);
  if (!waMsg) throw new Error('Message not found');
  await waMsg.react(reaction || '');
  return { ok: true, messageId, reaction };
}

/**
 * Startup assertion: construct a MessageMedia from a real Buffer and
 * confirm the public API shape we depend on. The /send/media and
 * /send/sticker handlers used to call `MessageMedia.fromBuffer(buffer,
 * mimetype)` — a method that has never existed on whatsapp-web.js's
 * public API. The first symptom was a 500 with "MessageMedia.fromBuffer
 * is not a function" on every media send, which looked transient but
 * was a hard code defect.
 *
 * Running this assertion at module load time surfaces a broken build
 * at startup (process.exit(1) with a clear message) instead of at the
 * first /send/media call. Cheap, deterministic, no Puppeteer involved.
 */
(function assertMessageMediaApi() {
  try {
    const probe = Buffer.from('probe');
    const m = new MessageMedia('application/pdf', probe.toString('base64'), 'probe.pdf', probe.length);
    if (m.mimetype !== 'application/pdf' || m.filesize !== probe.length) {
      throw new Error(
        `MessageMedia round-trip failed: mimetype=${m.mimetype} filesize=${m.filesize}`
      );
    }
    if (typeof MessageMedia.fromBuffer === 'function') {
      console.warn(
        'MessageMedia.fromBuffer is present in this whatsapp-web.js version — ' +
          'the legacy call site has been replaced with the public constructor. ' +
          'No action needed; this is informational.'
      );
    }
  } catch (err) {
    console.error(
      '[FATAL] MessageMedia API assertion failed at startup: ' +
        (err && err.message ? err.message : String(err))
    );
    console.error(
      '  This usually means whatsapp-web.js was upgraded and the constructor ' +
        'signature changed. Pin the dependency and rebuild.'
    );
    process.exit(1);
  }
})();

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
  resolveLidToPhoneChatId,
  warmChat,
  warmContactCache,
  getContactCount,
  fetchChatMessages,
  serializeMessage,
  contactCache,
  getRecentRunSummaries: db.getRecentRunSummaries,
};
