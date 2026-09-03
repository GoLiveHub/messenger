import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// NOTE: DB_DRIVER=postgres is not implemented. Only SQLite is supported.
if (config.dbDriver === 'postgres') {
  throw new Error('PostgreSQL is not supported yet. Remove DB_DRIVER env or set it to "sqlite".');
}

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    phone          TEXT NOT NULL UNIQUE,
    username       TEXT NOT NULL UNIQUE,
    first_name     TEXT NOT NULL,
    last_name      TEXT NOT NULL DEFAULT '',
    bio            TEXT NOT NULL DEFAULT '',
    photo          TEXT,               -- data URL avatar, NULL = none
    password       TEXT,               -- scrypt hash for 2FA, NULL = disabled
    recovery_email TEXT,               -- 2FA recovery email
    birthday       TEXT,               -- YYYY-MM-DD, NULL = not set
    settings       TEXT NOT NULL DEFAULT '{}',  -- JSON: theme, notifications, media
    e2e_public     TEXT,               -- JSON JWK of ECDH P-256 public key
    e2e_fp         TEXT,               -- SHA-256 fingerprint of public key (hex)
    totp_secret    TEXT,               -- TOTP secret (base32), NULL = disabled
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash   TEXT NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at   TEXT NOT NULL,
    label        TEXT,
    last_seen_at TEXT
  );

  CREATE TABLE IF NOT EXISTS blocks (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, blocked_id)
  );

  CREATE TABLE IF NOT EXISTS auth_codes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    phone           TEXT NOT NULL,
    code_hash       TEXT NOT NULL,        -- sha256(code)
    phone_code_hash TEXT NOT NULL,        -- Telegram-style opaque handle
    expires_at      TEXT NOT NULL,
    used            INTEGER NOT NULL DEFAULT 0,
    attempts        INTEGER NOT NULL DEFAULT 0,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    last_sent_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS chats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL CHECK (kind IN ('regular', 'secret', 'group', 'channel')),
    user_a_id  INTEGER NOT NULL REFERENCES users(id),
    user_b_id  INTEGER REFERENCES users(id),  -- NULL for groups/channels
    hidden_a   INTEGER NOT NULL DEFAULT 0,    -- 1 = user_a deleted the chat for themselves
    hidden_b   INTEGER NOT NULL DEFAULT 0,    -- 1 = user_b deleted the chat for themselves
    archived_a INTEGER NOT NULL DEFAULT 0,
    archived_b INTEGER NOT NULL DEFAULT 0,
    title      TEXT,                          -- groups/channels
    about      TEXT NOT NULL DEFAULT '',      -- groups/channels description
    photo      TEXT,                          -- groups/channels avatar (data URL)
    username   TEXT,                          -- public group/channel username
    pinned_id  INTEGER,                       -- pinned message id (global for the chat)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    promoted_by  INTEGER,
    rank         TEXT NOT NULL DEFAULT '',
    muted        INTEGER NOT NULL DEFAULT 0,  -- per-user mute flag
    archived     INTEGER NOT NULL DEFAULT 0,  -- per-user archive flag
    pinned       INTEGER NOT NULL DEFAULT 0,  -- per-user pinned flag
    last_read_id INTEGER NOT NULL DEFAULT 0,  -- per-user read cursor for unread counts
    joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members (user_id, chat_id);

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id  INTEGER NOT NULL REFERENCES users(id),
    client_id  TEXT,
    body       BLOB,                       -- ciphertext (server-encrypted or client-E2E)
    iv         BLOB,
    e2e        INTEGER NOT NULL DEFAULT 0, -- 1 = client-side encrypted (secret chat)
    read_at    TEXT,
    edited_at  TEXT,
    deleted    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chats_pair ON chats (user_a_id, user_b_id, kind);
  CREATE INDEX IF NOT EXISTS idx_msgs_chat ON messages (chat_id, id);
