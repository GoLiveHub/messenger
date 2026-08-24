import { db } from './db.js';
import { randomToken, sha256Hex } from './crypto.js';
import { config } from './config.js';

export interface UserRow {
  id: number;
  phone: string;
  username: string;
  first_name: string;
  last_name: string;
  bio: string;
  photo: string | null;
  password: string | null;
  recovery_email: string | null;
  birthday: string | null;
  settings: string;
  e2e_public: string | null;
  e2e_fp: string | null;
  totp_secret: string | null;
  is_admin: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  created_at: string;
}

export interface ChatRow {
  id: number;
  kind: 'regular' | 'secret' | 'group' | 'channel';
  user_a_id: number;
  user_b_id: number | null;
  hidden_a: number;
  hidden_b: number;
  archived_a: number;
  archived_b: number;
  title: string | null;
  about: string;
  photo: string | null;
  username: string | null;
  pinned_id: number | null;
  created_at: string;
}

export interface ChatMemberRow {
  chat_id: number;
  user_id: number;
  role: 'owner' | 'admin' | 'member';
  promoted_by: number | null;
  rank: string;
  muted: number;
  muted_until: string | null;
  notify_level: string;
  notify_mentions_only: number;
  archived: number;
  pinned: number;
  last_read_id: number;
  joined_at: string;
}

export interface MessageRow {
  id: number;
  chat_id: number;
  sender_id: number;
  body: Buffer | null;
  iv: Buffer | null;
  e2e: number;
  created_at: string;
}

export function parseSettings(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    phone: u.phone,
    username: u.username,
    first_name: u.first_name,
    last_name: u.last_name,
    bio: u.bio,
    photo: u.photo,
    settings: parseSettings(u.settings),
    has_2fa: Boolean(u.password),
    recovery_email: u.recovery_email,
    birthday: u.birthday ?? null,
    e2e_public: (() => { try { return u.e2e_public ? JSON.parse(u.e2e_public) : null; } catch { return null; } })(),
    e2e_fp: u.e2e_fp,
    is_admin: u.is_admin,
    quiet_hours_start: u.quiet_hours_start ?? null,
    quiet_hours_end: u.quiet_hours_end ?? null,
  };
}

// --- privacy (Telegram-style "Who can see…" settings) ---

export const PRIVACY_KEYS = ['last_seen', 'phone', 'photo', 'bio', 'birthday', 'groups', 'forwarded', 'find_me'] as const;
export type PrivacyKey = (typeof PRIVACY_KEYS)[number];
export type PrivacyValue = 'everybody' | 'contacts' | 'nobody';

export function privacySetting(u: UserRow, key: PrivacyKey): PrivacyValue {
  const p = parseSettings(u.settings)?.privacy as Record<string, unknown> | undefined;
  const v = p?.[key];
  return v === 'everybody' || v === 'contacts' || v === 'nobody' ? v : 'everybody';
}

// True if a chat exists between two users (used as the "my contacts" approximation).
export function hasChatWith(a: number, b: number): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Boolean(db.prepare('SELECT 1 FROM chats WHERE user_a_id = ? AND user_b_id = ?').get(lo, hi));
}

// May `viewerId` see `key` of target user `u`? The owner always sees everything.
export function privacyAllows(u: UserRow, viewerId: number | null, key: PrivacyKey): boolean {
  if (viewerId === u.id) return true;
  if (!viewerId) return false;
  const v = privacySetting(u, key);
  if (v === 'everybody') return true;
  if (v === 'nobody') return false;
  return hasChatWith(u.id, viewerId);
}

// Public user as seen by a specific viewer: applies privacy scrubbing.
// `settings` is only sent to the owner (it contains the privacy config itself).
export function publicUserFor(u: UserRow, viewerId: number | null) {
  const user = publicUser(u);
  const lastSeenVisible = privacyAllows(u, viewerId, 'last_seen');
  if (viewerId !== u.id) {
    delete (user as any).settings;
    delete (user as any).recovery_email;
    if (!privacyAllows(u, viewerId, 'phone')) user.phone = '';
    if (!privacyAllows(u, viewerId, 'photo')) user.photo = null;
    if (!privacyAllows(u, viewerId, 'bio')) user.bio = '';
    if (!privacyAllows(u, viewerId, 'birthday')) (user as any).birthday = null;
  }
  (user as any).last_seen_visible = lastSeenVisible;
  return user;
}

export function getUserById(id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function isAdmin(userId: number): boolean {
  const u = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId) as { is_admin: number } | undefined;
  return !!u?.is_admin;
}

