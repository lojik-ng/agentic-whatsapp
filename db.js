const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db = null;

/**
 * Initialize the SQLite database.
 * Creates tables for incoming messages and message receipts.
 */
function initDb(dataDir) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'messages.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
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

    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);

    CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      receipt_type TEXT NOT NULL,
      recipient TEXT,
      timestamp INTEGER NOT NULL,
      raw TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_receipts_timestamp ON receipts(timestamp);
  `);

  return db;
}

/**
 * Coerce a value into something SQLite can bind as TEXT.
 *
 * better-sqlite3 treats a plain object argument as a *named parameter* map, not
 * as a value — so an object slipping in here silently shifts the positional
 * bindings and throws "Too few parameter values were provided". Everything that
 * is not a primitive gets flattened before it reaches stmt.run().
 */
function toText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value._serialized === 'string') return value._serialized;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return String(value);
  }
}

/**
 * Coerce a value into an integer, falling back to `fallback` when unusable.
 */
function toInt(value, fallback = null) {
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/**
 * Coerce a message id into a string, or null if it isn't a usable id.
 *
 * Deliberately stricter than toText(): an unrecognised object must NOT be
 * JSON-stringified into the UNIQUE message_id column, where it would masquerade
 * as a real id and never match a lookup.
 */
function toId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value || null;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object' && typeof value._serialized === 'string') {
    return value._serialized || null;
  }
  return null;
}

/**
 * Insert an incoming message.
 *
 * Duplicates (same message_id) are ignored via a targeted ON CONFLICT clause.
 * A blanket `INSERT OR IGNORE` would also swallow NOT NULL violations, silently
 * discarding real messages that happen to be missing a field — so the conflict
 * target is named explicitly and every other constraint failure throws.
 *
 * Returns { stored, duplicate } so callers can tell "already had it" apart from
 * "this was rejected".
 */
function insertMessage(msg) {
  if (!db) return { stored: false, duplicate: false };

  const messageId = toId(msg.messageId);
  if (!messageId) {
    throw new Error(
      `insertMessage: unusable messageId (${JSON.stringify(msg.messageId)})`
    );
  }

  // from_number / chat_id / type are NOT NULL. Rather than drop a real message
  // over a missing field (system notifications often omit `from`), derive what
  // we reasonably can and only fail when there is genuinely nothing to store.
  const from = toText(msg.from) ?? toText(msg.chatId);
  const chatId = toText(msg.chatId) ?? toText(msg.from);
  const type = toText(msg.type) ?? 'unknown';

  if (!from || !chatId) {
    throw new Error(
      `insertMessage: message ${messageId} has neither from nor chatId`
    );
  }

  const stmt = db.prepare(`
    INSERT INTO messages
      (message_id, from_number, from_name, chat_id, type, body, has_media,
       mimetype, filename, timestamp, received_at, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO NOTHING
  `);

  const receivedAt = toInt(msg.receivedAt, Date.now());

  const result = stmt.run(
    messageId,
    from,
    toText(msg.fromName),
    chatId,
    type,
    toText(msg.body),
    msg.hasMedia ? 1 : 0,
    toText(msg.mimetype),
    toText(msg.filename),
    toInt(msg.timestamp, receivedAt),
    receivedAt,
    JSON.stringify(msg.raw || {})
  );

  return { stored: result.changes > 0, duplicate: result.changes === 0 };
}

/**
 * Get messages received within the last `minutes` minutes.
 * Optional `since` parameter (unix ms) gives messages after a specific time.
 */
function getIncomingMessages({ minutes = 60, since = null, markRead = false } = {}) {
  if (!db) return [];

  let cutoff;
  if (typeof since === 'number') {
    cutoff = since;
  } else {
    cutoff = Date.now() - minutes * 60 * 1000;
  }

  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE received_at >= ?
    ORDER BY timestamp ASC
  `).all(cutoff);

  return rows.map(rowToMessage);
}

/**
 * Get a single message by its database id (used for media retrieval).
 */
function getMessageById(id) {
  if (!db) return null;
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  return row ? rowToMessage(row) : null;
}

/**
 * Get a message by its WhatsApp message id (e.g. "false_123...@c.us_ABCDEF").
 */
function getMessageByMessageId(messageId) {
  if (!db) return null;
  const row = db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
  return row ? rowToMessage(row) : null;
}

/**
 * Store a message receipt (delivered, read, etc.).
 */
function insertReceipt(receipt) {
  if (!db) return null;

  const messageId = toId(receipt.messageId);
  if (!messageId) {
    throw new Error(
      `insertReceipt: unusable messageId (${JSON.stringify(receipt.messageId)})`
    );
  }

  const stmt = db.prepare(`
    INSERT INTO receipts (message_id, receipt_type, recipient, timestamp, raw)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(
    messageId,
    toText(receipt.type),
    toText(receipt.recipient),
    toInt(receipt.timestamp, Date.now()),
    JSON.stringify(receipt.raw || {})
  );
}

/**
 * Get receipts received within the last `minutes` minutes.
 */
function getReceipts({ minutes = 60, since = null } = {}) {
  if (!db) return [];

  let cutoff;
  if (typeof since === 'number') {
    cutoff = since;
  } else {
    cutoff = Date.now() - minutes * 60 * 1000;
  }

  return db.prepare(`
    SELECT * FROM receipts
    WHERE timestamp >= ?
    ORDER BY timestamp ASC
  `).all(cutoff);
}

/**
 * Convert a raw database row to a clean message object.
 */
function rowToMessage(row) {
  return {
    id: row.id,
    messageId: row.message_id,
    from: row.from_number,
    fromName: row.from_name,
    chatId: row.chat_id,
    type: row.type,
    body: row.body,
    hasMedia: row.has_media === 1,
    mimetype: row.mimetype,
    filename: row.filename,
    timestamp: row.timestamp,
    receivedAt: row.received_at,
  };
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initDb,
  insertMessage,
  getIncomingMessages,
  getMessageById,
  getMessageByMessageId,
  insertReceipt,
  getReceipts,
  closeDb,
};