`);

// idempotent column adds for older databases
const columns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
const have = new Set(columns.map((c) => c.name));
if (!have.has('read_at')) db.exec('ALTER TABLE messages ADD COLUMN read_at TEXT');
if (!have.has('edited_at')) db.exec('ALTER TABLE messages ADD COLUMN edited_at TEXT');
if (!have.has('deleted')) db.exec('ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
if (!have.has('client_id')) db.exec('ALTER TABLE messages ADD COLUMN client_id TEXT');

// Phase 7: delete-for-me, disappearing messages
const msgCols3 = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
const msgHave3 = new Set(msgCols3.map((c) => c.name));
if (!msgHave3.has('deleted_for')) db.exec("ALTER TABLE messages ADD COLUMN deleted_for TEXT NOT NULL DEFAULT '[]'");
if (!msgHave3.has('expires_at')) db.exec('ALTER TABLE messages ADD COLUMN expires_at TEXT');

const codeColumns = db.prepare('PRAGMA table_info(auth_codes)').all() as { name: string }[];
const codeHave = new Set(codeColumns.map((c) => c.name));
if (!codeHave.has('attempts')) db.exec('ALTER TABLE auth_codes ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
if (!codeHave.has('last_sent_at')) db.exec('ALTER TABLE auth_codes ADD COLUMN last_sent_at TEXT');
if (!codeHave.has('failed_attempts')) db.exec('ALTER TABLE auth_codes ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0');

// idempotent column adds for older databases
const userCols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
const userHave = new Set(userCols.map((c) => c.name));
if (!userHave.has('last_name')) db.exec("ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT ''");
if (!userHave.has('bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
if (!userHave.has('photo')) db.exec('ALTER TABLE users ADD COLUMN photo TEXT');
if (!userHave.has('settings')) db.exec("ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'");
if (!userHave.has('recovery_email')) db.exec('ALTER TABLE users ADD COLUMN recovery_email TEXT');
if (!userHave.has('birthday')) db.exec('ALTER TABLE users ADD COLUMN birthday TEXT');
if (!userHave.has('e2e_public')) db.exec('ALTER TABLE users ADD COLUMN e2e_public TEXT');
if (!userHave.has('e2e_fp')) db.exec('ALTER TABLE users ADD COLUMN e2e_fp TEXT');

const sessionCols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
const sessionHave = new Set(sessionCols.map((c) => c.name));
if (!sessionHave.has('label')) db.exec('ALTER TABLE sessions ADD COLUMN label TEXT');
if (!sessionHave.has('last_seen_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');

const chatCols = db.prepare('PRAGMA table_info(chats)').all() as { name: string }[];
const chatHave = new Set(chatCols.map((c) => c.name));
if (!chatHave.has('hidden_a')) db.exec('ALTER TABLE chats ADD COLUMN hidden_a INTEGER NOT NULL DEFAULT 0');
if (!chatHave.has('hidden_b')) db.exec('ALTER TABLE chats ADD COLUMN hidden_b INTEGER NOT NULL DEFAULT 0');
if (!chatHave.has('archived_a')) db.exec('ALTER TABLE chats ADD COLUMN archived_a INTEGER NOT NULL DEFAULT 0');
if (!chatHave.has('archived_b')) db.exec('ALTER TABLE chats ADD COLUMN archived_b INTEGER NOT NULL DEFAULT 0');
if (!chatHave.has('pinned_a')) db.exec('ALTER TABLE chats ADD COLUMN pinned_a INTEGER NOT NULL DEFAULT 0');
if (!chatHave.has('pinned_b')) db.exec('ALTER TABLE chats ADD COLUMN pinned_b INTEGER NOT NULL DEFAULT 0');
if (!chatHave.has('slow_mode_seconds')) db.exec('ALTER TABLE chats ADD COLUMN slow_mode_seconds INTEGER NOT NULL DEFAULT 0');
if (!chatHave.has('discussion_chat_id')) db.exec('ALTER TABLE chats ADD COLUMN discussion_chat_id INTEGER');

// Channel post view counts
const msgCols4 = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
const msgHave4 = new Set(msgCols4.map((c) => c.name));
if (!msgHave4.has('views')) db.exec('ALTER TABLE messages ADD COLUMN views INTEGER NOT NULL DEFAULT 0');

const memberCols = db.prepare('PRAGMA table_info(chat_members)').all() as { name: string }[];
const memberHave = new Set(memberCols.map((c) => c.name));
if (!memberHave.has('muted_until')) db.exec('ALTER TABLE chat_members ADD COLUMN muted_until TEXT');
if (!memberHave.has('notify_level')) db.exec("ALTER TABLE chat_members ADD COLUMN notify_level TEXT NOT NULL DEFAULT 'all'");

// Web Push subscriptions
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, endpoint)
  );
`);