// Sender identity attached to message DTOs (names/photo are visible to chat members).
export function senderUserDTO(userId: number) {
  const u = getUserById(userId);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    first_name: u.first_name,
    last_name: u.last_name,
    photo: u.photo,
  };
}

export function getUserByPhone(phone: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) as UserRow | undefined;
}

export function getUserByUsername(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function createSession(userId: number, label?: string): string {
  const token = randomToken();
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, label, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(
    tokenHash,
    userId,
    expiresAt,
    label ?? null,
    new Date().toISOString(),
  );
  return token;
}

export function getSessionByToken(token: string): { id: number; user_id: number } | undefined {
  const row = db.prepare('SELECT id, user_id, last_seen_at FROM sessions WHERE token_hash = ? AND expires_at > ?').get(
    sha256Hex(token),
    new Date().toISOString(),
  ) as { id: number; user_id: number; last_seen_at: string | null } | undefined;
  if (row && (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > 60_000)) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  }
  return row ? { id: row.id, user_id: row.user_id } : undefined;
}

export function getUserIdByToken(token: string): number | null {
  return getSessionByToken(token)?.user_id ?? null;
}

export function listSessions(userId: number) {
  return db
    .prepare('SELECT id, created_at, expires_at, label, last_seen_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC, id DESC')
    .all(userId) as Array<{
    id: number;
    created_at: string;
    expires_at: string;
    label: string | null;
    last_seen_at: string | null;
  }>;
}

export function deleteSession(sessionId: number, userId: number): boolean {
  const res = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(sessionId, userId);
  return Number(res.changes) > 0;
}

export function deleteAllSessions(userId: number): number {
  const res = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return Number(res.changes);
}

// --- blocked users ---

export function isBlocked(byUserId: number, targetUserId: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?').get(byUserId, targetUserId));
}

export function listBlockedIds(userId: number): number[] {
  const rows = db.prepare('SELECT blocked_id FROM blocks WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Array<{
    blocked_id: number;
  }>;
  return rows.map((r) => r.blocked_id);
}

export function addBlock(userId: number, blockedId: number): void {
  db.prepare('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)').run(userId, blockedId);
}

export function removeBlock(userId: number, blockedId: number): void {
  db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?').run(userId, blockedId);
}

// Chats are stored with user_a_id < user_b_id for uniqueness.
export function getOrCreateChat(kind: 'regular' | 'secret', userId: number, peerId: number): ChatRow {
  const a = Math.min(userId, peerId);
  const b = Math.max(userId, peerId);
  let chat = db.prepare('SELECT * FROM chats WHERE kind = ? AND user_a_id = ? AND user_b_id = ?').get(kind, a, b) as ChatRow | undefined;
  if (!chat) {
    const res = db.prepare('INSERT INTO chats (kind, user_a_id, user_b_id) VALUES (?, ?, ?)').run(kind, a, b);
    chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(Number(res.lastInsertRowid)) as unknown as ChatRow;
  }
  return chat;
}

export function chatBetween(kind: 'regular' | 'secret', userId: number, peerId: number): ChatRow | undefined {
  const a = Math.min(userId, peerId);
  const b = Math.max(userId, peerId);
  return db.prepare('SELECT * FROM chats WHERE kind = ? AND user_a_id = ? AND user_b_id = ?').get(kind, a, b) as ChatRow | undefined;
}

// --- groups / channels ---

export function getChatById(chatId: number): ChatRow | undefined {
  return db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as ChatRow | undefined;
}

export function isGroupChat(chat: { kind: string }): boolean {
  return chat.kind === 'group' || chat.kind === 'channel';
}

export function isChatMember(chatId: number, userId: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId));
}

export function getChatMember(chatId: number, userId: number): ChatMemberRow | undefined {
  return db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId) as ChatMemberRow | undefined;
}

export function chatMemberRole(chatId: number, userId: number): 'owner' | 'admin' | 'editor' | 'member' | null {
  const m = getChatMember(chatId, userId);
  return m?.role ?? null;
}

export function addChatMember(chatId: number, userId: number, role: 'owner' | 'admin' | 'member' | 'editor' = 'member', promotedBy?: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, promoted_by, joined_at) VALUES (?, ?, ?, ?, ?)',
  ).run(chatId, userId, role, promotedBy ?? null, new Date().toISOString());
}

export function removeChatMember(chatId: number, userId: number): void {
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
}

