import type { Server, Socket } from 'socket.io';
import { isIPv4 } from 'node:net';
import dns from 'node:dns';
import { db } from './db.js';
import { decryptAtRest, encryptAtRest } from './crypto.js';
import { config } from './config.js';
import {
  chatMemberRole,
  getChatForUser,
  getChatMember,
  getUserIdByToken,
  getUserById,
  getMediaById,
  hasChatPermission,
  isBlocked,
  isChatMember,
  isGroupChat,
  listChatMembers,
  privacyAllows,
  reactionGroups,
  senderUserDTO,
  serializeMedia,
} from './helpers.js';
import { logSuspicious } from './auth.js';
import { isWebPushEnabled, sendPushToUser, isFCMEnabled, sendFCMToUser } from './push.js';
import { decryptAtRest as _decryptAtRest } from './crypto.js';

// --- shadow ban helper ---
function isShadowBanned(userId: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM shadow_bans WHERE user_id = ?').get(userId));
}

// --- quiet hours: "HH:MM"-"HH:MM" window (UTC), supports overnight ranges ---
function isInQuietHours(user: { quiet_hours_start?: string | null; quiet_hours_end?: string | null }): boolean {
  const start = user.quiet_hours_start;
  const end = user.quiet_hours_end;
  if (!start || !end) return false;
  const parse = (v: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };
  const s = parse(start);
  const e = parse(end);
  if (s == null || e == null || s === e) return false;
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (s < e) return nowMin >= s && nowMin < e;
  return nowMin >= s || nowMin < e;
}