// messages: media reference, reply-to, forwarded-from
const msgCols2 = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
const msgHave2 = new Set(msgCols2.map((c) => c.name));
if (!msgHave2.has('media_id')) db.exec('ALTER TABLE messages ADD COLUMN media_id INTEGER');
if (!msgHave2.has('reply_to')) db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
if (!msgHave2.has('forwarded_from')) db.exec('ALTER TABLE messages ADD COLUMN forwarded_from TEXT');

// --- migrate legacy `chats` table (was CHECK(kind IN ('regular','secret'))) ---
// Rebuild without dropping rows: groups/channels need a wider kind, title/about/photo
// and a nullable user_b_id. PRAGMA foreign_keys must stay OFF during the rename.
function migrateChatsTable() {
  const colRows = db.prepare('PRAGMA table_info(chats)').all() as { name: string }[];
  const names = new Set(colRows.map((c) => c.name));
  if (names.has('title')) return;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    BEGIN;
    ALTER TABLE chats RENAME TO chats_old;
    CREATE TABLE chats (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL CHECK (kind IN ('regular', 'secret', 'group', 'channel')),
      user_a_id  INTEGER NOT NULL REFERENCES users(id),
      user_b_id  INTEGER REFERENCES users(id),
      hidden_a   INTEGER NOT NULL DEFAULT 0,
      hidden_b   INTEGER NOT NULL DEFAULT 0,
      archived_a INTEGER NOT NULL DEFAULT 0,
      archived_b INTEGER NOT NULL DEFAULT 0,
      pinned_a   INTEGER NOT NULL DEFAULT 0,
      pinned_b   INTEGER NOT NULL DEFAULT 0,
      title      TEXT,
      about      TEXT NOT NULL DEFAULT '',
      photo      TEXT,
      username   TEXT,
      pinned_id  INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO chats (id, kind, user_a_id, user_b_id, hidden_a, hidden_b, archived_a, archived_b, pinned_a, pinned_b, created_at)
      SELECT id, kind, user_a_id, user_b_id, hidden_a, hidden_b, archived_a, archived_b, pinned_a, pinned_b, created_at FROM chats_old;
    DROP TABLE chats_old;
    CREATE INDEX IF NOT EXISTS idx_chats_pair ON chats (user_a_id, user_b_id, kind);
    COMMIT;
  `);
  db.exec('PRAGMA foreign_keys = ON');
}
migrateChatsTable();

// --- repair dangling FKs ---
// The legacy `chats` migration renames chats -> chats_old, which makes SQLite
// rewrite FK references in other tables to point at chats_old. After the new
// `chats` table is created and chats_old dropped, those FKs dangle. Rebuild the
// affected tables against the live `chats` table (data-preserving).
function repairDanglingFks() {
  const dangling = (t: string) =>
    (db.prepare(`PRAGMA foreign_key_list(${t})`).all() as { table: string }[]).some((f) => f.table === 'chats_old');
  if (!dangling('chat_members') && !dangling('messages') && !dangling('media')) return;

  const defs: Record<string, { create: string; copyCols: string; index?: string }> = {
    chat_members: {
      create: `
        CREATE TABLE chat_members_new (
          chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
          promoted_by  INTEGER,
          rank         TEXT NOT NULL DEFAULT '',
          muted        INTEGER NOT NULL DEFAULT 0,
          archived     INTEGER NOT NULL DEFAULT 0,
          pinned       INTEGER NOT NULL DEFAULT 0,
          last_read_id INTEGER NOT NULL DEFAULT 0,
          joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (chat_id, user_id)
        );`,
      copyCols: 'chat_id, user_id, role, promoted_by, rank, muted, archived, pinned, last_read_id, joined_at',
      index: 'CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members (user_id, chat_id);',
    },
    messages: {
      create: `
        CREATE TABLE messages_new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          sender_id  INTEGER NOT NULL REFERENCES users(id),
          client_id  TEXT,
          body       BLOB,
          iv         BLOB,
          e2e        INTEGER NOT NULL DEFAULT 0,
          read_at    TEXT,
          edited_at  TEXT,
          deleted    INTEGER NOT NULL DEFAULT 0,
          media_id   INTEGER,
          reply_to   INTEGER,
          forwarded_from TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );`,
      copyCols: 'id, chat_id, sender_id, client_id, body, iv, e2e, read_at, edited_at, deleted, media_id, reply_to, forwarded_from, created_at',
      index: 'CREATE INDEX IF NOT EXISTS idx_msgs_chat ON messages (chat_id, id);',
    },
    media: {
      create: `
        CREATE TABLE media_new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
          sender_id  INTEGER NOT NULL REFERENCES users(id),
          kind       TEXT NOT NULL DEFAULT 'file',
          name       TEXT NOT NULL DEFAULT '',
          mime       TEXT NOT NULL DEFAULT '',
          size       INTEGER NOT NULL DEFAULT 0,
          body       BLOB,
          iv         BLOB,
          duration   REAL,
          width      INTEGER,
          height     INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );`,
      copyCols: 'id, chat_id, sender_id, kind, name, mime, size, body, iv, duration, width, height, created_at',
      index: 'CREATE INDEX IF NOT EXISTS idx_media_chat ON media (chat_id, id);',
    },
  };

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const [name, def] of Object.entries(defs)) {
      if (!dangling(name)) continue;
      db.exec(`
        BEGIN;
        ${def.create}
        INSERT INTO ${name}_new (${def.copyCols}) SELECT ${def.copyCols} FROM ${name};
        DROP TABLE ${name};
        ALTER TABLE ${name}_new RENAME TO ${name};
        ${def.index ?? ''}
        COMMIT;
      `);
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
repairDanglingFks();

db.exec(`
  CREATE TABLE IF NOT EXISTS media (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id  INTEGER NOT NULL REFERENCES users(id),
    kind       TEXT NOT NULL DEFAULT 'file',      -- photo | file | audio
    name       TEXT NOT NULL DEFAULT '',
    mime       TEXT NOT NULL DEFAULT '',
    size       INTEGER NOT NULL DEFAULT 0,
    body       BLOB,                              -- server-encrypted at rest
    iv         BLOB,
    duration   REAL,                              -- audio duration (seconds)
    width      INTEGER,
    height     INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    emoji      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_media_chat ON media (chat_id, id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_msgs_client_id ON messages (chat_id, sender_id, client_id) WHERE client_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_auth_codes_phone ON auth_codes (phone);
  CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (chat_id, sender_id, read_at, id) WHERE deleted = 0;

  CREATE TABLE IF NOT EXISTS recovery_codes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes (user_id);

  CREATE TABLE IF NOT EXISTS phone_change_codes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    new_phone       TEXT NOT NULL,
    code_hash       TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    used            INTEGER NOT NULL DEFAULT 0,
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS e2e_signed_prekeys (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prekey_id       INTEGER NOT NULL,
    public_jwk      TEXT NOT NULL,
    signature       TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, prekey_id)
  );

  CREATE INDEX IF NOT EXISTS idx_signed_prekeys_user ON e2e_signed_prekeys (user_id);

  CREATE TABLE IF NOT EXISTS e2e_one_time_prekeys (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prekey_id       INTEGER NOT NULL,
    public_jwk      TEXT NOT NULL,
    consumed        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, prekey_id)
  );

  CREATE INDEX IF NOT EXISTS idx_one_time_prekeys_user ON e2e_one_time_prekeys (user_id, consumed);

  CREATE TABLE IF NOT EXISTS e2e_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id         INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    receiver_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    root_key        TEXT NOT NULL,
    chain_key_send  TEXT NOT NULL,
    chain_key_recv  TEXT NOT NULL,
    dh_send         TEXT,
    dh_recv         TEXT,
    message_num     INTEGER NOT NULL DEFAULT 0,
    prev_chain_len  INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(chat_id, sender_id, receiver_id)
  );

  CREATE INDEX IF NOT EXISTS idx_e2e_sessions_chat ON e2e_sessions (chat_id);

  CREATE TABLE IF NOT EXISTS e2e_devices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_label TEXT NOT NULL DEFAULT '',
    identity_key TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_e2e_devices_user ON e2e_devices (user_id);

  CREATE TABLE IF NOT EXISTS saved_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    chat_id     INTEGER,
    body        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_messages (user_id);

  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    body        TEXT,
    media_id    INTEGER,
    reply_to    INTEGER,
    scheduled_at TEXT NOT NULL,
    sent        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_messages (sent, scheduled_at);

  CREATE TABLE IF NOT EXISTS folders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    emoji       TEXT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_folders_user ON folders (user_id);

  CREATE TABLE IF NOT EXISTS folder_chats (
    folder_id   INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    PRIMARY KEY (folder_id, chat_id)
  );

  CREATE TABLE IF NOT EXISTS invite_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    creator_id  INTEGER NOT NULL REFERENCES users(id),
    token       TEXT NOT NULL UNIQUE,
    max_uses    INTEGER,
    uses        INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_invite_token ON invite_links (token);

  CREATE TABLE IF NOT EXISTS group_bans (
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by   INTEGER NOT NULL REFERENCES users(id),
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );
`);

// FTS5 for full-text message search
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      chat_id UNINDEXED,
      sender_id UNINDEXED,
      text_content,
      created_at UNINDEXED
    );
  `);
} catch {
  // FTS5 may not be available in all SQLite builds
}