export function setChatMemberRole(chatId: number, userId: number, role: 'admin' | 'member' | 'editor', promotedBy: number): void {
  db.prepare('UPDATE chat_members SET role = ?, promoted_by = ? WHERE chat_id = ? AND user_id = ?').run(
    role,
    promotedBy,
    chatId,
    userId,
  );
}

export function listChatMembers(chatId: number): ChatMemberRow[] {
  return db.prepare('SELECT * FROM chat_members WHERE chat_id = ? ORDER BY joined_at').all(chatId) as unknown as ChatMemberRow[];
}

// Returns the chat only if the user is a participant, otherwise undefined.
export function getChatForUser(chatId: number, userId: number): ChatRow | undefined {
  const chat = getChatById(chatId);
  if (!chat) return undefined;
  if (isGroupChat(chat)) {
    if (!isChatMember(chatId, userId)) return undefined;
    return chat;
  }
  if (chat.user_a_id !== userId && chat.user_b_id !== userId) return undefined;
  return chat;
}

// Marks the chat as deleted for one side (Telegram "Delete chat for me").
// Group chats are not hidden: users leave them instead (see removeChatMember).
export function hideChatForUser(chatId: number, userId: number): void {
  const chat = getChatById(chatId);
  if (!chat || isGroupChat(chat)) return;
  const col = chat.user_a_id === userId ? 'hidden_a' : 'hidden_b';
  db.prepare(`UPDATE chats SET ${col} = 1 WHERE id = ?`).run(chatId);
}

// Re-shows the chat for one side (e.g. user opens the chat again from search).
export function showChatForUser(chatId: number, userId: number): void {
  const chat = getChatById(chatId);
  if (!chat || isGroupChat(chat)) return;
  const col = chat.user_a_id === userId ? 'hidden_a' : 'hidden_b';
  db.prepare(`UPDATE chats SET ${col} = 0 WHERE id = ?`).run(chatId);
}

// --- archive (per user, Telegram "Archive chat") ---

export function chatArchived(
  chat: { id: number; kind: string; user_a_id: number; user_b_id: number | null },
  userId: number,
): boolean {
  if (isGroupChat(chat)) {
    return Boolean(getChatMember(chat.id, userId)?.archived);
  }
  const col = chat.user_a_id === userId ? 'archived_a' : 'archived_b';
  return Boolean((chat as any)[col]);
}

export function setChatArchived(chatId: number, userId: number, archived: boolean): void {
  const chat = getChatById(chatId);
  if (!chat) return;
  if (isGroupChat(chat)) {
    if (!isChatMember(chatId, userId)) return;
    db.prepare('UPDATE chat_members SET archived = ? WHERE chat_id = ? AND user_id = ?').run(archived ? 1 : 0, chatId, userId);
    return;
  }
  if (chat.user_a_id !== userId && chat.user_b_id !== userId) return;
  const col = chat.user_a_id === userId ? 'archived_a' : 'archived_b';
  db.prepare(`UPDATE chats SET ${col} = ? WHERE id = ?`).run(archived ? 1 : 0, chatId);
}

// --- per-chat mute (groups) ---

export function setChatMuted(chatId: number, userId: number, muted: boolean): void {
  db.prepare('UPDATE chat_members SET muted = ? WHERE chat_id = ? AND user_id = ?').run(muted ? 1 : 0, chatId, userId);
}

// --- pinning (per user, Telegram "Pin chat") ---

export function chatPinned(chat: ChatRow, userId: number): boolean {
  if (isGroupChat(chat)) return Boolean(getChatMember(chat.id, userId)?.pinned);
  const col = chat.user_a_id === userId ? 'pinned_a' : 'pinned_b';
  return Boolean((chat as any)[col]);
}

export function setChatPinned(chatId: number, userId: number, pinned: boolean): void {
  const chat = getChatById(chatId);
  if (!chat) return;
  if (isGroupChat(chat)) {
    if (!isChatMember(chatId, userId)) return;
    db.prepare('UPDATE chat_members SET pinned = ? WHERE chat_id = ? AND user_id = ?').run(pinned ? 1 : 0, chatId, userId);
    return;
  }
  if (chat.user_a_id !== userId && chat.user_b_id !== userId) return;
  const col = chat.user_a_id === userId ? 'pinned_a' : 'pinned_b';
  db.prepare(`UPDATE chats SET ${col} = ? WHERE id = ?`).run(pinned ? 1 : 0, chatId);
}