function messageMentionsUser(text: unknown, username: string): boolean {
  if (typeof text !== 'string' || !text || !username) return false;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${escaped}(?![A-Za-z0-9_])`, 'i').test(text);
}

// Dispatch message to bots webhooks registered for chats this bot account is a member of
// --- SSRF-safe outbound webhook helpers ---
function isPrivateOrReservedIP(ip: string): boolean {
  const h = ip.toLowerCase();
  if (isIPv4(h)) {
    const p = h.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] >= 224 && p[0] <= 239) return true;
    return false;
  }
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h.startsWith('::ffff:')) {
    const m = h.slice(7);
    if (isIPv4(m)) return isPrivateOrReservedIP(m);
  }
  return true;
}

function resolveHostSafe(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) { resolve(false); return; }
      for (const a of addresses) {
        if (isPrivateOrReservedIP(a.address)) { resolve(false); return; }
      }
      resolve(true);
    });
  });
}

async function isSafeWebhookUrl(raw: string): Promise<boolean> {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const h = parsed.hostname.toLowerCase();
  const blocked = ['localhost', '0.0.0.0', '127.0.0.1', '::1', 'metadata.google.internal', '169.254.169.254'];
  if (blocked.includes(h)) return false;
  if (isPrivateOrReservedIP(h)) return false;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return !isPrivateOrReservedIP(h);
  // DNS-rebinding protection: resolved IPs must be public
  try { return await resolveHostSafe(h); } catch { return false; }
}

async function dispatchBotWebhooks(chatId: number, message: Record<string, unknown>): Promise<void> {
  try {
    const bots = db.prepare(`
      SELECT DISTINCT b.* FROM bots b JOIN chat_members cm ON cm.user_id = b.user_id
      WHERE cm.chat_id = ? AND b.is_active = 1 AND b.webhook_url != ''
    `).all(chatId) as Array<{ id: number; webhook_url: string }>;
    for (const bot of bots) {
      try {
        if (!(await isSafeWebhookUrl(bot.webhook_url))) continue;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        const resp = await fetch(bot.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bot_id: bot.id, chat_id: chatId, message }),
          signal: ctrl.signal,
          redirect: 'manual',
        });
        clearTimeout(timer);
        // Do not follow redirects to avoid SSRF via Location
        if (resp.status >= 300 && resp.status < 400) {
          const loc = resp.headers.get('location');
          if (loc && !(await isSafeWebhookUrl(new URL(loc, bot.webhook_url).href))) continue;
        }
      } catch { /* ignore per-bot dispatch failures */ }
    }
  } catch { /* ignore dispatch failures */ }
}

// --- link blacklist helper ---
let blacklistCache: Set<string> | null = null;
let blacklistCacheAt = 0;
function getBlacklistPatterns(): Set<string> {
  const now = Date.now();
  if (blacklistCache && now - blacklistCacheAt < 60_000) return blacklistCache;
  const rows = db.prepare('SELECT pattern FROM link_blacklist').all() as { pattern: string }[];
  blacklistCache = new Set(rows.map((r) => r.pattern));
  blacklistCacheAt = now;
  return blacklistCache;
}
export function isBlacklisted(text: string): boolean {
  const patterns = getBlacklistPatterns();
  const lower = text.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p.toLowerCase())) return true;
  }
  return false;
}

// In-memory presence: userId -> set of socket ids
const presence = new Map<number, Set<string>>();

// Active WebRTC calls: callId -> call state
interface ActiveCall {
  callerId: number;
  calleeId: number;
  chatId: number;
  callType: 'audio' | 'video';
  startTime: number;
  answeredAt?: number;
}
const activeCalls = new Map<string, ActiveCall>();

// Socket ID -> callId mapping for disconnect cleanup
const socketCalls = new Map<string, string>();

// Group calls: chatId -> Map<userId, { socketId, callType }>
const groupCalls = new Map<number, Map<number, { socketId: string; callType: string }>>();

function chatTitle(chatId: number, forUserId: number): string {
  const chat = db.prepare('SELECT kind, title, user_a_id, user_b_id FROM chats WHERE id = ?').get(chatId) as { kind: string; title: string | null; user_a_id: number | null; user_b_id: number | null } | undefined;
  if (!chat) return 'Messenger';
  if (chat.kind === 'group' || chat.kind === 'channel') return chat.title || 'Group';
  // Direct chat: return the peer's name
  const peerId = chat.user_a_id === forUserId ? chat.user_b_id : chat.user_a_id;
  if (!peerId) return 'Messenger';
  const peer = db.prepare('SELECT first_name, last_name, username FROM users WHERE id = ?').get(peerId) as { first_name: string; last_name: string; username: string } | undefined;
  if (!peer) return 'Messenger';
  return [peer.first_name, peer.last_name].filter(Boolean).join(' ') || peer.username || 'Messenger';
}

function sharesChat(a: number, b: number): boolean {
  if (a === b) return true;
  const direct = db
    .prepare('SELECT 1 FROM chats WHERE kind IN (?, ?) AND ((user_a_id = ? AND user_b_id = ?) OR (user_a_id = ? AND user_b_id = ?)) LIMIT 1')
    .get('regular', 'secret', a, b, b, a);
  if (direct) return true;
  return Boolean(
    db
      .prepare(
        'SELECT 1 FROM chat_members a JOIN chat_members b ON b.chat_id = a.chat_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1',
      )
      .get(a, b),
  );
}

/** Get all user IDs who share a chat with the given user (batch query). */
function sharedChatUserIds(userId: number): Set<number> {
  const ids = db.prepare(`
    SELECT DISTINCT u2.user_id as id FROM chat_members u1
    JOIN chat_members u2 ON u2.chat_id = u1.chat_id AND u2.user_id != ?
    WHERE u1.user_id = ?
    UNION
    SELECT CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END as id
    FROM chats WHERE kind IN ('regular','secret') AND (user_a_id = ? OR user_b_id = ?) AND (user_a_id != ? OR user_b_id != ?)
  `).all(userId, userId, userId, userId, userId, userId, userId) as { id: number }[];
  const s = new Set<number>();
  for (const r of ids) s.add(r.id);
  return s;
}

// Emit presence only to viewers allowed by the owner's "Last seen & online" privacy.
function broadcastPresence(io: Server, userId: number, online: boolean) {
  const target = getUserById(userId);
  if (!target) return;
  const shared = sharedChatUserIds(userId);
  for (const viewerId of presence.keys()) {
    if (viewerId === userId || !shared.has(viewerId)) continue;
    if (!privacyAllows(target, viewerId, 'last_seen')) continue;
    io.to(`user:${viewerId}`).emit('presence', { userId, online });
    io.to(`user:${viewerId}`).emit(online ? 'user:online' : 'user:offline', { userId });
  }
}

function emitInitialPresence(io: Server, viewerId: number) {
  const shared = sharedChatUserIds(viewerId);
  for (const [userId, sockets] of presence) {
    if (userId === viewerId || sockets.size === 0 || !shared.has(userId)) continue;
    const target = getUserById(userId);
    if (target && privacyAllows(target, viewerId, 'last_seen')) {
      io.to(`user:${viewerId}`).emit('presence', { userId, online: true });
      io.to(`user:${viewerId}`).emit('user:online', { userId });
    }
  }
}

function emitReactions(io: Server, chat: { id: number; kind: string; user_a_id: number; user_b_id: number | null }, messageId: number) {
  const viewerIds = isGroupChat(chat)
    ? listChatMembers(chat.id).map((member) => member.user_id)
    : [chat.user_a_id, chat.user_b_id].filter((id): id is number => id !== null);
  for (const viewerId of viewerIds) {
    io.to(`user:${viewerId}`).emit('message:reaction', {
      chatId: chat.id,
      messageId,
      reactions: reactionGroups(messageId, viewerId),
    });
  }
}

function room(chatId: number) {
  return `chat:${chatId}`;
}

export function registerSockets(io: Server) {
  io.use((socket, next) => {
    // Try auth.token from handshake first (backwards compatibility)
    let token = String(socket.handshake.auth?.token ?? '');

    // Fall back to session cookie from handshake headers
    if (!token) {
      const cookieHeader = socket.handshake.headers?.cookie ?? '';
      for (const pair of cookieHeader.split(';')) {
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (name === config.sessionCookieName) {
          try {
            token = decodeURIComponent(value);
          } catch {
            token = value;
          }
          break;
        }
      }
    }

    const userId = getUserIdByToken(token);
    if (!userId) return next(new Error('Unauthorized'));
    // Global ban check
    const banned = db.prepare('SELECT 1 FROM global_bans WHERE user_id = ?').get(userId);
    if (banned) return next(new Error('Account banned'));
    socket.data.userId = userId;
    socket.data.token = token;
    next();
  });

  io.on('connection', (socket: Socket) => {
    const selfId: number = socket.data.userId;
    let messageWindowStartedAt = Date.now();
    let messageWindowCount = 0;

    try {
      db.prepare("UPDATE chat_members SET muted_until = NULL WHERE muted_until IS NOT NULL AND muted_until < datetime('now')").run();
    } catch { /* ignore cleanup failures */ }

    const userSockets = presence.get(selfId) ?? new Set<string>();
    userSockets.add(socket.id);
    presence.set(selfId, userSockets);

    socket.join(`user:${selfId}`);
    broadcastPresence(io, selfId, true);
    emitInitialPresence(io, selfId);

    socket.use((_packet, next) => {
      const currentUserId = getUserIdByToken(String(socket.data.token ?? ''));
      if (currentUserId !== selfId) return next(new Error('Unauthorized'));
      next();
    });

    // join chat rooms for all existing chats so history/delivery works
    const chats = db
      .prepare(
        'SELECT c.id FROM chats c LEFT JOIN chat_members m ON m.chat_id = c.id WHERE (c.user_a_id = ? OR c.user_b_id = ?) OR m.user_id = ?',
      )
      .all(selfId, selfId, selfId) as { id: number }[];
    for (const c of chats) socket.join(room(c.id));

    socket.on('chat:join', (chatId) => {
      const id = Number(chatId);
      const chat = getChatForUser(id, selfId);
      if (!chat) return;
      socket.join(room(id));
    });

    socket.on('message:send', (payload, ack) => {
      try {
        const now = Date.now();
        if (now - messageWindowStartedAt >= 60_000) {
          messageWindowStartedAt = now;
          messageWindowCount = 0;
        }
        messageWindowCount += 1;
        if (messageWindowCount > 120) return ack?.({ ok: false, error: 'Too many messages. Slow down.' });

        // Optional anti-abuse: 24h cooldown for group/channel posts from new
        // accounts. Gated behind NEW_ACCOUNT_GROUP_COOLDOWN=1 (off by default) so
        // fresh accounts can test groups immediately on production deploys.
        if (config.newAccountGroupCooldown) {
          const userRow = db.prepare('SELECT created_at FROM users WHERE id = ?').get(selfId) as { created_at?: string } | undefined;
          if (userRow?.created_at) {
            const accountAge = (Date.now() - new Date(userRow.created_at).getTime()) / 1000;
            const chatForRestriction = getChatForUser(Number(payload.chatId), selfId);
            if (accountAge < 86400 && chatForRestriction && isGroupChat(chatForRestriction)) {
              return ack?.({ ok: false, error: 'New accounts cannot post in groups/channels for 24 hours' });
            }
          }
        }

        // Spam filter: per-user rate limit (20 msgs/10s in dev, 5 msgs/10s in production)
        const spamKey = `spam:${selfId}`;
        const spamEntry = (globalThis as any).__spam ??= {};
        // Cleanup stale entries every 100 users (was 1000, too rare)
        if (Object.keys(spamEntry).length > 100) {
          for (const k of Object.keys(spamEntry)) { if (now - spamEntry[k].start >= 30_000) delete spamEntry[k]; }
        }
        const spamLimit = process.env.NODE_ENV === 'production' ? 5 : 20;
        const spamWindow = spamEntry[spamKey] ?? { count: 0, start: now };
        if (now - spamWindow.start >= 10_000) {
          spamEntry[spamKey] = { count: 1, start: now };
        } else {
          spamWindow.count += 1;
          if (spamWindow.count > spamLimit) return ack?.({ ok: false, error: 'You are sending messages too quickly. Please slow down.' });
        }

        const chatId = Number(payload.chatId);
        const chat = getChatForUser(chatId, selfId);
        if (!chat) return ack?.({ ok: false, error: 'No such chat' });
        if (isGroupChat(chat)) {
          if (!isChatMember(chatId, selfId)) return ack?.({ ok: false, error: 'You are not a member of this chat' });
          if (chat.kind === 'channel') {
            const role = chatMemberRole(chatId, selfId);
            if (role !== 'owner' && role !== 'admin' && role !== 'editor') {
              return ack?.({ ok: false, error: 'Only admins and editors can post in channels' });
            }
          }
          // Permission matrix: send_messages / send_media / send_stickers override
          const permMediaId = payload.mediaId ? Number(payload.mediaId) : 0;
          const permission = !permMediaId
            ? 'send_messages'
            : db.prepare('SELECT 1 FROM stickers WHERE file_id = ?').get(permMediaId)
              ? 'send_stickers'
              : 'send_media';
          if (!hasChatPermission(chatId, selfId, permission)) {
            return ack?.({ ok: false, error: 'You do not have permission to send messages here' });
          }
          // Slow mode enforcement
          const slowSeconds = (chat as any).slow_mode_seconds ?? 0;
          if (slowSeconds > 0) {
            const lastMsg = db.prepare('SELECT created_at FROM messages WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT 1').get(chatId, selfId) as any;
            if (lastMsg) {
              const lastTime = new Date(lastMsg.created_at).getTime();
              const elapsed = (Date.now() - lastTime) / 1000;
              if (elapsed < slowSeconds) {
                return ack?.({ ok: false, error: `Slow mode: wait ${Math.ceil(slowSeconds - elapsed)}s` });
              }
            }
          }
          // Muted-until posting restriction
          const memberInfo = db.prepare('SELECT muted_until FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, selfId) as { muted_until: string | null } | undefined;
          if (memberInfo?.muted_until) {
            const until = new Date(memberInfo.muted_until).getTime();
            if (Date.now() < until) {
              return ack?.({ ok: false, error: `You are restricted from posting until ${memberInfo.muted_until}` });
            } else if (until > 0) {
              db.prepare('UPDATE chat_members SET muted_until = NULL WHERE chat_id = ? AND user_id = ?').run(chatId, selfId);
            }
          }
        } else {
          const peerId = chat.user_a_id === selfId ? chat.user_b_id : chat.user_a_id;
          if (!peerId) return ack?.({ ok: false, error: 'No such chat' });
          if (isBlocked(selfId, peerId) || isBlocked(peerId, selfId)) {
            return ack?.({ ok: false, error: 'You cannot send messages to this user' });
          }
          db.prepare(`UPDATE chats SET ${chat.user_a_id === peerId ? 'hidden_a' : 'hidden_b'} = 0 WHERE id = ?`).run(chatId);
        }

        const mediaId = payload.mediaId ? Number(payload.mediaId) : null;
        if (mediaId) {
          const media = getMediaById(mediaId);
          if (!media || media.chat_id !== chatId) return ack?.({ ok: false, error: 'Invalid media' });
        }
        const replyTo = payload.replyTo ? Number(payload.replyTo) : null;
        if (replyTo) {
          const replied = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0').get(replyTo, chatId);
          if (!replied) return ack?.({ ok: false, error: 'Replied message not found' });
        }
        const threadId = payload.threadId ? Number(payload.threadId) : null;
        if (threadId) {
          const parentMsg = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0').get(threadId, chatId);
          if (!parentMsg) return ack?.({ ok: false, error: 'Thread parent message not found' });
        }
        const topicId = payload.topicId ? Number(payload.topicId) : null;
        if (topicId) {
          const topic = db.prepare('SELECT id FROM forum_topics WHERE id = ? AND chat_id = ?').get(topicId, chatId);
          if (!topic) return ack?.({ ok: false, error: 'Topic not found' });
        }
        const clientIdRaw = String(payload.clientId ?? '').trim();
        const clientId = clientIdRaw && /^[A-Za-z0-9_-]{8,80}$/.test(clientIdRaw) ? clientIdRaw : null;
        if (clientIdRaw && !clientId) return ack?.({ ok: false, error: 'Invalid client message id' });
        if (clientId) {
          const duplicate = db
            .prepare('SELECT id FROM messages WHERE chat_id = ? AND sender_id = ? AND client_id = ?')
            .get(chatId, selfId, clientId) as { id: number } | undefined;
          if (duplicate) {
            const existing = getChatMessages(chatId, selfId)?.find((message) => message.id === duplicate.id);
            return ack?.(existing ? { ok: true, message: existing } : { ok: false, error: 'Duplicate message' });
          }
        }
        const clientTimestamp = typeof payload.clientTimestamp === 'string' && payload.clientTimestamp.length <= 64 ? payload.clientTimestamp : null;
        if (clientTimestamp) {
          const tsDuplicate = db
            .prepare('SELECT id FROM messages WHERE chat_id = ? AND sender_id = ? AND client_timestamp = ? LIMIT 1')
            .get(chatId, selfId, clientTimestamp) as { id: number } | undefined;
          if (tsDuplicate) {
            const existing = getChatMessages(chatId, selfId)?.find((message) => message.id === tsDuplicate.id);
            return ack?.(existing ? { ok: true, message: existing } : { ok: false, error: 'Duplicate message' });
          }
        }
        const forwardedMessageId = payload.forwardMessageId ? Number(payload.forwardMessageId) : null;
        let forwardFrom: { user_id: number; name: string } | null = null;
        let forwardedText: string | null = null;
        if (forwardedMessageId) {
          const sourceMessage = db
            .prepare('SELECT sender_id, chat_id, body, iv FROM messages WHERE id = ? AND deleted = 0')
            .get(forwardedMessageId) as { sender_id: number; chat_id: number; body: Buffer | null; iv: Buffer | null } | undefined;
          const sourceChat = sourceMessage ? getChatForUser(sourceMessage.chat_id, selfId) : undefined;
          if (!sourceMessage || !sourceChat) return ack?.({ ok: false, error: 'Forwarded message not found' });
          if (sourceChat.kind === 'secret') return ack?.({ ok: false, error: 'Secret messages cannot be forwarded' });
          const originalSender = getUserById(sourceMessage.sender_id);
          if (!originalSender) return ack?.({ ok: false, error: 'Forwarded message sender not found' });
          if (!privacyAllows(originalSender, selfId, 'forwarded')) {
            return ack?.({ ok: false, error: 'The sender does not allow forwarding this message' });
          }
          forwardFrom = {
            user_id: originalSender.id,
            name: [originalSender.first_name, originalSender.last_name].filter(Boolean).join(' ') || originalSender.username,
          };
          if (sourceMessage.body && sourceMessage.iv) {
            forwardedText = decryptAtRest(
              Buffer.from(sourceMessage.body as Uint8Array),
              Buffer.from(sourceMessage.iv as Uint8Array),
            ).toString('utf8');
          }
        }

        let body: Buffer;
        let iv: Buffer | null;
        let deliver: Record<string, unknown>;

        if (chat.kind === 'secret') {
          // Client-side E2E: server stores and relays ciphertext it cannot read.
          if (mediaId) {
            // E2E media: client encrypts file client-side; server stores ciphertext blob.
            const mediaRow = db.prepare('SELECT id, mime_type FROM media WHERE id = ?').get(mediaId) as { id: number; mime_type: string } | undefined;
            if (!mediaRow) return ack?.({ ok: false, error: 'Media not found' });
          }
          const cipherInput = String(payload.cipher ?? '');
          const nonceInput = String(payload.iv ?? '');
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cipherInput) || !/^[A-Za-z0-9+/]+={0,2}$/.test(nonceInput)) {
            return ack?.({ ok: false, error: 'Invalid encrypted message' });
          }
          const cipher = Buffer.from(cipherInput, 'base64');
          const nonce = Buffer.from(nonceInput, 'base64');
          if (nonce.length !== 12 || cipher.length < 17 || cipher.length > 64 * 1024) {
            return ack?.({ ok: false, error: 'Invalid encrypted message' });
          }
          body = cipher;
          iv = nonce;
          deliver = { cipher: cipher.toString('base64'), iv: nonce.toString('base64') };
        } else {
          // Regular chat: server encrypts at rest, delivers plaintext.
          const text = forwardedText ?? String(payload.text ?? '');
          if (!text.trim() && !mediaId) return ack?.({ ok: false, error: 'Empty message' });
          if (text.length > 4096) return ack?.({ ok: false, error: 'Message is too long' });
          if (isBlacklisted(text)) return ack?.({ ok: false, error: 'Message contains a blacklisted URL' });
          const enc = encryptAtRest(Buffer.from(text, 'utf8'));
          body = enc.body;
          iv = enc.iv;
          deliver = { text };
        }

        const expiresIn = Number(payload.expiresIn);
        const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

        // Extract hashtags from message text (non-secret chats only)
        let hashtagsArr: string[] = [];
        if (chat.kind !== 'secret') {
          const textStr = String(payload.text ?? '');
          const hashtagMatches = textStr.match(/#[\w\u00C0-\u024F]+/g);
          if (hashtagMatches) hashtagsArr = [...new Set(hashtagMatches.map((h) => h.slice(1).toLowerCase()))];
        }

        const nowIso = new Date().toISOString();
        const res = db
          .prepare(
            'INSERT INTO messages (chat_id, sender_id, client_id, client_timestamp, body, iv, e2e, media_id, reply_to, forwarded_from, expires_at, hashtags, thread_id, topic_id, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(chatId, selfId, clientId, clientTimestamp, body, iv, chat.kind === 'secret' ? 1 : 0, mediaId, replyTo, forwardFrom ? JSON.stringify(forwardFrom) : null, expiresAt, JSON.stringify(hashtagsArr), threadId, topicId, nowIso);
        const media = mediaId ? getMediaById(mediaId) : null;
        const message = {
          id: Number(res.lastInsertRowid),
          chat_id: chatId,
          sender_id: selfId,
          client_id: clientId,
          sender_user: senderUserDTO(selfId),
          created_at: nowIso,
          delivered_at: nowIso,
          read_at: null,
          ...deliver,
          expires_at: expiresAt,
          media: media ? serializeMedia(media) : null,
          reply_to: replyTo ?? null,
          thread_id: threadId ?? null,
          topic_id: topicId ?? null,
          hashtags: hashtagsArr,
          forwarded_from: forwardFrom,
          reactions: [],
        };

        // FTS5: insert decrypted text for searchable indexing (non-secret chats)
        if (chat.kind !== 'secret') {
          try {
            let ftsText = '';
            if (body && iv) {
              ftsText = _decryptAtRest(Buffer.from(body as Uint8Array), Buffer.from(iv as Uint8Array)).toString('utf8');
            }
            // FTS rowid must equal messages.id so that search joins
            // (m.id = f.rowid), deletes and edits can target the right row.
            db.prepare('INSERT INTO messages_fts (rowid, chat_id, sender_id, text_content, created_at) VALUES (?, ?, ?, ?, ?)').run(message.id, chatId, selfId, ftsText, message.created_at);
          } catch { /* ignore FTS errors */ }
        }

        // Update last_message_at on chats for auto-archive
        try {
          db.prepare("UPDATE chats SET last_message_at = datetime('now') WHERE id = ?").run(chatId);
        } catch { /* ignore */ }

        // Shadow ban: accept message but don't deliver to others
        const shadowBanned = isShadowBanned(selfId);
        if (!shadowBanned) {
          io.to(room(chatId)).emit('message:new', message);
          dispatchBotWebhooks(chatId, message).catch(() => {});
        }
        ack?.({ ok: true, message });

        // Send Web Push to offline members (suppressed for shadow-banned senders)
        if (!shadowBanned && isWebPushEnabled()) {
          const members = listChatMembers(chatId);
          const sender = senderUserDTO(selfId);
          const senderName = sender ? [sender.first_name, sender.last_name].filter(Boolean).join(' ') || sender.username || 'Someone' : 'Someone';
          const msgText = (message as Record<string, unknown>).text;
          for (const m of members) {
            if (m.user_id === selfId) continue;
            const sockets = presence.get(m.user_id);
            // Only push if user has no connected sockets in this chat room
            const isOnline = sockets && sockets.size > 0;
            if (!isOnline) {
              const memberRow = db
                .prepare('SELECT muted, muted_until, notify_level, notify_mentions_only FROM chat_members WHERE chat_id = ? AND user_id = ?')
                .get(chatId, m.user_id) as { muted?: number; muted_until?: string | null; notify_level?: string; notify_mentions_only?: number } | undefined;
              if (memberRow?.notify_level === 'none') continue;
              if (memberRow?.muted === 1) {
                const until = memberRow.muted_until ? Date.parse(memberRow.muted_until) : NaN;
                if (Number.isNaN(until) || until > Date.now()) continue;
              } else if (memberRow?.muted_until && Date.parse(memberRow.muted_until) > Date.now()) {
                continue;
              }
              const mentionsOnly = memberRow?.notify_mentions_only === 1 || memberRow?.notify_level === 'mentions';
              if (mentionsOnly && !messageMentionsUser(typeof msgText === 'string' ? msgText : '', senderUserDTO(m.user_id)?.username ?? '')) {
                continue;
              }
              const target = getUserById(m.user_id);
              if (target && isInQuietHours(target)) continue;
              sendPushToUser(m.user_id, {
                title: chatTitle(chatId, m.user_id),
                body: msgText ? `${senderName}: ${String(msgText).slice(0, 100)}` : `${senderName} sent a ${(message as Record<string, unknown>).media ? 'media' : 'message'}`,
                tag: `chat:${chatId}`,
                url: `/chat/${chatId}`,
              }).catch(() => {});
            }
          }
        }

        // FCM mobile push to offline members (suppressed for shadow-banned senders)
        if (!shadowBanned && isFCMEnabled()) {
          const fcmMembers = listChatMembers(chatId);
          for (const m of fcmMembers) {
            if (m.user_id === selfId) continue;
            const sockets = presence.get(m.user_id);
            if (sockets && sockets.size > 0) continue;
            const memberRow = db
              .prepare('SELECT notify_level, notify_mentions_only FROM chat_members WHERE chat_id = ? AND user_id = ?')
              .get(chatId, m.user_id) as { notify_level?: string; notify_mentions_only?: number } | undefined;
            if (memberRow?.notify_level === 'none') continue;
            const msgText2 = (message as Record<string, unknown>).text;
            const mentionsOnly = memberRow?.notify_mentions_only === 1 || memberRow?.notify_level === 'mentions';
            if (mentionsOnly && !messageMentionsUser(msgText2, getUserById(m.user_id)?.username ?? '')) continue;
            const targetUser = getUserById(m.user_id);
            if (targetUser && isInQuietHours(targetUser)) continue;
            const sender2 = senderUserDTO(selfId);
            const senderName2 = sender2 ? [sender2.first_name, sender2.last_name].filter(Boolean).join(' ') || sender2.username || 'Someone' : 'Someone';
            sendFCMToUser(m.user_id, {
              title: chatTitle(chatId, m.user_id),
              body: msgText2 ? `${senderName2}: ${String(msgText2).slice(0, 100)}` : `${senderName2} sent a message`,
              tag: `chat:${chatId}`,
              url: `/chat/${chatId}`,
            }).catch(() => {});
          }
        }
      } catch (e) {
        console.error(e);
        ack?.({ ok: false, error: 'Server error' });
      }
    });

    socket.on('message:react', (payload, ack) => {
      try {
        const chatId = Number(payload.chatId);
        const messageId = Number(payload.messageId);
        const emoji = String(payload.emoji ?? '').trim();
        if (!emoji || [...emoji].length > 8) return ack?.({ ok: false, error: 'Invalid emoji' });
        const chat = getChatForUser(chatId, selfId);
        if (!chat) return ack?.({ ok: false, error: 'No such chat' });
        const msg = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0').get(messageId, chatId);
        if (!msg) return ack?.({ ok: false, error: 'No such message' });

        const existing = db
          .prepare('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?')
          .get(messageId, selfId) as { emoji: string } | undefined;
        if (existing) {
          if (existing.emoji === emoji) {
            db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ?').run(messageId, selfId);
          } else {
            db.prepare('UPDATE reactions SET emoji = ? WHERE message_id = ? AND user_id = ?').run(emoji, messageId, selfId);
          }
        } else {
          db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(messageId, selfId, emoji);
        }
        const reactions = reactionGroups(messageId, selfId);
        emitReactions(io, chat, messageId);
        ack?.({ ok: true, reactions });
      } catch (e) {
        console.error(e);
        ack?.({ ok: false, error: 'Server error' });
      }
    });

    socket.on('typing', (payload) => {
      try {
        const chatId = Number(payload.chatId);
        const isTyping = Boolean(payload.isTyping);
        if (!getChatForUser(chatId, selfId)) return;
        socket.to(room(chatId)).emit('typing', { chatId, userId: selfId, isTyping });
      } catch { /* ignore */ }
    });

    socket.on('recording', (payload) => {
      try {
        const chatId = Number(payload.chatId);
        const isRecording = Boolean(payload.isRecording);
        if (!getChatForUser(chatId, selfId)) return;
        socket.to(room(chatId)).emit('recording', { chatId, userId: selfId, isRecording });
      } catch { /* ignore */ }
    });

    socket.on('message:read', (payload) => {
      try {
        const chatId = Number(payload.chatId);
        const messageId = Number(payload.messageId);
        const chat = getChatForUser(chatId, selfId);
        if (!chat) return;
        if (!db.prepare('SELECT 1 FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0').get(messageId, chatId)) return;
        const now = new Date().toISOString();
        if (isGroupChat(chat)) {
          const prev = getChatMember(chatId, selfId);
          if (prev && messageId > prev.last_read_id) {
            db.prepare('UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ?').run(
              messageId,
              chatId,
              selfId,
            );
          }
          io.to(room(chatId)).emit('message:read', { chatId, messageId, userId: selfId, read_at: now });
          return;
        }
        db.prepare(
          'UPDATE messages SET read_at = ? WHERE chat_id = ? AND sender_id != ? AND id <= ? AND read_at IS NULL',
        ).run(now, chatId, selfId, messageId);
        io.to(room(chatId)).emit('message:read', { chatId, messageId, userId: selfId, read_at: now });
      } catch { /* ignore */ }
    });

    socket.on('message:edit', (payload, ack) => {
      try {
        const chatId = Number(payload.chatId);
        const messageId = Number(payload.messageId);
        const text = String(payload.text ?? '').trim();
        if (!text) return ack?.({ ok: false, error: 'Empty message' });
        if (text.length > 4096) return ack?.({ ok: false, error: 'Message is too long' });
        if (!getChatForUser(chatId, selfId)) return ack?.({ ok: false, error: 'No such chat' });
        const row = db.prepare('SELECT * FROM messages WHERE id = ? AND chat_id = ?').get(messageId, chatId) as
          | { sender_id: number; e2e: number }
          | undefined;
        if (!row) return ack?.({ ok: false, error: 'No such message' });
        if (row.sender_id !== selfId) return ack?.({ ok: false, error: 'Cannot edit other messages' });
        if (row.e2e) return ack?.({ ok: false, error: 'Secret messages cannot be edited server-side' });

        // 48h edit window
        const createdAt = new Date((db.prepare('SELECT created_at FROM messages WHERE id = ?').get(messageId) as { created_at: string }).created_at).getTime();
        if (Date.now() - createdAt > 48 * 60 * 60 * 1000) return ack?.({ ok: false, error: 'Edit window expired (48h)' });

        const oldRow = db.prepare('SELECT body, iv FROM messages WHERE id = ?').get(messageId) as { body: Buffer | null; iv: Buffer | null } | undefined;
        if (oldRow?.body && oldRow?.iv) {
          db.prepare('INSERT INTO edit_history (message_id, user_id, old_body, old_iv) VALUES (?, ?, ?, ?)').run(messageId, selfId, oldRow.body, oldRow.iv);
        }
        const enc = encryptAtRest(Buffer.from(text, 'utf8'));
        db.prepare('UPDATE messages SET body = ?, iv = ?, edited_at = ? WHERE id = ?').run(
          enc.body,
          enc.iv,
          new Date().toISOString(),
          messageId,
        );
        // Keep the FTS index in sync with edits.
        try { db.prepare('UPDATE messages_fts SET text_content = ? WHERE rowid = ?').run(text, messageId); } catch { /* ignore FTS errors */ }
        io.to(room(chatId)).emit('message:edited', { chatId, messageId, text });
        ack?.({ ok: true });
      } catch (e) {
        console.error(e);
        ack?.({ ok: false, error: 'Server error' });
      }
    });

    socket.on('message:delete', (payload, ack) => {
      try {
        const chatId = Number(payload.chatId);
        const messageId = Number(payload.messageId);
        const forMe = payload.forMe === true;
        if (!getChatForUser(chatId, selfId)) return ack?.({ ok: false, error: 'No such chat' });
        const row = db.prepare('SELECT * FROM messages WHERE id = ? AND chat_id = ?').get(messageId, chatId) as
          | { sender_id: number; deleted_for: string }
          | undefined;
        if (!row) return ack?.({ ok: false, error: 'No such message' });

        if (forMe) {
          // Delete for me only: add userId to deleted_for array
          const deletedFor: number[] = JSON.parse(row.deleted_for || '[]');
          if (!deletedFor.includes(selfId)) deletedFor.push(selfId);
          db.prepare('UPDATE messages SET deleted_for = ? WHERE id = ?').run(JSON.stringify(deletedFor), messageId);
          ack?.({ ok: true });
        } else {
          // Delete for everyone: only sender can do this, within 48h window
          if (row.sender_id !== selfId) return ack?.({ ok: false, error: 'Cannot delete other messages' });
          const createdAt = new Date((db.prepare('SELECT created_at FROM messages WHERE id = ?').get(messageId) as { created_at: string }).created_at).getTime();
          if (Date.now() - createdAt > 48 * 60 * 60 * 1000) return ack?.({ ok: false, error: 'Delete window expired (48h)' });
          db.prepare('UPDATE messages SET deleted = 1, body = NULL, iv = NULL WHERE id = ?').run(messageId);
          try { db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(messageId); } catch { /* FTS may not have entry */ }
          io.to(room(chatId)).emit('message:deleted', { chatId, messageId });
          ack?.({ ok: true });
        }
      } catch (e) {
        console.error(e);
        ack?.({ ok: false, error: 'Server error' });
      }
    });

    socket.on('message:pin', (payload, ack) => {
      try {
        const chatId = Number(payload.chatId);
        const messageId = payload.messageId === null || payload.messageId === undefined ? null : Number(payload.messageId);
        const action = (payload.action as string) || (messageId !== null ? 'add' : 'clear');
        const chat = getChatForUser(chatId, selfId);
        if (!chat) return ack?.({ ok: false, error: 'No such chat' });
        if (isGroupChat(chat)) {
          if (!hasChatPermission(chatId, selfId, 'pin_messages', 'admin')) {
            return ack?.({ ok: false, error: 'Only admins can pin messages in groups and channels' });
          }
        }
        const chatRow = db.prepare('SELECT pinned_messages FROM chats WHERE id = ?').get(chatId) as { pinned_messages?: string } | undefined;
        let pins: number[] = [];
        try { pins = JSON.parse(chatRow?.pinned_messages ?? '[]'); } catch { pins = []; }
        if (action === 'add' && messageId !== null) {
          const row = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0').get(messageId, chatId);
          if (!row) return ack?.({ ok: false, error: 'No such message' });
          if (!pins.includes(messageId)) pins.push(messageId);
        } else if (action === 'remove' && messageId !== null) {
          pins = pins.filter((id) => id !== messageId);
        } else if (action === 'clear') {
          pins = [];
        }
        const pinsJson = JSON.stringify(pins);
        db.prepare('UPDATE chats SET pinned_messages = ?, pinned_id = ? WHERE id = ?').run(pinsJson, pins[0] ?? null, chatId);
        io.to(room(chatId)).emit('chat:updated', {
          chatId,
          pinned_messages: pins,
          pinned_id: pins[0] ?? null,
        });
        ack?.({ ok: true, pinned_messages: pins });
      } catch (e) {
        console.error(e);
        ack?.({ ok: false, error: 'Server error' });
      }
    });

    // --- WebRTC call signaling ---
    socket.on('call:init', (payload) => {
      try {
        const chatId = Number(payload.chatId);
        const callType = payload.callType === 'video' ? 'video' : 'audio';
        const chat = getChatForUser(chatId, selfId);
        if (!chat) return;

        // Determine callee: for direct chats, it's the other user
        const peerId = chat.user_a_id === selfId ? chat.user_b_id : chat.user_a_id;
        if (!peerId) return;
        if (isBlocked(selfId, peerId) || isBlocked(peerId, selfId)) return;

        const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        activeCalls.set(callId, {
          callerId: selfId,
          calleeId: peerId,
          chatId,
          callType,
          startTime: Date.now(),
        });
        socketCalls.set(socket.id, callId);

        const caller = getUserById(selfId);
        const callerName = caller
          ? [caller.first_name, caller.last_name].filter(Boolean).join(' ') || caller.username
          : 'Unknown';

        io.to(`user:${peerId}`).emit('call:ringing', {
          callId,
          chatId,
          callType,
          callerId: selfId,
          callerName,
        });

        // Also tell the caller the callId so the client can update state
        io.to(`user:${selfId}`).emit('call:initiated', { callId, chatId, callType });

        // Push notification for offline callee
        const calleeSockets = presence.get(peerId);
        if (!calleeSockets || calleeSockets.size === 0) {
          sendPushToUser(peerId, {
            title: callerName,
            body: callType === 'video' ? 'Incoming video call' : 'Incoming voice call',
            tag: `call:${callId}`,
            url: `/chat/${chatId}`,
          }).catch(() => {});
        }

        // Ringing timeout: auto-end call after 60s if not answered
        const RING_TIMEOUT = 60_000;
        setTimeout(() => {
          const c = activeCalls.get(callId);
          if (c && !c.answeredAt) {
            activeCalls.delete(callId);
            db.prepare("INSERT INTO call_history (chat_id, caller_id, call_type, status, duration) VALUES (?, ?, ?, 'missed', 0)").run(c.chatId, c.callerId, c.callType);
            io.to(`user:${c.callerId}`).emit('call:ended', { callId });
            io.to(`user:${c.calleeId}`).emit('call:ended', { callId });
          }
        }, RING_TIMEOUT);
      } catch (e) {
        console.error('call:init error', e);
      }
    });

    socket.on('call:accept', (payload) => {
      try {
        const callId = String(payload.callId ?? '');
        const call = activeCalls.get(callId);
        if (!call || call.calleeId !== selfId) return;

        socketCalls.set(socket.id, callId);
        io.to(`user:${call.callerId}`).emit('call:accepted', { callId });
      } catch (e) {
        console.error('call:accept error', e);
      }
    });

    socket.on('call:reject', (payload) => {
      try {
        const callId = String(payload.callId ?? '');
        const call = activeCalls.get(callId);
        if (!call) return;
        if (selfId !== call.callerId && selfId !== call.calleeId) return;

        // Record missed call in history
        db.prepare(
          "INSERT INTO call_history (chat_id, caller_id, call_type, status) VALUES (?, ?, ?, 'missed')",
        ).run(call.chatId, call.callerId, call.callType);

        const targetId = selfId === call.callerId ? call.calleeId : call.callerId;
        io.to(`user:${targetId}`).emit('call:rejected', { callId });
        activeCalls.delete(callId);
        socketCalls.delete(socket.id);
      } catch (e) {
        console.error('call:reject error', e);
      }
    });

    socket.on('call:ice-candidate', (payload) => {
      try {
        const callId = String(payload.callId ?? '');
        const call = activeCalls.get(callId);
        if (!call) return;
        if (call.callerId !== selfId && call.calleeId !== selfId) return;

        const targetId = call.callerId === selfId ? call.calleeId : call.callerId;
        io.to(`user:${targetId}`).emit('call:ice-candidate', {
          callId,
          candidate: payload.candidate,
        });
      } catch (e) {
        console.error('call:ice-candidate error', e);
      }
    });

    socket.on('call:offer', (payload) => {
      try {
        const callId = String(payload.callId ?? '');
        const call = activeCalls.get(callId);
        if (!call) return;
        if (call.callerId !== selfId && call.calleeId !== selfId) return;

        const targetId = call.callerId === selfId ? call.calleeId : call.callerId;
        io.to(`user:${targetId}`).emit('call:offer', {
          callId,
          sdp: payload.sdp,
        });
      } catch (e) {
        console.error('call:offer error', e);
      }
    });

    socket.on('call:answer', (payload) => {
      try {
        const callId = String(payload.callId ?? '');
        const call = activeCalls.get(callId);
        if (!call) return;
        if (call.callerId !== selfId && call.calleeId !== selfId) return;
        call.answeredAt = Date.now();

        const targetId = call.callerId === selfId ? call.calleeId : call.callerId;
        io.to(`user:${targetId}`).emit('call:answer', {
          callId,
          sdp: payload.sdp,
        });
      } catch (e) {
        console.error('call:answer error', e);
      }
    });

    socket.on('call:end', (payload) => {
      try {
        const callId = String(payload.callId ?? '');
        const call = activeCalls.get(callId);
        if (!call) return;
        if (call.callerId !== selfId && call.calleeId !== selfId) return;

        const duration = call.answeredAt ? Math.floor((Date.now() - call.answeredAt) / 1000) : 0;
        const status = call.answeredAt ? 'completed' : 'missed';

        db.prepare(
          "INSERT INTO call_history (chat_id, caller_id, call_type, status, duration) VALUES (?, ?, ?, ?, ?)",
        ).run(call.chatId, call.callerId, call.callType, status, duration);

        const targetId = call.callerId === selfId ? call.calleeId : call.callerId;
        io.to(`user:${targetId}`).emit('call:ended', { callId });
        activeCalls.delete(callId);
        socketCalls.delete(socket.id);
      } catch (e) {
        console.error('call:end error', e);
      }
    });

    // --- Group call signaling ---
    socket.on('group-call:join', (payload, ack) => {
      try {
        const chatId = Number(payload.chatId);
        const callType = payload.callType === 'video' ? 'video' : 'audio';
        if (!isChatMember(chatId, selfId)) { ack?.({ ok: false, error: 'Not a member' }); return; }
        let participants = groupCalls.get(chatId);
        if (!participants) { participants = new Map(); groupCalls.set(chatId, participants); }
        participants.set(selfId, { socketId: socket.id, callType });
        // Notify existing participants
        for (const [uid, p] of participants) {
          if (uid === selfId) continue;
          io.to(p.socketId).emit('group-call:participant-joined', { chatId, userId: selfId, callType });
        }
        // Return current participants to the joiner
        const existing = [...participants.entries()]
          .filter(([uid]) => uid !== selfId)
          .map(([uid, p]) => ({ userId: uid, callType: p.callType }));
        ack?.({ ok: true, participants: existing });
      } catch (e) {
        console.error('group-call:join error', e);
        ack?.({ ok: false, error: 'Server error' });
      }
    });

    socket.on('group-call:leave', (payload) => {
      try {
        const chatId = Number(payload.chatId);
        if (!isChatMember(chatId, selfId)) return;
        const participants = groupCalls.get(chatId);
        if (participants) {
          participants.delete(selfId);
          if (participants.size === 0) groupCalls.delete(chatId);
          else {
            for (const [, p] of participants) {
              io.to(p.socketId).emit('group-call:participant-left', { chatId, userId: selfId });
            }
          }
        }
      } catch (e) {
        console.error('group-call:leave error', e);
      }
    });

    socket.on('group-call:offer', (payload) => {
      try {
        const chatId = Number(payload.chatId);
        const targetId = Number(payload.targetId);
        const participants = groupCalls.get(chatId);
        const target = participants?.get(targetId);
        if (target) {
          io.to(target.socketId).emit('group-call:offer', { chatId, fromId: selfId, sdp: payload.sdp });
        }
      } catch (e) {
        console.error('group-call:offer error', e);
      }
    });

    socket.on('group-call:answer', (payload) => {
      try {
        const chatId = Number(payload.chatId);
        const targetId = Number(payload.targetId);
        const participants = groupCalls.get(chatId);
        const target = participants?.get(targetId);
        if (target) {
          io.to(target.socketId).emit('group-call:answer', { chatId, fromId: selfId, sdp: payload.sdp });
        }
      } catch (e) {
        console.error('group-call:answer error', e);
      }
    });

    socket.on('group-call:ice-candidate', (payload) => {
      try {
        const chatId = Number(payload.chatId);
        const targetId = Number(payload.targetId);
        const participants = groupCalls.get(chatId);
        const target = participants?.get(targetId);
        if (target) {
          io.to(target.socketId).emit('group-call:ice-candidate', { chatId, fromId: selfId, candidate: payload.candidate });
        }
      } catch (e) {
        console.error('group-call:ice-candidate error', e);
      }
    });

    socket.on('disconnect', () => {
      // Clear typing state for all chat rooms this user is in
      for (const roomName of socket.rooms) {
        if (roomName.startsWith('chat:')) {
          const cid = Number(roomName.split(':')[1]);
          if (cid) io.to(roomName).emit('typing', { chatId: cid, userId: selfId, isTyping: false });
        }
      }

      // Clean up any active call for this socket
      const callId = socketCalls.get(socket.id);
      if (callId) {
        const call = activeCalls.get(callId);
        if (call) {
          const targetId = call.callerId === selfId ? call.calleeId : call.callerId;
          io.to(`user:${targetId}`).emit('call:ended', { callId });
          const duration = Math.floor((Date.now() - call.startTime) / 1000);
          db.prepare(
            "INSERT INTO call_history (chat_id, caller_id, call_type, status, duration) VALUES (?, ?, ?, ?, ?)",
          ).run(call.chatId, call.callerId, call.callType, duration > 0 ? 'completed' : 'missed', duration);
          activeCalls.delete(callId);
        }
        socketCalls.delete(socket.id);
      }

      // Clean up group calls
      for (const [chatId, participants] of groupCalls) {
        if (participants.has(selfId)) {
          participants.delete(selfId);
          if (participants.size === 0) { groupCalls.delete(chatId); }
          else {
            for (const [, p] of participants) {
              io.to(p.socketId).emit('group-call:participant-left', { chatId, userId: selfId });
            }
          }
        }
      }

      const set = presence.get(selfId);
      set?.delete(socket.id);
      if (!set || set.size === 0) {
        presence.delete(selfId);
        broadcastPresence(io, selfId, false);
      }
    });
  });
}

// REST helpers reused by the express app
export function getChatMessages(chatId: number, selfId: number, offset = 0, limit = 200) {
  const rows = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(chatId, limit, offset) as Array<{
    id: number;
    sender_id: number;
    client_id: string | null;
    body: Buffer | null;
    iv: Buffer | null;
    e2e: number;
    read_at: string | null;
    edited_at: string | null;
    deleted: number;
    deleted_for: string;
    expires_at: string | null;
    created_at: string;
    media_id: number | null;
    reply_to: number | null;
    forwarded_from: string | null;
    hashtags: string;
    thread_id: number | null;
    topic_id: number | null;
  }>;
  const chat = db.prepare('SELECT kind FROM chats WHERE id = ?').get(chatId) as { kind: string } | undefined;
  if (!chat) return null;

  // Filter out messages deleted for this user
  const filtered = rows.filter((r) => {
    if (r.deleted_for) {
      try {
        const arr: number[] = JSON.parse(r.deleted_for);
        if (arr.includes(selfId)) return false;
      } catch { /* ignore */ }
    }
    return true;
  });

  // Auto-delete expired messages
  const now = Date.now();
  for (const r of filtered) {
    if (r.expires_at) {
      const expiry = new Date(r.expires_at).getTime();
      if (expiry <= now) {
        db.prepare('UPDATE messages SET deleted = 1, body = NULL, iv = NULL WHERE id = ?').run(r.id);
        try { db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(r.id); } catch { /* FTS may not have entry */ }
        r.deleted = 1; // mark so it's excluded from results
      }
    }
  }

  return filtered.filter((r) => !r.deleted).map((r) => {
    const body = r.body ? Buffer.from(r.body as Uint8Array) : null;
    const iv = r.iv ? Buffer.from(r.iv as Uint8Array) : null;
    const media = r.media_id ? getMediaById(r.media_id) : null;
    let forwarded_from: { user_id: number; name: string } | null = null;
    if (r.forwarded_from) {
      try {
        forwarded_from = JSON.parse(r.forwarded_from);
      } catch {
        forwarded_from = null;
      }
    }
    const base = {
      id: r.id,
      sender_id: r.sender_id,
      client_id: r.client_id,
      sender_user: senderUserDTO(r.sender_id),
      created_at: r.created_at,
      read_at: r.read_at,
      delivered_at: (r as any).delivered_at ?? null,
      service: (r as any).service ?? 0,
      edited_at: r.edited_at,
      expires_at: r.expires_at,
      media: media ? serializeMedia(media) : null,
      reply_to: r.reply_to ?? null,
      thread_id: r.thread_id ?? null,
      topic_id: r.topic_id ?? null,
      hashtags: (() => { try { return JSON.parse(r.hashtags || '[]'); } catch { return []; } })(),
      forwarded_from,
      reactions: reactionGroups(r.id, selfId),
    };
    if (chat.kind === 'secret') {
      return {
        ...base,
        cipher: body ? body.toString('base64') : '',
        iv: iv ? iv.toString('base64') : '',
      };
    }
    let text = '';
    if (body && iv) {
      try {
        text = decryptAtRest(body, iv).toString('utf8');
      } catch {
        text = '[decryption failed]';
      }
    }
    return { ...base, text };
  });
}

// Insert a group/channel service message ("X renamed the group", "Y joined", etc.)
// and broadcast it via socket. Uses server-side at-rest encryption like normal text.
export function insertServiceMessage(
  io: Server,
  chatId: number,
  senderId: number,
  text: string,
): number | null {
  try {
    const nowIso = new Date().toISOString();
    const enc = encryptAtRest(Buffer.from(text, 'utf8'));
    const res = db
      .prepare(
        "INSERT INTO messages (chat_id, sender_id, body, iv, e2e, created_at, delivered_at, service) VALUES (?, ?, ?, ?, 0, ?, ?, 1)",
      )
      .run(chatId, senderId, enc.body, enc.iv, nowIso, nowIso);
    const id = Number(res.lastInsertRowid);
    const message = {
      id,
      chat_id: chatId,
      sender_id: senderId,
      sender_user: senderUserDTO(senderId),
      created_at: nowIso,
      delivered_at: nowIso,
      service: 1,
      read_at: null,
      edited_at: null,
      text,
      expires_at: null,
      media: null,
      reply_to: null,
      thread_id: null,
      topic_id: null,
      hashtags: [],
      forwarded_from: null,
      reactions: [],
    };
    io.to(room(chatId)).emit('message:new', message);
    return id;
  } catch {
    return null;
  }
}