// Drop the old empty-text trigger; FTS is now populated manually in sockets.ts
try { db.exec(`DROP TRIGGER IF EXISTS messages_ai`); } catch { /* ignore */ }

// --- Sticker packs ---
db.exec(`
  CREATE TABLE IF NOT EXISTS sticker_packs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    owner_id    INTEGER REFERENCES users(id),
    emoji       TEXT,
    thumbnail   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stickers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pack_id     INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    file_id     INTEGER REFERENCES media(id),
    emoji       TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_sticker_packs (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pack_id     INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, pack_id)
  );
`);

// --- Moderation: reports ---
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL REFERENCES users(id),
    target_type TEXT NOT NULL CHECK (target_type IN ('message', 'user', 'chat')),
    target_id   INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    details     TEXT,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
    reviewed_by INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status);
`);

// --- Edit history ---
db.exec(`
  CREATE TABLE IF NOT EXISTS edit_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    old_body    BLOB,
    old_iv      BLOB,
    edited_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_edit_history_msg ON edit_history (message_id);
`);

// --- Admin action log ---
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id    INTEGER NOT NULL REFERENCES users(id),
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   INTEGER,
    details     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_admin_log_admin ON admin_log (admin_id, created_at);
`);

// --- Suspicious activity log (persistent) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS suspicious_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,
    user_id     INTEGER,
    ip          TEXT,
    details     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_suspicious_type ON suspicious_events (type, created_at);
  CREATE INDEX IF NOT EXISTS idx_suspicious_ip ON suspicious_events (ip, created_at);