export function setChatPinnedForAll(chatId: number, pinned: boolean): void {
  const chat = getChatById(chatId);
  if (!chat) return;
  if (isGroupChat(chat)) {
    db.prepare('UPDATE chat_members SET pinned = ? WHERE chat_id = ?').run(pinned ? 1 : 0, chatId);
  } else {
    db.prepare('UPDATE chats SET pinned_a = ?, pinned_b = ? WHERE id = ?').run(pinned ? 1 : 0, pinned ? 1 : 0, chatId);
  }
}

// --- unread count ---

export function chatUnreadCount(chat: ChatRow, userId: number): number {
  if (isGroupChat(chat)) {
    const m = getChatMember(chat.id, userId);
    if (!m) return 0;
    // Muted chats show zero unread badge
    if (m.muted) return 0;
    // Mentions-only: count only messages mentioning this user
    if (m.notify_mentions_only) {
      const username = (db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined)?.username;
      if (!username) return 0;
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND sender_id != ? AND id > ? AND deleted = 0 AND body IS NOT NULL AND (body LIKE '%' || ? || '%' OR hashtags LIKE '%' || ? || '%')`,
          )
          .get(chat.id, userId, m.last_read_id ?? 0, username.toLowerCase(), username.toLowerCase()) as { n: number }
      ).n;
    }
    const from = m.last_read_id ?? 0;
    return (
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND sender_id != ? AND id > ? AND deleted = 0',
        )
        .get(chat.id, userId, from) as { n: number }
    ).n;
  }
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND sender_id != ? AND read_at IS NULL AND deleted = 0')
      .get(chat.id, userId) as { n: number }
  ).n;
}

// --- media ---

export interface MediaRow {
  id: number;
  chat_id: number;
  sender_id: number;
  kind: string;
  name: string;
  mime: string;
  size: number;
  body: Buffer | null;
  iv: Buffer | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  storage_key: string | null;
  thumbnail: Buffer | null;
  created_at: string;
}

export function serializeMedia(m: MediaRow) {
  return {
    id: m.id,
    kind: m.kind,
    name: m.name,
    mime: m.mime,
    size: m.size,
    url: `/api/media/${m.id}`,
    thumb_url: m.thumbnail ? `/api/media/${m.id}/thumb` : undefined,
    duration: m.duration,
    width: m.width,
    height: m.height,
  };
}

export function getMediaById(id: number): MediaRow | undefined {
  return db.prepare('SELECT * FROM media WHERE id = ?').get(id) as unknown as MediaRow | undefined;
}

export function insertMedia(opts: {
  chatId: number;
  senderId: number;
  kind: string;
  name: string;
  mime: string;
  size: number;
  body: Buffer;
  iv: Buffer;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  storage_key?: string | null;
  thumbnail?: Buffer | null;
}): MediaRow {
  const res = db
    .prepare(
      'INSERT INTO media (chat_id, sender_id, kind, name, mime, size, body, iv, duration, width, height, storage_key, thumbnail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      opts.chatId,
      opts.senderId,
      opts.kind,
      opts.name,
      opts.mime,
      opts.size,
      opts.body,
      opts.iv,
      opts.duration ?? null,
      opts.width ?? null,
      opts.height ?? null,
      opts.storage_key ?? null,
      opts.thumbnail ?? null,
    );
  return db.prepare('SELECT * FROM media WHERE id = ?').get(Number(res.lastInsertRowid)) as unknown as MediaRow;
}

// --- reactions ---

export interface ReactionRow {
  user_id: number;
  emoji: string;
  created_at: string;
}

export function getMessageReactions(messageId: number): ReactionRow[] {
  return db
    .prepare('SELECT user_id, emoji, created_at FROM reactions WHERE message_id = ?')
    .all(messageId) as unknown as ReactionRow[];
}

// Aggregated reaction groups, e.g. [{emoji:'❤️', count:2, mine:true}]
export function reactionGroups(messageId: number, selfId: number) {
  const rows = getMessageReactions(messageId);
  const map = new Map<string, { emoji: string; count: number; mine: boolean }>();
  for (const r of rows) {
    const g = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false };
    g.count += 1;
    if (r.user_id === selfId) g.mine = true;
    map.set(r.emoji, g);
  }
  return [...map.values()];
}

// --- Image dimension extraction (JPEG/PNG) ---

export function extractImageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4) return null;
  // PNG: IHDR chunk at offset 16
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  }
  // JPEG: scan for SOF marker
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < buf.length) {
      if (buf[offset] !== 0xff) break;
      const marker = buf[offset + 1];
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (offset + 9 > buf.length) return null;
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return { width, height };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }
  // WebP: RIFF header
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { width, height };
    }
  }
  return null;
}