`);

// --- Join requests ---
db.exec(`
  CREATE TABLE IF NOT EXISTS join_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reviewed_by INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    UNIQUE(chat_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_join_requests_chat ON join_requests (chat_id, status);
`);

// --- Link blacklists ---
db.exec(`
  CREATE TABLE IF NOT EXISTS link_blacklist (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern     TEXT NOT NULL UNIQUE,
    reason      TEXT,
    created_by  INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- Custom emoji ---
db.exec(`
  CREATE TABLE IF NOT EXISTS custom_emoji (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    shortcut    TEXT NOT NULL,
    emoji_url   TEXT NOT NULL,
    creator_id  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(chat_id, shortcut)
  );
  CREATE INDEX IF NOT EXISTS idx_custom_emoji_chat ON custom_emoji (chat_id);
`);

// --- Shadow bans ---
db.exec(`
  CREATE TABLE IF NOT EXISTS shadow_bans (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    banned_by   INTEGER REFERENCES users(id),
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- Call history ---
db.exec(`
  CREATE TABLE IF NOT EXISTS call_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    caller_id   INTEGER NOT NULL REFERENCES users(id),
    call_type   TEXT NOT NULL CHECK (call_type IN ('audio', 'video')),
    status      TEXT NOT NULL CHECK (status IN ('missed', 'outgoing', 'incoming', 'completed')),
    duration    INTEGER,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_call_history_chat ON call_history (chat_id, started_at);
`);

// --- Admin ---
try { db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE messages ADD COLUMN delivered_at TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE messages ADD COLUMN service INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'sent'`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE messages ADD COLUMN hashtags TEXT NOT NULL DEFAULT '[]'`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE messages ADD COLUMN thread_id INTEGER`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE chats ADD COLUMN max_members INTEGER NOT NULL DEFAULT 200000`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE chats ADD COLUMN kind_new TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE chats ADD COLUMN pinned_messages TEXT NOT NULL DEFAULT '[]'`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE chats ADD COLUMN folder_filters TEXT`); } catch { /* already exists */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS global_bans (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reason      TEXT,
    banned_by   INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// Make the first registered user an admin automatically
db.exec(`UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users) AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)`);

try { db.exec("CREATE TABLE IF NOT EXISTS drafts (user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, chat_id INTEGER NOT NULL, text TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY(user_id, chat_id))"); } catch {}
try { db.exec("ALTER TABLE chats ADD COLUMN is_deleted INTEGER DEFAULT 0"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE chat_members ADD COLUMN muted_until TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE chat_members ADD COLUMN notify_mentions_only INTEGER DEFAULT 0"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN quiet_hours_start TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN quiet_hours_end TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE messages ADD COLUMN client_timestamp TEXT"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT"); } catch { /* already exists */ }

try {
  db.exec("CREATE TABLE IF NOT EXISTS block_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, blocked_user_id INTEGER NOT NULL, action TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))");
} catch {}

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
} catch {}

try {
  db.exec("CREATE TABLE IF NOT EXISTS bots (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', webhook_url TEXT DEFAULT '', is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))");
} catch {}
try { db.exec('ALTER TABLE bots ADD COLUMN owner_id INTEGER'); } catch { /* already exists */ }

// --- Custom reactions: reactions keyed per (message, user, emoji) ---
try {
  db.exec("CREATE TABLE IF NOT EXISTS reactions (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, emoji TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), UNIQUE(message_id, user_id, emoji))");
} catch { /* ignore */ }

// Legacy reactions tables used PRIMARY KEY (message_id, user_id) which allowed only
// one reaction per user per message. Rebuild data-preserving to the multi-emoji schema.
function migrateReactionsTable() {
  const cols = db.prepare('PRAGMA table_info(reactions)').all() as { name: string }[];
  if (cols.length === 0 || cols.some((c) => c.name === 'id')) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE reactions_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        emoji      TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(message_id, user_id, emoji)
      );
      INSERT OR IGNORE INTO reactions_new (id, message_id, user_id, emoji, created_at)
        SELECT id, message_id, user_id, emoji, created_at FROM reactions;
      DROP TABLE reactions;
      ALTER TABLE reactions_new RENAME TO reactions;
      COMMIT;
    `);
  } catch { /* keep legacy table on failure */ }
  finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
migrateReactionsTable();

// --- Forums inside groups ---
try { db.exec("ALTER TABLE chats ADD COLUMN is_forum INTEGER DEFAULT 0"); } catch { /* already exists */ }
try { db.exec("ALTER TABLE messages ADD COLUMN topic_id INTEGER"); } catch { /* already exists */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS forum_topics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_forum_topics_chat ON forum_topics (chat_id, id);
`);

// Migrate chat_members to allow 'editor' role
function migrateEditorRole() {
  // Idempotent guard: skip if the table already allows 'editor'
  try {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_members'").get() as { sql?: string } | undefined;
    if (ddl?.sql && /\beditor\b/.test(ddl.sql)) return;
  } catch { /* if we cannot inspect, fall through to the rebuild path */ }
  const colRows = db.prepare('PRAGMA table_info(chat_members)').all() as { name: string }[];
  const names = new Set(colRows.map((c) => c.name));
  // Check if the CHECK constraint needs updating by testing an insert
  try {
    // Try inserting a dummy row with 'editor' to test the CHECK constraint
    // If it fails with CHECK constraint violation, we need to rebuild
    const testChat = db.prepare('SELECT id FROM chats LIMIT 1').get() as { id: number } | undefined;
    if (!testChat) return;
    const testUser = db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number } | undefined;
    if (!testUser) return;
    // We can't actually test without affecting data, so just rebuild if needed
  } catch { /* ignore */ }

  // Rebuild chat_members with editor role in CHECK constraint
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      CREATE TABLE chat_members_new (
        chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'editor')),
        promoted_by  INTEGER,
        rank         TEXT NOT NULL DEFAULT '',
        muted        INTEGER NOT NULL DEFAULT 0,
        muted_until  TEXT,
        archived     INTEGER NOT NULL DEFAULT 0,
        pinned       INTEGER NOT NULL DEFAULT 0,
        last_read_id INTEGER NOT NULL DEFAULT 0,
        notify_level TEXT NOT NULL DEFAULT 'all',
        notify_mentions_only INTEGER NOT NULL DEFAULT 0,
        joined_at    TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (chat_id, user_id)
      );
      INSERT INTO chat_members_new (chat_id, user_id, role, promoted_by, rank, muted, muted_until, archived, pinned, last_read_id, notify_level, notify_mentions_only, joined_at)
        SELECT chat_id, user_id, role, promoted_by, rank, muted, muted_until, archived, pinned, last_read_id, notify_level, notify_mentions_only, joined_at FROM chat_members;
      DROP TABLE chat_members;
      ALTER TABLE chat_members_new RENAME TO chat_members;
      CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members (user_id, chat_id);
      COMMIT;
    `);
  } catch {
    // If rebuild fails, the old constraint is still in place
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
migrateEditorRole();

// --- Object Storage key for media ---
try { db.exec("ALTER TABLE media ADD COLUMN storage_key TEXT"); } catch { /* already exists */ }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_media_storage ON media (storage_key) WHERE storage_key IS NOT NULL"); } catch { /* already exists */ }

// --- APNs tokens ---
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS apns_tokens (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
} catch { /* already exists */ }

// --- Permission matrix per chat ---
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_permissions (
      chat_id            INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      permission         TEXT NOT NULL DEFAULT 'all',
      role_required      TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (chat_id, permission)
    );
  `);
} catch { /* already exists */ }

// --- Media thumbnails ---
try { db.exec("ALTER TABLE media ADD COLUMN thumbnail BLOB"); } catch { /* already exists */ }

// --- Chat last_message_at for auto-archive ---
try { db.exec("ALTER TABLE chats ADD COLUMN last_message_at TEXT"); } catch { /* already exists */ }
try { db.exec("UPDATE chats SET last_message_at = (SELECT MAX(created_at) FROM messages WHERE messages.chat_id = chats.id) WHERE last_message_at IS NULL"); } catch { /* ignore */ }
