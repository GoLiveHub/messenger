import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import multer from 'multer';
import sharp from 'sharp';
import { Server } from 'socket.io';
import { config } from './config.js';
import { authRouter, deliverCode, logSuspicious, parseCookies, setSessionCookies, clearSessionCookies } from './auth.js';
import { registerSockets, getChatMessages } from './sockets.js';
import { log } from './lib/logger.js';
import { cacheGet, cacheSet, cacheIncr, cacheExpire, cacheDel } from './lib/redis.js';
import {
  addBlock,
  addChatMember,
  chatArchived,
  chatMemberRole,
  chatPinned,
  chatUnreadCount,
  deleteAllSessions,
  deleteSession,
  getChatById,
  getChatForUser,
  getChatMember,
  getMediaById,
  getOrCreateChat,
  getSessionByToken,
  getUserById,
  getUserByUsername,
  getUserByPhone,
  getUserIdByToken,
  hideChatForUser,
  insertMedia,
  extractImageDimensions,
  isBlocked,
  isChatMember,
  isGroupChat,
  listBlockedIds,
  listChatMembers,
  listSessions,
  privacyAllows,
  publicUser,
  publicUserFor,
  removeBlock,
  removeChatMember,
  serializeMedia,
  setChatArchived,
  setChatMemberRole,
  setChatMuted,
  setChatPinned,
  showChatForUser,
  isAdmin,
  getMessageReactions,
  reactionGroups,
} from './helpers.js';
import { db } from './db.js';
import { decryptAtRest, encryptAtRest, generateCode, hashPassword, sha256Hex, verifyPassword, randomToken } from './crypto.js';
import { validatePhone } from './phone.js';
import { getVapidPublicKey, isWebPushEnabled, sendPushToUser } from './push.js';
import { uploadFile, getFile, deleteFile } from './lib/storage.js';

// ======================== APP SETUP ========================

const app = express();
app.disable('x-powered-by');

// Trust proxy (for rate limiting behind reverse proxy)
if (config.isProduction) {
  app.set('trust proxy', 1);
}

// CORS (development only — production uses same-origin with HTTPS)
if (!config.isProduction) {
  app.use(cors({ origin: config.allowedOrigins, credentials: true }));
}

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  if (_req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  if (config.isProduction) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:",
    );
  }
  next();
});

// JSON body parser with size limit
app.use(express.json({ limit: '1mb' }));

// --- API response compression (gzip) ---
app.use('/api', (req, res, next) => {
  const acceptEncoding = req.headers['accept-encoding'] ?? '';
  if (!acceptEncoding.includes('gzip')) return next();
  const origJson = res.json.bind(res);
  res.json = (body: any) => {
    const jsonStr = JSON.stringify(body);
    const buf = Buffer.from(jsonStr, 'utf8');
    if (buf.length < 1024) {
      res.setHeader('Content-Type', 'application/json');
      return res.send(jsonStr) as any;
    }
    zlib.gzip(buf, { level: 6 }, (err, compressed) => {
      if (err || compressed.length >= buf.length) {
        res.setHeader('Content-Type', 'application/json');
        return res.send(jsonStr) as any;
      }
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', compressed.length);
      return res.send(compressed) as any;
    });
    return res as any;
  };
  next();
});

// Static files
const distPath = path.resolve(process.cwd(), 'dist');
app.use(express.static(distPath));

// File upload (8 MB limit)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ======================== HTTP + SOCKET.IO ========================

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  ...(config.isProduction ? {} : { cors: { origin: config.allowedOrigins, credentials: true } }),
  maxHttpBufferSize: 1e6, // 1 MB max per message
  pingTimeout: 20000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  perMessageDeflate: { threshold: 1024 }, // compress messages > 1KB
});

// Redis adapter for multi-instance scaling (optional, requires REDIS_URL)
async function setupRedisAdapter() {
  if (!config.redisUrl) return;
  try {
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const { Redis } = await import('ioredis');
    const pubClient = new Redis(config.redisUrl);
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.ping(), subClient.ping()]);
    io.adapter(createAdapter(pubClient, subClient));
    log.info('Socket.io Redis adapter connected');
  } catch (e) {
    log.warn('Socket.io Redis adapter failed, using in-memory adapter', { error: String(e) });
  }
}
void setupRedisAdapter();

// ======================== GLOBAL RATE LIMITING ========================

// Per-IP rate limiter for all API routes (Redis-backed with in-memory fallback)
async function globalRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = `ratelimit:api:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
  try {
    const current = await cacheGet(key);
    const count = current ? parseInt(current, 10) + 1 : 1;
    if (count === 1) {
      await cacheSet(key, '1', 60);
    } else {
      await cacheSet(key, String(count), 60);
      await cacheExpire(key, 60);
    }
    if (count > 300) {
      log.suspicious('rate_limit_api', { ip: req.ip, count });
      res.set('Retry-After', '60');
      return res.status(429).json({ error: t_server('rate_limit') });
    }
  } catch {
    // Redis unavailable — skip rate limiting gracefully
  }
  next();
}

// Apply global rate limit to all API routes
app.use('/api', globalRateLimit);

// --- Localized server error messages ---
const SERVER_ERRORS: Record<string, Record<string, string>> = {
  'en': {
    unauthorized: 'Unauthorized',
    not_found: 'Not found',
    rate_limit: 'Too many requests. Please slow down.',
    server_error: 'Server error',
    too_many_messages: 'Too many messages. Slow down.',
    new_account_restriction: 'New accounts cannot post in groups/channels for 24 hours',
    spam_detected: 'You are sending messages too quickly. Please slow down.',
    empty_message: 'Empty message',
    message_too_long: 'Message is too long',
    blacklisted_url: 'Message contains a blacklisted URL',
    cannot_edit: 'Cannot edit other messages',
    cannot_delete: 'Cannot delete other messages',
    no_such_chat: 'No such chat',
    no_such_message: 'No such message',
    user_not_found: 'User not found',
    username_taken: 'Username is taken',
    invalid_phone: 'Invalid phone number',
    code_expired: 'Code expired or invalid',
    too_many_attempts: 'Too many attempts. Try again later.',
  },
  'ru': {
    unauthorized: 'Не авторизован',
    not_found: 'Не найдено',
    rate_limit: 'Слишком много запросов. Замедлитесь.',
    server_error: 'Ошибка сервера',
    too_many_messages: 'Слишком много сообщений. Замедлитесь.',
    new_account_restriction: 'Новые аккаунты не могут писать в группах/каналах 24 часа',
    spam_detected: 'Вы отправляете сообщения слишком быстро. Замедлитесь.',
    empty_message: 'Пустое сообщение',
    message_too_long: 'Сообщение слишком длинное',
    blacklisted_url: 'Сообщение содержит запрещённую ссылку',
    cannot_edit: 'Нельзя редактировать чужие сообщения',
    cannot_delete: 'Нельзя удалять чужие сообщения',
    no_such_chat: 'Чат не найден',
    no_such_message: 'Сообщение не найдено',
    user_not_found: 'Пользователь не найден',
    username_taken: 'Имя пользователя занято',
    invalid_phone: 'Неверный номер телефона',
    code_expired: 'Код истёк или неверный',
    too_many_attempts: 'Слишком много попыток. Попробуйте позже.',
  },
};
function t_server(key: string, lang?: string): string {
  const l = lang && SERVER_ERRORS[lang] ? lang : 'en';
  return SERVER_ERRORS[l]?.[key] ?? SERVER_ERRORS['en']?.[key] ?? key;
}

// ======================== AUTH MIDDLEWARE ========================

// Paths that do NOT require authentication
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/checkPhone', '/api/auth/sendCode', '/api/auth/signIn', '/api/auth/signUp', '/api/auth/checkPassword', '/api/auth/captcha/challenge', '/api/auth/captcha/verify', '/api/auth/verifyTotp', '/api/auth/recover']);

function getOriginalPath(req: express.Request): string {
  return req.baseUrl + req.path;
}

/**
 * Auth middleware: reads token from cookie OR Authorization header.
 * Cookie-first approach: if session cookie exists, use it; otherwise fall back to Bearer token.
 * Skips public paths (health, auth endpoints).
 */
function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Skip auth for public paths
  if (PUBLIC_PATHS.has(getOriginalPath(req))) return next();

  let token: string | null = null;

  // Try cookie first
  const cookies = parseCookies(req);
  const cookieToken = cookies[config.sessionCookieName];
  if (cookieToken) {
    token = cookieToken;
  }

  // Fall back to Authorization header
  if (!token) {
    const header = req.headers.authorization ?? '';
    token = header.startsWith('Bearer ') ? header.slice(7) : null;
  }

  const session = token ? getSessionByToken(token) : null;
  if (!session) return res.status(401).json({ error: t_server('unauthorized') });
  (req as any).userId = session.user_id;
  (req as any).token = token;
  (req as any).sessionId = session.id;
  next();
}

/**
 * CSRF protection middleware: validates X-CSRF-Token header against csrf_token cookie.
 * Skips GET/HEAD/OPTIONS (safe methods) and public paths.
 */
function csrfProtection(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Safe methods don't need CSRF protection
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  // Public / pre-auth endpoints don't need CSRF
  if (PUBLIC_PATHS.has(getOriginalPath(req))) {
    return next();
  }

  const cookies = parseCookies(req);
  const csrfCookie = cookies[config.csrfCookieName];
  const csrfHeader = req.headers['x-csrf-token'];

  if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
    log.suspicious('csrf_violation', {
      ip: String(req.ip || ''),
      path: req.path,
      method: req.method,
      userId: (req as any).userId,
    });
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

// Apply CSRF protection after auth (auth sets userId needed for logging)
app.use('/api', auth, csrfProtection);

// ======================== ROUTES ========================

app.get('/api/health', async (_req, res) => {
  let dbOk = false;
  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch { /* db error */ }
  let redisOk = false;
  try {
    const c = await import('./lib/redis.js').then(m => m.getRedisClient());
    await c.set('_health', '1', 'EX', 5);
    redisOk = true;
  } catch { /* redis error */ }
  const status = dbOk ? 200 : 503;
  res.status(status).json({ ok: dbOk, db: dbOk, redis: redisOk });
});

// --- Metrics endpoint (admin only) ---
app.get('/api/metrics', (req, res) => {
  const selfId = (req as any).userId;
  if (!selfId || !isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  try {
    const users = (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c;
    const chats = (db.prepare('SELECT COUNT(*) as c FROM chats').get() as any).c;
    const messages = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE deleted = 0').get() as any).c;
    const groups = (db.prepare("SELECT COUNT(*) as c FROM chats WHERE kind = 'group'").get() as any).c;
    const channels = (db.prepare("SELECT COUNT(*) as c FROM chats WHERE kind = 'channel'").get() as any).c;
    const activeToday = (db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM sessions WHERE last_seen_at >= datetime('now', '-1 day')").get() as any).c;
    const mediaCount = (db.prepare('SELECT COUNT(*) as c FROM media').get() as any).c;
    const suspicious = (db.prepare('SELECT COUNT(*) as c FROM suspicious_events WHERE created_at >= datetime(\'now\', \'-1 day\')').get() as any).c;
    res.json({
      uptime: process.uptime(),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      users, chats, messages, groups, channels, active_today: activeToday, media_count: mediaCount, suspicious_today: suspicious,
    });
  } catch (e) {
    res.status(500).json({ error: 'Metrics unavailable' });
  }
});
app.use('/api/auth', authRouter);

app.get('/api/me', (req, res) => {
  const user = getUserById((req as any).userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(user));
});

// --- profile update: name, bio, username, photo, optional 2FA password ---
function validPhoto(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null; // clear photo
  if (typeof v !== 'string') return null;
  if (!/^data:image\/(png|jpe?g|webp);base64,/.test(v)) return null;
  if (v.length > 400_000) return null;
  return v;
}

app.patch('/api/me', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId)!;
  const firstName = req.body?.first_name !== undefined ? String(req.body.first_name).trim() : user.first_name;
  const lastName = req.body?.last_name !== undefined ? String(req.body.last_name).trim() : user.last_name;
  const bio = req.body?.bio !== undefined ? String(req.body.bio).trim().slice(0, 200) : user.bio;
  const birthdayRaw = req.body?.birthday;
  const birthday = birthdayRaw != null && birthdayRaw !== '' ? String(birthdayRaw).trim() : '';
  if (birthday && !/^(?:\d{4}-)?\d{2}-\d{2}$/.test(birthday)) {
    return res.status(400).json({ error: 'Birthday must be YYYY-MM-DD or MM-DD' });
  }
  let username = req.body?.username !== undefined ? String(req.body.username).trim().replace(/^@/, '') : user.username;
  const passwordBody = req.body?.password;
  const password = passwordBody === undefined ? user.password : passwordBody === null ? null : String(passwordBody);
  const photo = req.body?.photo !== undefined ? validPhoto(req.body.photo) : user.photo;

  if (!firstName) return res.status(400).json({ error: 'First name is required' });
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars: letters, digits, underscore' });
  }
  if (username !== user.username && getUserByUsername(username)) {
    return res.status(409).json({ error: 'Username is taken' });
  }
  if (password !== null && password.length > 0 && password.length < 6) {
    return res.status(400).json({ error: 'Password too short' });
  }
  if (photo === null && req.body?.photo !== undefined && req.body.photo !== '' && req.body.photo !== null) {
    return res.status(400).json({ error: 'Invalid photo' });
  }

  const newPassword = password === null ? user.password : password === '' ? null : hashPassword(password);
  db.prepare('UPDATE users SET first_name = ?, last_name = ?, bio = ?, username = ?, password = ?, photo = ?, birthday = ? WHERE id = ?').run(
    firstName,
    lastName,
    bio,
    username,
    newPassword,
    photo,
    birthday || null,
    selfId,
  );
  res.json(publicUser(getUserById(selfId)!));
});

// --- username change without conflicts (case-insensitive uniqueness) ---
app.patch('/api/me/username', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const username = String(req.body?.username ?? '').trim().replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 5-32 chars: letters, digits, underscore' });
  }
  const conflict = db.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?) AND id != ?').get(username, selfId);
  if (conflict) return res.status(409).json({ error: 'Username is taken' });
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, selfId);
  log.suspicious('username_changed', { userId: selfId, from: user.username, to: username });
  res.json({ ok: true, user: publicUser(getUserById(selfId)!) });
});

// --- settings (theme, notifications, media, animations, effects, lang, privacy) ---
function sanitizeSettings(body: any, existing: Record<string, unknown>): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  if (body?.theme === 'dark' || body?.theme === 'light') s.theme = body.theme;
  if (typeof body?.animations === 'boolean') s.animations = body.animations;
  if (typeof body?.effects === 'boolean') s.effects = body.effects;
  if (typeof body?.lang === 'string' && /^[a-z]{2,5}$/.test(body.lang)) s.lang = body.lang;
  const n = body?.notifications;
  if (n && typeof n === 'object') s.notifications = { enabled: Boolean(n.enabled), sound: Boolean(n.sound) };
  const m = body?.media;
  if (m && typeof m === 'object') s.media = { wifi: Boolean(m.wifi), roaming: Boolean(m.roaming), mobile: Boolean(m.mobile) };
  const p = body?.privacy;
  if (p && typeof p === 'object') {
    const prev = (existing.privacy ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = { ...prev };
    for (const k of ['last_seen', 'phone', 'photo', 'bio', 'groups', 'forwarded']) {
      const v = p[k];
      if (v === 'everybody' || v === 'contacts' || v === 'nobody') out[k] = v;
    }
    s.privacy = out;
  }
  return s;
}

app.put('/api/me/settings', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId)!;
  const existing = (() => { try { return user.settings && user.settings !== '{}' ? JSON.parse(user.settings) : {}; } catch { return {}; } })();
  const patch = sanitizeSettings(req.body?.settings ?? req.body, existing);
  const merged = { ...existing, ...patch };
  db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(merged), selfId);
  res.json(publicUser(getUserById(selfId)!));
});

// --- two-step verification (2FA) ---
app.post('/api/me/2fa', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId)!;
  const password = String(req.body?.password ?? '');
  const recoveryEmail = req.body?.recovery_email !== undefined ? String(req.body.recovery_email).trim().slice(0, 254) : user.recovery_email;

  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (user.password) {
    const current = String(req.body?.current_password ?? '');
    if (!verifyPassword(current, user.password)) return res.status(403).json({ error: 'Current password is wrong' });
  }
  db.prepare('UPDATE users SET password = ?, recovery_email = ? WHERE id = ?').run(
    hashPassword(password),
    recoveryEmail || null,
    selfId,
  );
  res.json({ ok: true, user: publicUser(getUserById(selfId)!) });
});

app.delete('/api/me/2fa', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId)!;
  if (user.password) {
    const password = String(req.body?.password ?? '');
    if (!verifyPassword(password, user.password)) return res.status(403).json({ error: 'Password is wrong' });
  }
  db.prepare('UPDATE users SET password = NULL, recovery_email = NULL WHERE id = ?').run(selfId);
  res.json({ ok: true, user: publicUser(getUserById(selfId)!) });
});

// --- recovery codes ---
app.get('/api/me/recovery-codes', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not' });
  const cnt = db.prepare('SELECT COUNT(*) as cnt FROM recovery_codes WHERE user_id = ? AND used = 0').get(selfId) as { cnt: number };
  res.json({ count: cnt.cnt });
});

app.post('/api/me/recovery-codes', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.password) {
    const password = String(req.body?.password ?? '');
    if (!verifyPassword(password, user.password)) return res.status(403).json({ error: 'Wrong password' });
  }
  const codes = db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(selfId);
  const insert = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
  const plaintext: string[] = [];
  for (let i = 0; i < 10; i++) {
    const code = randomToken(4).toUpperCase().replace(/(.{4})/g, '$1-').slice(0, -1);
    insert.run(selfId, sha256Hex(code));
    plaintext.push(code);
  }
  log.suspicious('recovery_codes_regenerated', { userId: selfId });
  res.json({ codes: plaintext });
});

// --- TOTP 2FA (authenticator app) ---
import { generateSecret, verifyTotp, getOtpauthUri } from './lib/totp.js';

app.get('/api/me/totp', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ enabled: !!user.totp_secret });
});

app.post('/api/me/totp/setup', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.totp_secret) return res.status(400).json({ error: 'TOTP already enabled. Disable first.' });
  const secret = generateSecret();
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, selfId);
  const uri = getOtpauthUri(secret, user.username);
  res.json({ secret, uri });
});

app.post('/api/me/totp/verify', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.totp_secret) return res.status(400).json({ error: 'TOTP not enabled' });
  const token = String(req.body?.token ?? '').trim();
  if (!token || token.length !== 6) return res.status(400).json({ error: 'Invalid TOTP code' });
  if (!verifyTotp(user.totp_secret, token)) {
    log.suspicious('totp_verify_fail', { userId: selfId });
    return res.status(403).json({ error: 'Invalid TOTP code' });
  }
  res.json({ ok: true });
});

app.delete('/api/me/totp', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = String(req.body?.password ?? '');
  if (user.password && !verifyPassword(password, user.password)) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  if (user.totp_secret) {
    const token = String(req.body?.token ?? '').trim();
    if (!token || !verifyTotp(user.totp_secret, token)) {
      return res.status(400).json({ error: 'Invalid TOTP code required to disable' });
    }
  }
  db.prepare('UPDATE users SET totp_secret = NULL WHERE id = ?').run(selfId);
  res.json({ ok: true, user: publicUser(getUserById(selfId)!) });
});

// --- phone number change ---
app.post('/api/me/phone/request', async (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = String(req.body?.password ?? '');
  if (user.password && !verifyPassword(password, user.password)) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  const newPhone = validatePhone(String(req.body?.new_phone ?? ''));
  if (!newPhone) return res.status(400).json({ error: 'Invalid phone number' });
  if (newPhone === user.phone) return res.status(400).json({ error: 'Same phone number' });
  const existing = getUserByPhone(newPhone);
  if (existing) return res.status(409).json({ error: 'This phone number is already registered' });
  const code = generateCode();
  const codeHash = sha256Hex(code);
  const expiresAt = new Date(Date.now() + config.codeTtlMs).toISOString();
  db.prepare('DELETE FROM phone_change_codes WHERE user_id = ?').run(selfId);
  db.prepare('INSERT INTO phone_change_codes (user_id, new_phone, code_hash, expires_at) VALUES (?, ?, ?, ?)').run(selfId, newPhone, codeHash, expiresAt);
  try {
    await deliverCode(newPhone, code);
    log.suspicious('phone_change_code_sent', { userId: selfId, newPhone });
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: 'Could not deliver SMS code' });
  }
});

app.post('/api/me/phone/confirm', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const code = String(req.body?.code ?? '').trim();
  if (!code) return res.status(400).json({ error: 'Code is required' });
  const row = db.prepare('SELECT * FROM phone_change_codes WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(selfId) as any;
  if (!row) return res.status(400).json({ error: 'No pending phone change. Request a code first.' });
  if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Code expired' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Too many attempts' });
  if (sha256Hex(code) !== row.code_hash) {
    db.prepare('UPDATE phone_change_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    log.suspicious('phone_change_code_fail', { userId: selfId });
    return res.status(400).json({ error: 'Wrong code' });
  }
  if (getUserByPhone(row.new_phone)) return res.status(409).json({ error: 'Phone already taken' });
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(row.new_phone, selfId);
  db.prepare('UPDATE phone_change_codes SET used = 1 WHERE id = ?').run(row.id);
  log.suspicious('phone_changed', { userId: selfId, oldPhone: user.phone, newPhone: row.new_phone });
  res.json({ ok: true, user: publicUser(getUserById(selfId)!) });
});

// --- account export ---
app.get('/api/me/export', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const myChats = db.prepare(`
    SELECT c.id, c.kind, c.title, c.created_at, cm.role, cm.joined_at
    FROM chat_members cm JOIN chats c ON c.id = cm.chat_id
    WHERE cm.user_id = ?
    UNION
    SELECT c.id, c.kind, c.title, c.created_at, NULL, c.created_at
    FROM chats c WHERE (c.user_a_id = ? OR c.user_b_id = ?) AND c.kind IN ('regular','secret')
  `).all(selfId, selfId, selfId) as any[];
  const chatIds = myChats.map((c: any) => c.id);
  const placeholders = chatIds.length ? chatIds.map(() => '?').join(',') : '0';
  const messages = chatIds.length
    ? db.prepare(`SELECT id, chat_id, sender_id, body, created_at, edited_at FROM messages WHERE chat_id IN (${placeholders}) AND deleted = 0 ORDER BY id`).all(...chatIds)
    : [];
  const blocked = db.prepare(`
    SELECT u.username, u.first_name, u.last_name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ?
  `).all(selfId);
  const sessions = db.prepare('SELECT id, created_at, expires_at, label FROM sessions WHERE user_id = ?').all(selfId);
  res.json({
    export_date: new Date().toISOString(),
    user: { id: user.id, phone: user.phone, username: user.username, first_name: user.first_name, last_name: user.last_name, bio: user.bio, birthday: user.birthday, created_at: user.created_at },
    settings: user.settings,
    chats: myChats,
    messages,
    blocked,
    sessions,
  });
});

// --- account deletion ---
app.delete('/api/me', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const password = String(req.body?.password ?? '');
  if (user.password && !verifyPassword(password, user.password)) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    // Delete messages from all chats owned/Member of
    db.prepare('DELETE FROM messages WHERE chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = ?)').run(selfId);
    db.prepare('DELETE FROM messages WHERE sender_id = ?').run(selfId);
    // Delete media + storage blobs
    const ownedMedia = db.prepare('SELECT storage_key FROM media WHERE sender_id = ?').all(selfId) as { storage_key?: string }[];
    for (const m of ownedMedia) {
      if (m.storage_key) deleteFile(m.storage_key).catch(() => {});
    }
    db.prepare('DELETE FROM media WHERE chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = ?)').run(selfId);
    db.prepare('DELETE FROM media WHERE sender_id = ?').run(selfId);
    // Delete reactions
    db.prepare('DELETE FROM reactions WHERE user_id = ?').run(selfId);
    // Delete chat members
    db.prepare('DELETE FROM chat_members WHERE user_id = ?').run(selfId);
    // Delete empty chats
    db.prepare('DELETE FROM chats WHERE id NOT IN (SELECT DISTINCT chat_id FROM chat_members)').run();
    // Delete blocks, sessions, auth_codes, recovery_codes, phone_change_codes
    db.prepare('DELETE FROM blocks WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM blocks WHERE blocked_id = ?').run(selfId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM auth_codes WHERE phone = ?').run(user.phone);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM phone_change_codes WHERE user_id = ?').run(selfId);
    // Delete E2E keys
    db.prepare('DELETE FROM e2e_signed_prekeys WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM e2e_one_time_prekeys WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM e2e_sessions WHERE sender_id = ? OR receiver_id = ?').run(selfId, selfId);
    db.prepare('DELETE FROM e2e_devices WHERE user_id = ?').run(selfId);
    // Delete push / FCM
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(selfId);
    // Delete folders / filters
    db.prepare('DELETE FROM folder_chats WHERE folder_id IN (SELECT id FROM folders WHERE user_id = ?)').run(selfId);
    db.prepare('DELETE FROM folders WHERE user_id = ?').run(selfId);
    // Delete saved messages / drafts / scheduled
    db.prepare('DELETE FROM saved_messages WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM drafts WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM scheduled_messages WHERE user_id = ?').run(selfId);
    // Delete moderation / ban data
    db.prepare('DELETE FROM shadow_bans WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM global_bans WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM group_bans WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM join_requests WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM reports WHERE reporter_id = ? OR target_id = ?').run(selfId, selfId);
    // Delete sticker packs / bots
    db.prepare('DELETE FROM user_sticker_packs WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM bots WHERE owner_id = ?').run(selfId);
    // Delete block history / edit history / admin log
    db.prepare('DELETE FROM block_history WHERE user_id = ? OR blocked_user_id = ?').run(selfId, selfId);
    db.prepare('DELETE FROM edit_history WHERE user_id = ?').run(selfId);
    db.prepare('DELETE FROM admin_log WHERE admin_id = ?').run(selfId);
    // Delete call history
    db.prepare('DELETE FROM call_history WHERE caller_id = ?').run(selfId);
    // Delete user
    db.prepare('DELETE FROM users WHERE id = ?').run(selfId);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  log.suspicious('account_deleted', { userId: selfId, phone: user.phone });
  clearSessionCookies(res);
  res.json({ ok: true });
});

// --- saved messages ---
app.get('/api/me/saved', (req, res) => {
  const selfId = (req as any).userId;
  const rows = db.prepare(`
    SELECT sm.id, sm.body, sm.created_at, sm.message_id, sm.chat_id,
           m.sender_id, m.body as msg_body, m.created_at as msg_created_at, m.e2e
    FROM saved_messages sm
    LEFT JOIN messages m ON m.id = sm.message_id
    WHERE sm.user_id = ?
    ORDER BY sm.created_at DESC
  `).all(selfId) as any[];
  res.json(rows.map((r) => ({
    id: r.id,
    body: r.body || (r.msg_body ? '[message]' : ''),
    created_at: r.created_at,
    message_id: r.message_id,
    chat_id: r.chat_id,
    sender_id: r.sender_id,
    is_e2e: r.e2e === 1,
  })));
});

app.post('/api/me/saved', (req, res) => {
  const selfId = (req as any).userId;
  const { message_id, chat_id, body } = req.body ?? {};
  if (!message_id && !body) return res.status(400).json({ error: 'Provide message_id or body' });
  if (message_id) {
    const msg = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ?').get(message_id, chat_id) as any;
    if (!msg) return res.status(404).json({ error: 'Message not found' });
  }
  const result = db.prepare('INSERT INTO saved_messages (user_id, message_id, chat_id, body) VALUES (?, ?, ?, ?)').run(selfId, message_id || null, chat_id || null, body || null);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.delete('/api/me/saved/:id', (req, res) => {
  const selfId = (req as any).userId;
  const id = Number(req.params.id);
  db.prepare('DELETE FROM saved_messages WHERE id = ? AND user_id = ?').run(id, selfId);
  res.json({ ok: true });
});

// --- scheduled messages ---
app.get('/api/me/scheduled', (req, res) => {
  const selfId = (req as any).userId;
  const rows = db.prepare('SELECT * FROM scheduled_messages WHERE user_id = ? AND sent = 0 ORDER BY scheduled_at').all(selfId);
  res.json(rows);
});

app.post('/api/me/scheduled', (req, res) => {
  const selfId = (req as any).userId;
  const { chat_id, body, media_id, reply_to, scheduled_at } = req.body ?? {};
  if (!chat_id || !body || !scheduled_at) return res.status(400).json({ error: 'chat_id, body, and scheduled_at required' });
  if (new Date(scheduled_at).getTime() <= Date.now()) return res.status(400).json({ error: 'scheduled_at must be in the future' });
  const result = db.prepare('INSERT INTO scheduled_messages (user_id, chat_id, body, media_id, reply_to, scheduled_at) VALUES (?, ?, ?, ?, ?, ?)').run(selfId, chat_id, body, media_id || null, reply_to || null, scheduled_at);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.delete('/api/me/scheduled/:id', (req, res) => {
  const selfId = (req as any).userId;
  const id = Number(req.params.id);
  db.prepare('DELETE FROM scheduled_messages WHERE id = ? AND user_id = ?').run(id, selfId);
  res.json({ ok: true });
});

// --- server-side drafts ---
app.get('/api/drafts', (req, res) => {
  const selfId = (req as any).userId;
  const rows = db.prepare('SELECT chat_id, text, updated_at FROM drafts WHERE user_id = ? ORDER BY updated_at DESC').all(selfId);
  res.json(rows);
});

app.put('/api/drafts/:chatId', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.chatId);
  if (!chatId || !Number.isInteger(chatId)) return res.status(400).json({ error: 'Invalid chatId' });
  if (!getChatForUser(chatId, selfId)) return res.status(404).json({ error: 'Chat not found' });
  const text = String(req.body?.text ?? '');
  db.prepare(`
    INSERT INTO drafts (user_id, chat_id, text) VALUES (?, ?, ?)
    ON CONFLICT(user_id, chat_id) DO UPDATE SET text = excluded.text, updated_at = datetime('now')
  `).run(selfId, chatId, text.slice(0, 4096));
  const row = db.prepare('SELECT chat_id, text, updated_at FROM drafts WHERE user_id = ? AND chat_id = ?').get(selfId, chatId);
  res.json({ ok: true, draft: row });
});

app.delete('/api/drafts/:chatId', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.chatId);
  db.prepare('DELETE FROM drafts WHERE user_id = ? AND chat_id = ?').run(selfId, chatId);
  res.json({ ok: true });
});

// --- folders (Telegram-style chat folders) ---
app.get('/api/folders', (req, res) => {
  const selfId = (req as any).userId;
  const folders = db.prepare('SELECT * FROM folders WHERE user_id = ? ORDER BY sort_order, id').all(selfId) as any[];
  const result = folders.map((f) => {
    const chatIds = db.prepare('SELECT chat_id FROM folder_chats WHERE folder_id = ?').all(f.id) as { chat_id: number }[];
    return { ...f, chat_ids: chatIds.map((c) => c.chat_id) };
  });
  res.json(result);
});

app.post('/api/folders', (req, res) => {
  const selfId = (req as any).userId;
  const { name, emoji, chat_ids } = req.body ?? {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Name required' });
  const result = db.prepare('INSERT INTO folders (user_id, name, emoji) VALUES (?, ?, ?)').run(selfId, name.slice(0, 50), emoji || null);
  const folderId = result.lastInsertRowid;
  if (Array.isArray(chat_ids)) {
    const insert = db.prepare('INSERT OR IGNORE INTO folder_chats (folder_id, chat_id) VALUES (?, ?)');
    for (const cid of chat_ids) insert.run(folderId, cid);
  }
  res.json({ ok: true, id: folderId });
});

app.put('/api/folders/:id', (req, res) => {
  const selfId = (req as any).userId;
  const folderId = Number(req.params.id);
  const folder = db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(folderId, selfId);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const { name, emoji, chat_ids, sort_order } = req.body ?? {};
  if (name) db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name.slice(0, 50), folderId);
  if (emoji !== undefined) db.prepare('UPDATE folders SET emoji = ? WHERE id = ?').run(emoji || null, folderId);
  if (typeof sort_order === 'number') db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?').run(sort_order, folderId);
  if (Array.isArray(chat_ids)) {
    db.prepare('DELETE FROM folder_chats WHERE folder_id = ?').run(folderId);
    const insert = db.prepare('INSERT OR IGNORE INTO folder_chats (folder_id, chat_id) VALUES (?, ?)');
    for (const cid of chat_ids) insert.run(folderId, cid);
  }
  res.json({ ok: true });
});

app.delete('/api/folders/:id', (req, res) => {
  const selfId = (req as any).userId;
  const folderId = Number(req.params.id);
  db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(folderId, selfId);
  res.json({ ok: true });
});

// --- timed mute ---
app.put('/api/chats/:id/mute', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const { muted, duration } = req.body ?? {};
  let mutedUntil: string | null = null;
  if (muted && typeof duration === 'number' && duration > 0) {
    mutedUntil = new Date(Date.now() + duration * 60_000).toISOString();
  }
  db.prepare('UPDATE chat_members SET muted = ?, muted_until = ? WHERE chat_id = ? AND user_id = ?').run(muted ? 1 : 0, mutedUntil, chatId, selfId);
  res.json({ ok: true, muted_until: mutedUntil });
});

// --- timed mute (POST): duration in seconds, null/omitted = forever ---
app.post('/api/chats/:id/mute', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const rawDuration = req.body?.duration;
  if (!isChatMember(chatId, selfId)) return res.status(404).json({ error: 'Chat not found' });
  let mutedUntil: string | null = null;
  if (rawDuration !== null && rawDuration !== undefined && rawDuration !== '') {
    const seconds = Math.floor(Number(rawDuration));
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10 * 366 * 24 * 3600) {
      return res.status(400).json({ error: 'Invalid duration' });
    }
    const until = new Date(Date.now() + seconds * 1000).toISOString();
    db.prepare("UPDATE chat_members SET muted = 1, muted_until = ? WHERE chat_id = ? AND user_id = ?").run(until, chatId, selfId);
    mutedUntil = until;
  } else {
    db.prepare('UPDATE chat_members SET muted = 1, muted_until = NULL WHERE chat_id = ? AND user_id = ?').run(chatId, selfId);
  }
  res.json({ ok: true, muted: true, muted_until: mutedUntil });
});

app.post('/api/contacts/import-phones', (req, res) => {
  const selfId = (req as any).userId;
  const phones: string[] = Array.isArray(req.body?.phones) ? req.body.phones.map(String) : [];
  if (!phones.length) return res.status(400).json({ error: 'phones array required' });
  // Normalize: strip non-digits, add + prefix if missing
  const normalized = phones.map((p) => {
    const digits = p.replace(/\D/g, '');
    return digits.length > 10 ? `+${digits}` : `+1${digits}`; // US default
  });
  const unique = [...new Set(normalized)].slice(0, 500);
  const placeholders = unique.map(() => '?').join(',');
  const users = db.prepare(`
    SELECT id, phone, username, first_name, last_name, photo
    FROM users WHERE phone IN (${placeholders})
  `).all(...unique) as any[];
  res.json({ matched: users.length, users });
});
app.put('/api/chats/:id/notify', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const level = String(req.body?.level ?? 'all');
  if (!['all', 'mentions', 'none'].includes(level)) return res.status(400).json({ error: 'Invalid level' });
  db.prepare('UPDATE chat_members SET notify_level = ? WHERE chat_id = ? AND user_id = ?').run(level, chatId, selfId);
  res.json({ ok: true, level });
});

// --- per-chat notify settings: level + mentions-only ---
app.patch('/api/chats/:id/notify-settings', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat || !isChatMember(chatId, selfId)) return res.status(404).json({ error: 'Chat not found' });
  if (req.body?.notify_level !== undefined) {
    const level = String(req.body.notify_level);
    if (!['all', 'mentions', 'none'].includes(level)) return res.status(400).json({ error: 'Invalid notify_level' });
    db.prepare('UPDATE chat_members SET notify_level = ? WHERE chat_id = ? AND user_id = ?').run(level, chatId, selfId);
  }
  if (req.body?.notify_mentions_only !== undefined) {
    const mo = req.body.notify_mentions_only === true || req.body.notify_mentions_only === 1 ? 1 : 0;
    db.prepare('UPDATE chat_members SET notify_mentions_only = ? WHERE chat_id = ? AND user_id = ?').run(mo, chatId, selfId);
  }
  const row = db.prepare('SELECT notify_level, notify_mentions_only FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, selfId) as any;
  res.json({ ok: true, notify_level: row?.notify_level ?? 'all', notify_mentions_only: Boolean(row?.notify_mentions_only) });
});

// --- quiet hours ("HH:MM"-"HH:MM", stored UTC) ---
function validTimeHM(v: unknown): string | null | false {
  if (v === null || v === '' ) return null;
  if (typeof v !== 'string') return false;
  if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(v.trim())) return false;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/)!;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

app.patch('/api/me/quiet-hours', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let start: string | null = user.quiet_hours_start ?? null;
  let end: string | null = user.quiet_hours_end ?? null;
  if (req.body?.start !== undefined) {
    const v = validTimeHM(req.body.start);
    if (v === false) return res.status(400).json({ error: 'start must be HH:MM' });
    start = v;
  }
  if (req.body?.end !== undefined) {
    const v = validTimeHM(req.body.end);
    if (v === false) return res.status(400).json({ error: 'end must be HH:MM' });
    end = v;
  }
  if ((start && !end) || (!start && end)) {
    return res.status(400).json({ error: 'Both start and end are required to enable quiet hours' });
  }
  db.prepare('UPDATE users SET quiet_hours_start = ?, quiet_hours_end = ? WHERE id = ?').run(start, end, selfId);
  res.json({ ok: true, quiet_hours_start: start, quiet_hours_end: end });
});

// --- Web Push ---
app.get('/api/push/vapid-public-key', (_req, res) => {
  if (!isWebPushEnabled()) return res.json({ enabled: false });
  res.json({ enabled: true, publicKey: getVapidPublicKey() });
});

app.post('/api/push/subscribe', (req, res) => {
  const selfId = (req as any).userId;
  const { endpoint, p256dh, auth } = req.body ?? {};
  if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'Missing push subscription fields' });
  db.prepare('INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)').run(selfId, endpoint, p256dh, auth);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', (req, res) => {
  const selfId = (req as any).userId;
  const { endpoint } = req.body ?? {};
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(selfId, endpoint);
  res.json({ ok: true });
});

// --- FCM device token registration ---
app.post('/api/push/fcm-token', (req, res) => {
  const selfId = (req as any).userId;
  const token = String(req.body?.token ?? '').trim();
  if (!token || token.length > 4096) return res.status(400).json({ error: 'Missing FCM token' });
  db.prepare('DELETE FROM fcm_tokens WHERE token = ? AND user_id != ?').run(token, selfId);
  db.prepare('INSERT OR IGNORE INTO fcm_tokens (user_id, token) VALUES (?, ?)').run(selfId, token);
  res.json({ ok: true });
});

app.post('/api/push/apns-token', (req, res) => {
  const selfId = (req as any).userId;
  const token = String(req.body?.token ?? '').trim();
  if (!token || token.length > 4096) return res.status(400).json({ error: 'Missing APNs token' });
  db.prepare('DELETE FROM apns_tokens WHERE token = ? AND user_id != ?').run(token, selfId);
  db.prepare('INSERT OR IGNORE INTO apns_tokens (user_id, token) VALUES (?, ?)').run(selfId, token);
  res.json({ ok: true });
});

// --- active sessions ---
app.get('/api/sessions', (req, res) => {
  const selfId = (req as any).userId;
  const currentId = (req as any).sessionId;
  res.json(
    listSessions(selfId).map((s) => ({ ...s, current: s.id === currentId })),
  );
});

app.delete('/api/sessions/:id', (req, res) => {
  const selfId = (req as any).userId;
  const sessionId = Number(req.params.id);
  if (!sessionId) return res.status(400).json({ error: 'Invalid session' });
  const removed = deleteSession(sessionId, selfId);
  if (!removed) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

// Terminate all sessions except current
app.post('/api/sessions/terminate-all', (req, res) => {
  const selfId = (req as any).userId;
  const currentId = (req as any).sessionId;
  // Delete all sessions except the current one
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(selfId, currentId);
  res.json({ ok: true });
});

// --- blocked users ---
app.get('/api/blocks', (req, res) => {
  const selfId = (req as any).userId;
  const ids = listBlockedIds(selfId);
  res.json(ids.map((id) => publicUserFor(getUserById(id)!, selfId)).filter(Boolean));
});

app.put('/api/blocks/:id', (req, res) => {
  const selfId = (req as any).userId;
  const blockedId = Number(req.params.id);
  if (!blockedId || blockedId === selfId) return res.status(400).json({ error: 'Invalid user' });
  if (!getUserById(blockedId)) return res.status(404).json({ error: 'User not found' });
  addBlock(selfId, blockedId);
  db.prepare('INSERT INTO block_history (user_id, blocked_user_id, action) VALUES (?, ?, ?)').run(selfId, blockedId, 'block');
  res.json({ ok: true });
});

app.delete('/api/blocks/:id', (req, res) => {
  const selfId = (req as any).userId;
  const blockedId = Number(req.params.id);
  removeBlock(selfId, blockedId);
  db.prepare('INSERT INTO block_history (user_id, blocked_user_id, action) VALUES (?, ?, ?)').run(selfId, blockedId, 'unblock');
  res.json({ ok: true });
});

// --- block history ---
app.get('/api/me/block-history', (req, res) => {
  const selfId = (req as any).userId;
  const rows = db.prepare(`
    SELECT bh.id, bh.action, bh.created_at,
           u.id as user_id, u.username, u.first_name, u.last_name, u.photo
    FROM block_history bh
    LEFT JOIN users u ON u.id = bh.blocked_user_id
    WHERE bh.user_id = ?
    ORDER BY bh.created_at DESC, bh.id DESC
    LIMIT 200
  `).all(selfId);
  res.json(rows.map((r: any) => ({
    id: r.id,
    action: r.action,
    created_at: r.created_at,
    user: r.user_id ? { id: r.user_id, username: r.username, first_name: r.first_name, last_name: r.last_name, photo: r.photo } : null,
  })));
});

// --- E2E public key upload ---
app.post('/api/users/e2e-key', (req, res) => {
  const userId = (req as any).userId;
  const { publicKey, fingerprint } = req.body ?? {};
  if (
    !publicKey || typeof publicKey !== 'object' || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' ||
    typeof publicKey.x !== 'string' || typeof publicKey.y !== 'string' ||
    !/^[A-Za-z0-9_-]{40,60}$/.test(publicKey.x) || !/^[A-Za-z0-9_-]{40,60}$/.test(publicKey.y)
  ) {
    return res.status(400).json({ error: 'Invalid E2E public key' });
  }
  const computedFingerprint = sha256Hex(JSON.stringify({ crv: publicKey.crv, x: publicKey.x, y: publicKey.y })).slice(0, 32);
  if (fingerprint && String(fingerprint) !== computedFingerprint) {
    return res.status(400).json({ error: 'Invalid E2E key fingerprint' });
  }
  db.prepare('UPDATE users SET e2e_public = ?, e2e_fp = ? WHERE id = ?').run(
    JSON.stringify(publicKey),
    computedFingerprint,
    userId,
  );
  res.json({ ok: true });
});

// --- E2E pre-key bundles (X3DH) ---
app.post('/api/e2e/prekeys/signed', (req, res) => {
  const selfId = (req as any).userId;
  const { prekey_id, public_jwk, signature } = req.body ?? {};
  if (typeof prekey_id !== 'number' || !public_jwk || !signature) {
    return res.status(400).json({ error: 'Missing prekey_id, public_jwk, or signature' });
  }
  if (public_jwk.kty !== 'EC' || public_jwk.crv !== 'P-256' ||
      typeof public_jwk.x !== 'string' || typeof public_jwk.y !== 'string') {
    return res.status(400).json({ error: 'Invalid signed prekey JWK' });
  }
  if (typeof signature !== 'string' || signature.length < 10 || signature.length > 512) {
    return res.status(400).json({ error: 'Invalid signature format' });
  }
  db.prepare(
    'INSERT OR REPLACE INTO e2e_signed_prekeys (user_id, prekey_id, public_jwk, signature) VALUES (?, ?, ?, ?)'
  ).run(selfId, prekey_id, JSON.stringify(public_jwk), signature);
  log.suspicious('e2e_signed_prekey_upload', { userId: selfId, prekey_id });
  res.json({ ok: true });
});

app.post('/api/e2e/prekeys/one-time', (req, res) => {
  const selfId = (req as any).userId;
  const keys = req.body?.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 100) {
    return res.status(400).json({ error: 'Provide 1-100 prekeys' });
  }
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM e2e_one_time_prekeys WHERE user_id = ? AND consumed = 0').get(selfId) as { cnt: number };
  if (existing.cnt + keys.length > 500) {
    return res.status(400).json({ error: 'Too many unconsumed one-time prekeys (max 500)' });
  }
  const insert = db.prepare('INSERT OR IGNORE INTO e2e_one_time_prekeys (user_id, prekey_id, public_jwk) VALUES (?, ?, ?)');
  let added = 0;
  for (const k of keys) {
    if (typeof k.prekey_id !== 'number' || !k.public_jwk) continue;
    if (k.public_jwk.kty !== 'EC' || k.public_jwk.crv !== 'P-256') continue;
    insert.run(selfId, k.prekey_id, JSON.stringify(k.public_jwk));
    added++;
  }
  res.json({ ok: true, added });
});

app.get('/api/e2e/prekeys/:userId', (req, res) => {
  const targetId = Number(req.params.userId);
  if (!targetId) return res.status(400).json({ error: 'Invalid userId' });
  const user = getUserById(targetId);
  if (!user || !user.e2e_public) return res.status(404).json({ error: 'User has no E2E key' });
  const signedPrekey = db.prepare('SELECT prekey_id, public_jwk, signature FROM e2e_signed_prekeys WHERE user_id = ? ORDER BY prekey_id DESC LIMIT 1').get(targetId) as any;
  const oneTimePrekey = db.prepare('SELECT id, prekey_id, public_jwk FROM e2e_one_time_prekeys WHERE user_id = ? AND consumed = 0 ORDER BY id ASC LIMIT 1').get(targetId) as any;
  if (oneTimePrekey) {
    db.prepare('UPDATE e2e_one_time_prekeys SET consumed = 1 WHERE id = ?').run(oneTimePrekey.id);
  }
  res.json({
    identity_key: JSON.parse(user.e2e_public),
    identity_fp: user.e2e_fp,
    signed_prekey: signedPrekey ? { prekey_id: signedPrekey.prekey_id, public_jwk: JSON.parse(signedPrekey.public_jwk), signature: signedPrekey.signature } : null,
    one_time_prekey: oneTimePrekey ? { prekey_id: oneTimePrekey.prekey_id, public_jwk: JSON.parse(oneTimePrekey.public_jwk) } : null,
  });
});

// --- E2E Multi-Device ---
app.get('/api/e2e/devices', (req, res) => {
  const selfId = (req as any).userId;
  const devices = db.prepare('SELECT id, user_id, device_label, identity_key, created_at FROM e2e_devices WHERE user_id = ? ORDER BY created_at DESC').all(selfId);
  res.json(devices);
});

app.post('/api/e2e/devices', (req, res) => {
  const selfId = (req as any).userId;
  const { device_label, identity_key } = req.body ?? {};
  if (!identity_key || typeof identity_key !== 'string') {
    return res.status(400).json({ error: 'identity_key (JWK string) required' });
  }
  const label = String(device_label ?? '').slice(0, 100);
  const result = db.prepare('INSERT INTO e2e_devices (user_id, device_label, identity_key) VALUES (?, ?, ?)').run(selfId, label, identity_key);
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});

app.delete('/api/e2e/devices/:id', (req, res) => {
  const selfId = (req as any).userId;
  const deviceId = Number(req.params.id);
  if (!deviceId) return res.status(400).json({ error: 'Invalid device id' });
  const device = db.prepare('SELECT id FROM e2e_devices WHERE id = ? AND user_id = ?').get(deviceId, selfId);
  if (!device) return res.status(404).json({ error: 'Device not found' });
  db.prepare('DELETE FROM e2e_devices WHERE id = ? AND user_id = ?').run(deviceId, selfId);
  res.json({ ok: true });
});

app.get('/api/users/search', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const selfId = (req as any).userId;
  if (!q) return res.json([]);
  const safeQuery = q.replace(/[%_]/g, '');
  if (!safeQuery) return res.json([]);
  const rows = db
    .prepare(
      "SELECT * FROM users WHERE (username LIKE ? OR phone LIKE ? OR first_name LIKE ? OR last_name LIKE ?) AND id != ? LIMIT 10",
    )
    .all(`%${safeQuery}%`, `%${safeQuery}%`, `%${safeQuery}%`, `%${safeQuery}%`, selfId) as any[];
  // Apply find_me privacy: filter out users who don't want to be found
  const filtered = rows.filter((u) => privacyAllows(u, selfId, 'find_me'));
  res.json(filtered.map((u) => publicUserFor(u, selfId)));
});

app.get('/api/users/:id', (req, res) => {
  const selfId = (req as any).userId;
  const userId = Number(req.params.id);
  if (!userId || !Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Invalid user id' });
  }
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(publicUserFor(user, selfId));
});

// create or get a chat with a peer
app.post('/api/chats', (req, res) => {
  const selfId = (req as any).userId;
  const peerId = Number(req.body?.peerId);
  const kind: 'regular' | 'secret' = req.body?.kind === 'secret' ? 'secret' : 'regular';
  if (!peerId || peerId === selfId) return res.status(400).json({ error: 'Invalid peer' });
  const peer = getUserById(peerId);
  if (!peer) return res.status(404).json({ error: 'User not found' });
  if (isBlocked(selfId, peerId) || isBlocked(peerId, selfId)) {
    return res.status(403).json({ error: 'You cannot start a chat with this user' });
  }
  if (kind === 'secret') {
    if (!peer?.e2e_public) {
      return res.status(400).json({ error: 'Peer has no E2E key yet. They must sign in first.' });
    }
  }
  const chat = getOrCreateChat(kind, selfId, peerId);
  // re-open the chat if the current user had deleted it for themselves
  showChatForUser(chat.id, selfId);
  io.in(`user:${selfId}`).socketsJoin(roomName(chat.id));
  io.in(`user:${peerId}`).socketsJoin(roomName(chat.id));
  io.to(`user:${peerId}`).emit('chat:added', chatListEntry(chat, peerId));
  res.json({ chat, peer: publicUserFor(peer, selfId) });
});

// --- groups / channels ---

function validTitle(s: string): boolean {
  const t = String(s ?? '').trim();
  return t.length >= 1 && t.length <= 128;
}

function groupChatInfo(chatId: number, selfId: number) {
  const chat = getChatById(chatId)!;
  const members = listChatMembers(chatId).map((m) => ({
    user: publicUserFor(getUserById(m.user_id)!, selfId),
    role: m.role,
    rank: m.rank,
    joined_at: m.joined_at,
  }));
  return {
    chat: chatListEntry(chat, selfId),
    members,
  };
}

function logAdminAction(adminId: number, action: string, targetType: string | null, targetId: number | null, details?: string) {
  db.prepare('INSERT INTO admin_log (admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?)').run(
    adminId, action, targetType || null, targetId || null, details || null,
  );
}

function isBlacklisted(text: string): boolean {
  const patterns = db.prepare('SELECT pattern FROM link_blacklist').all() as { pattern: string }[];
  const lower = text.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p.pattern.toLowerCase())) return true;
  }
  return false;
}

function roomName(chatId: number) {
  return `chat:${chatId}`;
}

// Emit per-viewer group info (privacy-scrubbed) to every member of the group.
function broadcastGroupInfo(chatId: number) {
  const chat = getChatById(chatId);
  if (!chat) return;
  const memberIds = listChatMembers(chatId).map((m) => m.user_id);
  for (const uid of memberIds) {
    io.to(`user:${uid}`).emit('group:updated', groupChatInfo(chatId, uid));
  }
}

app.post('/api/groups', (req, res) => {
  const selfId = (req as any).userId;
  const kind: 'group' | 'channel' = req.body?.kind === 'channel' ? 'channel' : 'group';
  const title = String(req.body?.title ?? '').trim();
  const about = String(req.body?.about ?? '').trim().slice(0, 255);
  const photoBody = req.body?.photo;
  let photo: string | null = null;
  if (photoBody !== undefined) {
    if (photoBody !== '' && photoBody !== null && validPhoto(photoBody) === null) {
      return res.status(400).json({ error: 'Invalid photo' });
    }
    photo = validPhoto(photoBody);
  }
  if (!validTitle(title)) return res.status(400).json({ error: 'Title is required' });
  const ins = db
    .prepare('INSERT INTO chats (kind, user_a_id, user_b_id, title, about, photo) VALUES (?, ?, NULL, ?, ?, ?)')
    .run(kind, selfId, title, about, photo);
  const chatId = Number(ins.lastInsertRowid);
  addChatMember(chatId, selfId, 'owner');
  io.in(`user:${selfId}`).socketsJoin(roomName(chatId));
  const userIds = Array.isArray(req.body?.userIds)
    ? req.body.userIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0 && n !== selfId)
    : [];
  const seen = new Set<number>([selfId]);
  for (const uid of userIds) {
    const target = getUserById(uid);
    if (seen.has(uid) || !target || isBlocked(selfId, uid) || isBlocked(uid, selfId) || !privacyAllows(target, selfId, 'groups')) continue;
    seen.add(uid);
    addChatMember(chatId, uid, 'member', selfId);
    io.in(`user:${uid}`).socketsJoin(roomName(chatId));
    io.to(`user:${uid}`).emit('group:added', groupChatInfo(chatId, uid));
  }
  broadcastGroupInfo(chatId);
  res.json(groupChatInfo(chatId, selfId));
});

app.get('/api/chats/:id', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  res.json(groupChatInfo(chatId, selfId));
});

app.post('/api/groups/:id/members', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const userIds = Array.isArray(req.body?.userIds)
    ? req.body.userIds.map(Number).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];
  const maxMembers = (chat as any).max_members ?? 200000;
  const currentCount = listChatMembers(chatId).length;
  let added = 0;
  for (const uid of userIds) {
    if (currentCount + added >= maxMembers) break;
    const target = getUserById(uid);
    if (uid === selfId || isChatMember(chatId, uid) || !target || isBlocked(selfId, uid) || isBlocked(uid, selfId) || !privacyAllows(target, selfId, 'groups')) continue;
    addChatMember(chatId, uid, 'member', selfId);
    io.in(`user:${uid}`).socketsJoin(roomName(chatId));
    io.to(`user:${uid}`).emit('group:added', groupChatInfo(chatId, uid));
    added++;
  }
  const info = groupChatInfo(chatId, selfId);
  broadcastGroupInfo(chatId);
  res.json(info);
});

app.delete('/api/groups/:id/members/:userId', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  if (targetId === selfId) {
    if (chatMemberRole(chatId, selfId) === 'owner') {
      return res.status(409).json({ error: 'Transfer ownership before leaving this chat' });
    }
    removeChatMember(chatId, selfId);
    io.in(`user:${selfId}`).socketsLeave(roomName(chatId));
    broadcastGroupInfo(chatId);
    io.to(`user:${selfId}`).emit('chat:removed', { chatId });
    return res.json({ ok: true, left: true });
  }
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  if (!isChatMember(chatId, targetId)) return res.status(404).json({ error: 'Not a member' });
  const targetRole = chatMemberRole(chatId, targetId);
  if (targetRole === 'owner') return res.status(409).json({ error: 'The owner cannot be removed' });
  if (role === 'admin' && targetRole === 'admin') return res.status(403).json({ error: 'Admins cannot remove other admins' });
  removeChatMember(chatId, targetId);
  io.in(`user:${targetId}`).socketsLeave(roomName(chatId));
  io.to(`user:${targetId}`).emit('chat:removed', { chatId });
  const info = groupChatInfo(chatId, selfId);
  broadcastGroupInfo(chatId);
  res.json(info);
});

app.patch('/api/groups/:id', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const title = req.body?.title !== undefined ? String(req.body.title).trim() : (chat.title ?? '');
  const about = req.body?.about !== undefined ? String(req.body.about).trim().slice(0, 255) : chat.about;
  const photoBody = req.body?.photo;
  let photo: string | null = chat.photo;
  if (photoBody !== undefined) {
    if (photoBody !== '' && photoBody !== null && validPhoto(photoBody) === null) {
      return res.status(400).json({ error: 'Invalid photo' });
    }
    photo = validPhoto(photoBody);
  }
  let username = req.body?.username !== undefined ? String(req.body.username).trim().replace(/^@/, '') : (chat.username ?? '');
  if (!validTitle(title)) return res.status(400).json({ error: 'Title is required' });
  if (username) {
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-32 chars: letters, digits, underscore' });
    if (db.prepare('SELECT id FROM chats WHERE username = ? AND id != ?').get(username, chatId) || getUserByUsername(username)) {
      return res.status(409).json({ error: 'Username is taken' });
    }
  }
  db.prepare('UPDATE chats SET title = ?, about = ?, photo = ?, username = ? WHERE id = ?').run(
    title,
    about,
    photo,
    username || null,
    chatId,
  );
  const info = groupChatInfo(chatId, selfId);
  broadcastGroupInfo(chatId);
  res.json(info);
});

app.post('/api/groups/:id/promote', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const targetId = Number(req.body?.userId);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  if (chatMemberRole(chatId, selfId) !== 'owner') return res.status(403).json({ error: 'Only the owner can manage admins' });
  if (targetId === selfId || !isChatMember(chatId, targetId)) return res.status(404).json({ error: 'Not a member' });
  const newRole: 'admin' | 'member' | 'editor' = ['admin', 'editor'].includes(req.body?.role) ? req.body.role : 'member';
  setChatMemberRole(chatId, targetId, newRole, selfId);
  logAdminAction(selfId, 'change_role', 'user', targetId, `role: ${newRole}, chat: ${chatId}`);
  const info = groupChatInfo(chatId, selfId);
  broadcastGroupInfo(chatId);
  res.json(info);
});

app.post('/api/groups/:id/transfer-ownership', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const targetId = Number(req.body?.userId);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  if (chatMemberRole(chatId, selfId) !== 'owner') {
    return res.status(403).json({ error: 'Only the owner can transfer ownership' });
  }
  if (!Number.isInteger(targetId) || targetId <= 0 || targetId === selfId || !isChatMember(chatId, targetId)) {
    return res.status(404).json({ error: 'Not a member' });
  }

  db.prepare('UPDATE chat_members SET role = ?, promoted_by = ? WHERE chat_id = ? AND user_id = ?').run('admin', targetId, chatId, selfId);
  db.prepare('UPDATE chat_members SET role = ?, promoted_by = ? WHERE chat_id = ? AND user_id = ?').run('owner', selfId, chatId, targetId);

  const info = groupChatInfo(chatId, selfId);
  broadcastGroupInfo(chatId);
  res.json(info);
});

// --- invite links ---
app.post('/api/groups/:id/invite-links', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { max_uses, expires_at } = req.body ?? {};
  const token = randomToken(32);
  const result = db.prepare('INSERT INTO invite_links (chat_id, creator_id, token, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)').run(chatId, selfId, token, max_uses || null, expires_at || null);
  res.json({ ok: true, id: result.lastInsertRowid, token, link: `/join/${token}` });
});

app.get('/api/groups/:id/invite-links', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const links = db.prepare('SELECT * FROM invite_links WHERE chat_id = ? ORDER BY id DESC').all(chatId);
  res.json(links);
});

app.delete('/api/groups/:id/invite-links/:linkId', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const linkId = Number(req.params.linkId);
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM invite_links WHERE id = ? AND chat_id = ?').run(linkId, chatId);
  res.json({ ok: true });
});

app.post('/api/groups/join/:token', (req, res) => {
  const selfId = (req as any).userId;
  const token = String(req.params.token);
  const link = db.prepare('SELECT * FROM invite_links WHERE token = ?').get(token) as any;
  if (!link) return res.status(404).json({ error: 'Invalid invite link' });
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Link expired' });
  if (link.max_uses && link.uses >= link.max_uses) return res.status(400).json({ error: 'Link max uses reached' });
  // Check banned
  const banned = db.prepare('SELECT 1 FROM group_bans WHERE chat_id = ? AND user_id = ?').get(link.chat_id, selfId);
  if (banned) return res.status(403).json({ error: 'You are banned from this group' });
  db.prepare('UPDATE invite_links SET uses = uses + 1 WHERE id = ?').run(link.id);
  addChatMember(link.chat_id, selfId, 'member');
  const info = groupChatInfo(link.chat_id, selfId);
  res.json(info);
});

// --- public join by username ---
app.get('/api/groups/lookup/:username', (req, res) => {
  const selfId = (req as any).userId;
  const username = String(req.params.username).replace(/^@/, '').trim().toLowerCase();
  if (!username) return res.status(400).json({ error: 'Invalid username' });
  const chat = db.prepare("SELECT id, kind, title, about, photo, username FROM chats WHERE LOWER(username) = ? AND kind IN ('group', 'channel')").get(username) as any;
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json({ chat_id: chat.id, kind: chat.kind, title: chat.title, about: chat.about, photo: chat.photo, username: chat.username });
});

app.post('/api/groups/join-by-username/:username', (req, res) => {
  const selfId = (req as any).userId;
  const username = String(req.params.username).replace(/^@/, '').trim().toLowerCase();
  if (!username) return res.status(400).json({ error: 'Invalid username' });
  const chat = db.prepare("SELECT * FROM chats WHERE LOWER(username) = ? AND kind IN ('group', 'channel')").get(username) as any;
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (isChatMember(chat.id, selfId)) return res.json(groupChatInfo(chat.id, selfId));
  const banned = db.prepare('SELECT 1 FROM group_bans WHERE chat_id = ? AND user_id = ?').get(chat.id, selfId);
  if (banned) return res.status(403).json({ error: 'You are banned from this group' });
  addChatMember(chat.id, selfId, 'member');
  io.to(`chat:${chat.id}`).emit('group:updated', { chatId: chat.id });
  logAdminAction(selfId, 'join_public', 'chat', chat.id);
  res.json(groupChatInfo(chat.id, selfId));
});

// --- bans ---
app.post('/api/groups/:id/ban', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const targetId = Number(req.body?.userId);
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : null;
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const targetRole = chatMemberRole(chatId, targetId);
  if (targetRole === 'owner') return res.status(400).json({ error: 'Cannot ban the owner' });
  if (targetRole === 'admin' && role !== 'owner') return res.status(400).json({ error: 'Only owner can ban admins' });
  db.prepare('INSERT OR REPLACE INTO group_bans (chat_id, user_id, banned_by, reason) VALUES (?, ?, ?, ?)').run(chatId, targetId, selfId, reason);
  removeChatMember(chatId, targetId);
  io.to(`chat:${chatId}`).emit('group:updated', { chatId });
  logAdminAction(selfId, 'ban_user', 'user', targetId, reason || undefined);
  res.json({ ok: true });
});

app.delete('/api/groups/:id/ban/:userId', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM group_bans WHERE chat_id = ? AND user_id = ?').run(chatId, targetId);
  logAdminAction(selfId, 'unban_user', 'user', targetId);
  res.json({ ok: true });
});

app.get('/api/groups/:id/bans', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const bans = db.prepare(`
    SELECT gb.*, u.username, u.first_name, u.last_name, u.phone
    FROM group_bans gb JOIN users u ON u.id = gb.user_id
    WHERE gb.chat_id = ?
  `).all(chatId);
  res.json(bans);
});

// --- slow mode ---
app.put('/api/groups/:id/slow-mode', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const seconds = Math.min(Math.max(0, Number(req.body?.seconds ?? 0)), 3600);
  db.prepare('UPDATE chats SET slow_mode_seconds = ? WHERE id = ?').run(seconds, chatId);
  io.to(`chat:${chatId}`).emit('group:updated', { chatId });
  logAdminAction(selfId, 'slow_mode_change', 'chat', chatId, `seconds: ${seconds}`);
  res.json({ ok: true, slow_mode_seconds: seconds });
});

// --- admin: mute member with duration (posting restriction) ---
app.put('/api/groups/:id/mute-member', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const targetId = Number(req.body?.userId);
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const targetRole = chatMemberRole(chatId, targetId);
  if (targetRole === 'owner') return res.status(400).json({ error: 'Cannot mute the owner' });
  if (targetRole === 'admin' && role !== 'owner') return res.status(400).json({ error: 'Only owner can mute admins' });
  const duration = Number(req.body?.duration);
  if (Number.isFinite(duration) && duration > 0) {
    const until = new Date(Date.now() + Math.floor(duration) * 1000).toISOString();
    db.prepare("UPDATE chat_members SET muted = 1, muted_until = ? WHERE chat_id = ? AND user_id = ?").run(until, chatId, targetId);
  } else {
    db.prepare('UPDATE chat_members SET muted = 1, muted_until = NULL WHERE chat_id = ? AND user_id = ?').run(chatId, targetId);
  }
  io.to(`chat:${chatId}`).emit('group:updated', { chatId });
  logAdminAction(selfId, 'mute_member', 'user', targetId, `chat: ${chatId}, duration: ${duration}s`);
  res.json({ ok: true });
});

app.delete('/api/groups/:id/mute-member', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const targetId = Number(req.body?.userId);
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('UPDATE chat_members SET muted = 0, muted_until = NULL WHERE chat_id = ? AND user_id = ?').run(chatId, targetId);
  io.to(`chat:${chatId}`).emit('group:updated', { chatId });
  res.json({ ok: true });
});

// --- permission matrix ---
const VALID_PERMISSIONS = ['send_messages', 'send_media', 'send_stickers', 'embed_links', 'add_members', 'pin_messages', 'change_info'] as const;

app.get('/api/groups/:id/permissions', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  if (!getChatForUser(chatId, selfId)) return res.status(404).json({ error: 'Chat not found' });
  const perms = db.prepare('SELECT permission, role_required FROM chat_permissions WHERE chat_id = ?').all(chatId) as { permission: string; role_required: string }[];
  res.json(perms);
});

app.put('/api/groups/:id/permissions', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const updates = req.body?.permissions as Array<{ permission: string; role_required: string }> | undefined;
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'Invalid permissions' });
  for (const u of updates) {
    if (!VALID_PERMISSIONS.includes(u.permission as any)) continue;
    if (!['all', 'admin', 'owner'].includes(u.role_required)) continue;
    db.prepare('INSERT OR REPLACE INTO chat_permissions (chat_id, permission, role_required) VALUES (?, ?, ?)').run(chatId, u.permission, u.role_required);
  }
  io.to(`chat:${chatId}`).emit('group:updated', { chatId });
  res.json({ ok: true });
});

app.post('/api/groups/:id/permissions/reset', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  db.prepare('DELETE FROM chat_permissions WHERE chat_id = ?').run(chatId);
  io.to(`chat:${chatId}`).emit('group:updated', { chatId });
  res.json({ ok: true });
});

// --- channel: link discussion chat ---
app.put('/api/channels/:id/discussion', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as any;
  if (!chat || chat.kind !== 'channel') return res.status(404).json({ error: 'Channel not found' });
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const discussionId = req.body?.discussion_chat_id ? Number(req.body.discussion_chat_id) : null;
  if (discussionId) {
    const disc = db.prepare('SELECT * FROM chats WHERE id = ?').get(discussionId) as any;
    if (!disc || (disc.kind !== 'group' && disc.kind !== 'regular')) return res.status(400).json({ error: 'Invalid discussion chat' });
  }
  db.prepare('UPDATE chats SET discussion_chat_id = ? WHERE id = ?').run(discussionId, chatId);
  io.to(`chat:${chatId}`).emit('group:updated', { chatId });
  res.json({ ok: true, discussion_chat_id: discussionId });
});

// --- channel: record message view ---
app.post('/api/channels/:id/messages/:msgId/view', (req, res) => {
  const chatId = Number(req.params.id);
  const msgId = Number(req.params.msgId);
  db.prepare('UPDATE messages SET views = views + 1 WHERE id = ? AND chat_id = ?').run(msgId, chatId);
  res.json({ ok: true });
});

// --- channel: stats ---
app.get('/api/channels/:id/stats', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as any;
  if (!chat || chat.kind !== 'channel') return res.status(404).json({ error: 'Channel not found' });
  if (!isChatMember(chatId, selfId)) return res.status(403).json({ error: 'Not a member' });
  const totalMessages = (db.prepare('SELECT COUNT(*) as c FROM messages WHERE chat_id = ? AND deleted = 0').get(chatId) as any).c;
  const totalViews = (db.prepare('SELECT COALESCE(SUM(views), 0) as s FROM messages WHERE chat_id = ? AND deleted = 0').get(chatId) as any).s;
  const members = (db.prepare('SELECT COUNT(*) as c FROM chat_members WHERE chat_id = ?').get(chatId) as any).c;
  const topPosts = db.prepare('SELECT id, sender_id, created_at, views FROM messages WHERE chat_id = ? AND deleted = 0 ORDER BY views DESC LIMIT 10').all(chatId);
  res.json({ total_messages: totalMessages, total_views: totalViews, members, top_posts: topPosts });
});

// one chat-list entry (1:1, secret, group or channel) for the current user
function chatListEntry(chat: any, selfId: number) {
  const last = db
    .prepare('SELECT * FROM messages WHERE chat_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1')
    .get(chat.id) as any;
  const peer = !isGroupChat(chat)
    ? getUserById(chat.user_a_id === selfId ? chat.user_b_id : chat.user_a_id)
    : undefined;
  let preview = '';
  let mediaKind: string | null = null;
  let lastTime: string | null = null;
  if (last) {
    lastTime = last.created_at;
    if (chat.kind === 'secret') preview = 'Encrypted message';
    else if (last.media_id) {
      const media = getMediaById(last.media_id);
      mediaKind = media?.kind ?? null;
      preview = '';
    } else if (last.body && last.iv) {
      try {
        preview = decryptAtRest(
          Buffer.from(last.body as Uint8Array),
          Buffer.from(last.iv as Uint8Array),
        ).toString('utf8');
      } catch {
        preview = '[decryption failed]';
      }
    }
  }
  const member = getChatMember(chat.id, selfId);
  return {
    chat: {
      id: chat.id,
      kind: chat.kind,
      title: chat.title ?? null,
      about: chat.about ?? '',
      photo: chat.photo ?? null,
      username: chat.username ?? null,
      pinned_id: chat.pinned_id ?? null,
      pinned_messages: (() => { try { return JSON.parse((chat as any).pinned_messages ?? '[]'); } catch { return []; } })(),
      is_forum: Boolean((chat as any).is_forum),
      created_at: chat.created_at,
    },
    peer: peer ? publicUserFor(peer, selfId) : null,
    member_count: isGroupChat(chat) ? listChatMembers(chat.id).length : 2,
    role: isGroupChat(chat) ? (member?.role ?? null) : null,
    muted: isGroupChat(chat) ? Boolean(member?.muted) : false,
    notify_level: member?.notify_level ?? 'all',
    pinned: chatPinned(chat, selfId),
    last_message: last
      ? { id: last.id, sender_id: last.sender_id, created_at: lastTime, preview, media_kind: mediaKind, read_at: last.read_at }
      : null,
    unread: chatUnreadCount(chat, selfId),
    archived: chatArchived(chat, selfId),
  };
}

app.get('/api/chats', (req, res) => {
  const selfId = (req as any).userId;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before ? Number(req.query.before) : undefined;
  const direct = db
    .prepare('SELECT * FROM chats WHERE kind IN (?, ?) AND ((user_a_id = ? AND hidden_a = 0) OR (user_b_id = ? AND hidden_b = 0))')
    .all('regular', 'secret', selfId, selfId) as any[];
  const groups = db
    .prepare('SELECT c.* FROM chats c JOIN chat_members m ON m.chat_id = c.id WHERE c.kind IN (?, ?) AND COALESCE(c.is_deleted, 0) = 0 AND m.user_id = ?')
    .all('group', 'channel', selfId) as any[];
  const chats = [...direct, ...groups];
  let result = chats.map((chat) => chatListEntry(chat, selfId));
  // sort by most recent activity first (Telegram-style)
  result.sort((a, b) => {
    const ta = a.last_message?.created_at ?? a.chat.created_at;
    const tb = b.last_message?.created_at ?? b.chat.created_at;
    return String(tb).localeCompare(String(ta));
  });
  // cursor-based pagination
  if (before) {
    const idx = result.findIndex((c) => c.chat.id === before);
    if (idx >= 0) result = result.slice(idx + 1);
  }
  const hasMore = result.length > limit;
  const page = hasMore ? result.slice(0, limit) : result;
  res.json({ chats: page, hasMore });
});

app.get('/api/chats/:id/messages', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const before = req.query.before ? Number(req.query.before) : undefined;
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  let messages = getChatMessages(chatId, selfId);
  if (before && messages) {
    const idx = messages.findIndex((m: any) => m.id === before);
    if (idx > 0) messages = messages.slice(Math.max(0, idx - limit), idx);
    else if (idx === -1) messages = messages.slice(-limit);
  } else if (messages && messages.length > limit) {
    messages = messages.slice(-limit);
  }
  res.json(messages);
});

// --- Hashtag search ---
app.get('/api/hashtags/:tag', (req, res) => {
  const selfId = (req as any).userId;
  const tag = String(req.params.tag).toLowerCase().replace(/^#/, '');
  if (!tag) return res.status(400).json({ error: 'Hashtag required' });
  const chatIds = db.prepare(
    'SELECT DISTINCT chat_id FROM chat_members WHERE user_id = ? UNION SELECT DISTINCT id FROM chats WHERE user_a_id = ? OR user_b_id = ?',
  ).all(selfId, selfId, selfId) as { chat_id?: number; id?: number }[];
  const allChatIds = chatIds.map((r) => r.chat_id ?? r.id).filter((id): id is number => id != null);
  if (allChatIds.length === 0) return res.json([]);
  const placeholders = allChatIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM messages WHERE chat_id IN (${placeholders}) AND deleted = 0 AND hashtags LIKE ? ORDER BY id DESC LIMIT 100`,
  ).all(...allChatIds, `%"${tag}"%`) as any[];
  const results = rows.map((r) => {
    const body = r.body ? Buffer.from(r.body as Uint8Array) : null;
    const iv = r.iv ? Buffer.from(r.iv as Uint8Array) : null;
    let text = '';
    if (body && iv) { try { text = decryptAtRest(body, iv).toString('utf8'); } catch { text = ''; } }
    return { id: r.id, chat_id: r.chat_id, sender_id: r.sender_id, text, created_at: r.created_at };
  });
  res.json(results);
});

// --- Thread messages ---
app.get('/api/chats/:id/threads/:msgId', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const msgId = Number(req.params.msgId);
  if (!getChatForUser(chatId, selfId)) return res.status(404).json({ error: 'Chat not found' });
  const parent = db.prepare('SELECT id, body, iv, sender_id, created_at FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0').get(msgId, chatId) as any;
  if (!parent) return res.status(404).json({ error: 'Parent message not found' });
  const replies = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND thread_id = ? AND deleted = 0 ORDER BY id').all(chatId, msgId) as any[];
  const decryptedReplies = replies.map((r) => {
    const body = r.body ? Buffer.from(r.body as Uint8Array) : null;
    const iv = r.iv ? Buffer.from(r.iv as Uint8Array) : null;
    let text = '';
    if (body && iv) { try { text = decryptAtRest(body, iv).toString('utf8'); } catch { text = ''; } }
    return { id: r.id, sender_id: r.sender_id, text, created_at: r.created_at, thread_id: r.thread_id };
  });
  res.json({ parent: { id: parent.id, sender_id: parent.sender_id, created_at: parent.created_at }, replies: decryptedReplies });
});

// --- Custom Emoji CRUD ---
app.get('/api/chats/:id/emoji', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  if (!getChatForUser(chatId, selfId)) return res.status(404).json({ error: 'Chat not found' });
  const emoji = db.prepare('SELECT * FROM custom_emoji WHERE chat_id = ? ORDER BY id').all(chatId);
  res.json(emoji);
});

app.post('/api/chats/:id/emoji', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  if (!getChatForUser(chatId, selfId)) return res.status(404).json({ error: 'Chat not found' });
  const { shortcut, emoji_url } = req.body ?? {};
  if (!shortcut || !emoji_url) return res.status(400).json({ error: 'shortcut and emoji_url required' });
  const cleanShortcut = String(shortcut).trim().replace(/^:|:$/g, '').slice(0, 32);
  if (!cleanShortcut) return res.status(400).json({ error: 'Invalid shortcut' });
  try {
    const r = db.prepare('INSERT INTO custom_emoji (chat_id, shortcut, emoji_url, creator_id) VALUES (?, ?, ?, ?)').run(chatId, cleanShortcut, String(emoji_url).slice(0, 500), selfId);
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch {
    res.status(409).json({ error: 'Emoji shortcut already exists in this chat' });
  }
});

app.delete('/api/chats/:chatId/emoji/:id', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.chatId);
  const emojiId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const emoji = db.prepare('SELECT * FROM custom_emoji WHERE id = ? AND chat_id = ?').get(emojiId, chatId) as any;
  if (!emoji) return res.status(404).json({ error: 'Emoji not found' });
  if (emoji.creator_id !== selfId && chatMemberRole(chatId, selfId) !== 'owner' && chatMemberRole(chatId, selfId) !== 'admin') {
    return res.status(403).json({ error: 'Not allowed' });
  }
  db.prepare('DELETE FROM custom_emoji WHERE id = ?').run(emojiId);
  res.json({ ok: true });
});

// delete the chat for the current user (Telegram "Delete chat for me"); for groups — leave
app.delete('/api/chats/:id', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (isGroupChat(chat)) {
    if (chatMemberRole(chatId, selfId) === 'owner') {
      return res.status(409).json({ error: 'Transfer ownership before leaving this chat' });
    }
    removeChatMember(chatId, selfId);
    io.in(`user:${selfId}`).socketsLeave(roomName(chatId));
    broadcastGroupInfo(chatId);
    io.to(`user:${selfId}`).emit('chat:removed', { chatId });
    return res.json({ ok: true, left: true });
  }
  hideChatForUser(chatId, selfId);
  res.json({ ok: true });
});

// clear message history for the whole conversation
app.delete('/api/chats/:id/messages', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  if (!getChatForUser(chatId, selfId)) {
    return res.status(404).json({ error: 'Chat not found' });
  }
  db.prepare('UPDATE messages SET deleted = 1, body = NULL, iv = NULL WHERE chat_id = ?').run(chatId);
  db.prepare('UPDATE chats SET pinned_id = NULL WHERE id = ?').run(chatId);
  io.to(roomName(chatId)).emit('history:cleared', { chatId });
  res.json({ ok: true });
});

// full-text search inside a regular chat
app.get('/api/chats/:id/search', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const before = req.query.before ? Number(req.query.before) : null;
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!q) return res.json({ results: [], hasMore: false });
  if (chat.kind === 'secret') return res.json({ results: [], hasMore: false }); // server cannot read secret chats

  // Try FTS5 first for better performance
  let usedFts = false;
  try {
    const ftsQuery = q.replace(/['"]/g, '').split(/\s+/).filter(Boolean).join(' OR ');
    if (ftsQuery) {
      let sql = `SELECT rowid, chat_id, sender_id, text_content, created_at FROM messages_fts WHERE messages_fts MATCH ? AND chat_id = ?`;
      const params: any[] = [ftsQuery, chatId];
      if (before) {
        sql = `SELECT f.rowid, f.chat_id, f.sender_id, f.text_content, f.created_at FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? AND f.chat_id = ? AND f.rowid < ?`;
        params.splice(1, 0, before);
      }
      sql += ' ORDER BY f.rowid DESC LIMIT ?';
      params.push(limit + 1);
      const ftsRows = db.prepare(sql).all(...params) as Array<{ rowid: number; chat_id: number; sender_id: number; text_content: string; created_at: string }>;
      if (ftsRows.length > 0) {
        usedFts = true;
        const hasMore = ftsRows.length > limit;
        const sliced = hasMore ? ftsRows.slice(0, limit) : ftsRows;
        // Fetch delivery/read status from messages table
        const out = sliced.map((r) => {
          const msg = db.prepare('SELECT read_at, delivered_at, edited_at FROM messages WHERE id = ?').get(r.rowid) as any;
          return { id: r.rowid, chat_id: r.chat_id, sender_id: r.sender_id, created_at: r.created_at, read_at: msg?.read_at ?? null, delivered_at: msg?.delivered_at ?? null, edited_at: msg?.edited_at ?? null, text: r.text_content };
        });
        return res.json({ results: out, hasMore });
      }
    }
  } catch { /* FTS unavailable, fall back to LIKE */ }

  let sql = 'SELECT * FROM messages WHERE chat_id = ? AND deleted = 0';
  const params: any[] = [chatId];
  if (before) { sql += ' AND id < ?'; params.push(before); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit + 1);
  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    sender_id: number;
    body: Buffer | null;
    iv: Buffer | null;
    read_at: string | null;
    edited_at: string | null;
    created_at: string;
  }>;
  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const out: unknown[] = [];
  for (const r of sliced) {
    if (!r.body || !r.iv) continue;
    try {
      const text = decryptAtRest(Buffer.from(r.body as Uint8Array), Buffer.from(r.iv as Uint8Array)).toString('utf8');
      if (text.toLowerCase().includes(q)) {
        out.push({ id: r.id, chat_id: chatId, sender_id: r.sender_id, created_at: r.created_at, read_at: r.read_at, delivered_at: (r as any).delivered_at ?? null, edited_at: r.edited_at, text });
      }
    } catch {
      // skip undecryptable rows
    }
  }
  res.json({ results: out, hasMore });
});

// --- cross-chat message search ---
app.get('/api/messages/search', (req, res) => {
  const selfId = (req as any).userId;
  const q = String(req.query.q ?? '').trim();
  const authorId = req.query.author ? Number(req.query.author) : undefined;
  const dateFrom = req.query.date_from ? String(req.query.date_from) : req.query.from ? String(req.query.from) : undefined;
  const dateTo = req.query.date_to ? String(req.query.date_to) : req.query.to ? String(req.query.to) : undefined;
  const rawMediaType = req.query.media_type ? String(req.query.media_type) : undefined;
  const mediaTypeMap: Record<string, string> = { image: 'photo', voice: 'audio', file: 'file', text: 'text' };
  const mediaType = rawMediaType && rawMediaType in mediaTypeMap ? mediaTypeMap[rawMediaType] : undefined;
  if (rawMediaType && !mediaType) return res.status(400).json({ error: 'media_type must be one of: text, image, voice, file' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const before = req.query.before ? Number(req.query.before) : null;
  if (!q && !authorId && !mediaType) return res.json({ results: [], hasMore: false });
  // Get all chats the user is in
  const chatRows = db.prepare(`
    SELECT chat_id FROM chat_members WHERE user_id = ?
    UNION SELECT id FROM chats WHERE (user_a_id = ? OR user_b_id = ?) AND kind IN ('regular','secret')
  `).all(selfId, selfId, selfId) as { chat_id: number }[];
  const chatIds = chatRows.map((r) => r.chat_id);
  if (!chatIds.length) return res.json({ results: [], hasMore: false });

  // Try FTS5 first for better performance
  if (q) {
    try {
      const ftsQuery = q.replace(/['"]/g, '').split(/\s+/).filter(Boolean).join(' OR ');
      if (ftsQuery) {
        const placeholders = chatIds.map(() => '?').join(',');
        let sql = `SELECT f.rowid, f.chat_id, f.sender_id, f.text_content, f.created_at FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ? AND f.chat_id IN (${placeholders}) AND m.deleted = 0`;
        const params: any[] = [ftsQuery, ...chatIds];
        if (authorId) { sql += ' AND f.sender_id = ?'; params.push(authorId); }
        if (dateFrom) { sql += ' AND f.created_at >= ?'; params.push(dateFrom); }
        if (dateTo) { sql += ' AND f.created_at <= ?'; params.push(dateTo); }
        if (mediaType) { sql += ' AND m.media_id IS NOT NULL AND EXISTS (SELECT 1 FROM media WHERE media.id = m.media_id AND media.kind = ?)'; params.push(mediaType); } else if (mediaType === 'text') { sql += ' AND m.media_id IS NULL'; }
        if (before) { sql += ' AND f.rowid < ?'; params.push(before); }
        sql += ' ORDER BY f.rowid DESC LIMIT ?';
        params.push(limit + 1);
        const ftsRows = db.prepare(sql).all(...params) as Array<{ rowid: number; chat_id: number; sender_id: number; text_content: string; created_at: string }>;
        if (ftsRows.length > 0) {
          const hasMore = ftsRows.length > limit;
          const sliced = hasMore ? ftsRows.slice(0, limit) : ftsRows;
          const out = sliced.map((r) => {
            const msg = db.prepare('SELECT edited_at FROM messages WHERE id = ?').get(r.rowid) as any;
            return { id: r.rowid, chat_id: r.chat_id, sender_id: r.sender_id, created_at: r.created_at, text: r.text_content, edited_at: msg?.edited_at ?? null };
          });
          return res.json({ results: out, hasMore });
        }
      }
    } catch { /* FTS unavailable, fall back */ }
  }

  const placeholders = chatIds.map(() => '?').join(',');
  let sql = `SELECT * FROM messages WHERE chat_id IN (${placeholders}) AND deleted = 0`;
  const params: any[] = [...chatIds];

  if (authorId) { sql += ' AND sender_id = ?'; params.push(authorId); }
  if (dateFrom) { sql += ' AND created_at >= ?'; params.push(dateFrom); }
  if (dateTo) { sql += ' AND created_at <= ?'; params.push(dateTo); }
  if (mediaType === 'text') {
    sql += ' AND media_id IS NULL';
  } else if (mediaType) {
    sql += ' AND media_id IS NOT NULL AND EXISTS (SELECT 1 FROM media WHERE media.id = messages.media_id AND media.kind = ?)';
    params.push(mediaType);
  }
  if (before) { sql += ' AND id < ?'; params.push(before); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit + 1);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number; chat_id: number; sender_id: number;
    body: Buffer | null; iv: Buffer | null;
    created_at: string; edited_at: string | null;
  }>;

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, limit) : rows;
  const out: any[] = [];
  for (const r of sliced) {
    if (!r.body || !r.iv) continue;
    try {
      const text = decryptAtRest(Buffer.from(r.body), Buffer.from(r.iv)).toString('utf8');
      if (q && !text.toLowerCase().includes(q.toLowerCase())) continue;
      out.push({ id: r.id, chat_id: r.chat_id, sender_id: r.sender_id, created_at: r.created_at, text, edited_at: r.edited_at });
    } catch { /* skip */ }
  }
  res.json({ results: out, hasMore });
});

// --- contacts: import vCard ---
app.post('/api/contacts/import', (req, res) => {
  const selfId = (req as any).userId;
  const vcard = String(req.body?.vcard ?? '');
  if (!vcard) return res.status(400).json({ error: 'Missing vcard' });
  // Parse basic vCard: extract TEL and FN
  const phones: string[] = [];
  const names: string[] = [];
  const lines = vcard.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if (line.startsWith('TEL')) {
      const val = line.split(':').slice(1).join(':').replace(/[^0-9+]/g, '');
      if (val) phones.push(val);
    }
    if (line.startsWith('FN')) {
      const val = line.split(':').slice(1).join(':').trim();
      if (val) names.push(val);
    }
  }
  // Find matching users
  const matches: Array<{ phone: string; name: string; user?: any }> = [];
  for (let i = 0; i < phones.length; i++) {
    const user = db.prepare('SELECT id, phone, first_name, last_name, username, photo FROM users WHERE phone = ?').get(phones[i]) as any;
    matches.push({ phone: phones[i], name: names[i] || phones[i], user: user && user.id !== selfId ? user : undefined });
  }
  res.json({ contacts: matches });
});

// --- contacts: sync by phone numbers (E.164) ---
app.post('/api/contacts/sync', (req, res) => {
  const selfId = (req as any).userId;
  const phones = Array.isArray(req.body?.phones) ? req.body.phones.map((p: unknown) => String(p ?? '').trim()).filter(Boolean) : [];
  if (!phones.length) return res.status(400).json({ error: 'phones array required' });
  if (phones.length > 1000) return res.status(400).json({ error: 'Too many phone numbers (max 1000)' });
  const unique = [...new Set(phones)];
  const placeholders = unique.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, phone, first_name, last_name, username, photo FROM users WHERE phone IN (${placeholders})`).all(...(unique as string[])) as any[];
  const matched = rows.filter((u) => u.id !== selfId).map((u) => ({
    id: u.id,
    phone: u.phone,
    first_name: u.first_name,
    last_name: u.last_name,
    username: u.username,
    avatar: u.photo,
  }));
  res.json({ contacts: matched });
});

// --- media: chat gallery list ---
app.get('/api/chats/:id/media', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const before = req.query.before ? Number(req.query.before) : null;
  const mediaRows = before
    ? db.prepare('SELECT * FROM media WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(chatId, before, limit)
    : db.prepare('SELECT * FROM media WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, limit);
  res.json(mediaRows.map((m) => serializeMedia(m as any)));
});

// --- chat links (messages with URLs) ---
app.get('/api/chats/:id/links', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const urlRe = /https?:\/\/[^\s<>\"']+/gi;
  const rows = db.prepare(`
    SELECT id, sender_id, body, iv, created_at FROM messages
    WHERE chat_id = ? AND deleted = 0 AND body IS NOT NULL
    ORDER BY id DESC LIMIT 500
  `).all(chatId) as { id: number; sender_id: number; body: Buffer; iv: Buffer; created_at: string }[];
  const links: Array<{ message_id: number; sender_id: number; url: string; created_at: string }> = [];
  for (const r of rows) {
    try {
      const text = decryptAtRest(Buffer.from(r.body), Buffer.from(r.iv)).toString('utf8');
      const found = text.match(urlRe);
      if (found) {
        for (const u of found) {
          links.push({ message_id: r.id, sender_id: r.sender_id, url: u, created_at: r.created_at });
          if (links.length >= limit) break;
        }
      }
    } catch { /* ignore */ }
    if (links.length >= limit) break;
  }
  res.json({ links, hasMore: links.length >= limit });
});

// --- media: upload / fetch / forward ---

app.post('/api/media', upload.single('file'), async (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.body?.chatId);
  const kind = String(req.body?.kind ?? 'file');
  if (!['photo', 'file', 'audio'].includes(kind)) return res.status(400).json({ error: 'Invalid media kind' });
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!isGroupChat(chat)) {
    const peerId = chat.user_a_id === selfId ? chat.user_b_id : chat.user_a_id;
    if (peerId && (isBlocked(selfId, peerId) || isBlocked(peerId, selfId))) {
      return res.status(403).json({ error: 'You cannot send media to this user' });
    }
  }
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ error: 'No file' });
  }
  if (kind === 'photo' && !req.file.mimetype.startsWith('image/')) {
    return res.status(400).json({ error: 'Photo uploads must use an image content type' });
  }
  if (kind === 'audio' && !req.file.mimetype.startsWith('audio/')) {
    return res.status(400).json({ error: 'Voice uploads must use an audio content type' });
  }
  if (kind === 'audio') {
    const MAX_AUDIO_MS = 300_000;
    const durMs = req.body?.duration ? Number(req.body.duration) * 1000 : null;
    if (durMs !== null && durMs > MAX_AUDIO_MS) {
      return res.status(400).json({ error: 'Voice message duration limit is 5 minutes' });
    }
    // Rough fallback when no duration field: assume >= 32 kbps => 4000 bytes/sec
    if (durMs === null && req.file.size > (MAX_AUDIO_MS / 1000) * 4000) {
      return res.status(400).json({ error: 'Audio file exceeds 5 minutes limit' });
    }
  }
  const enc = encryptAtRest(req.file.buffer);
  const duration = req.body?.duration ? Number(req.body.duration) : null;
  const dims = (kind === 'photo') ? extractImageDimensions(req.file.buffer) : null;
  let storageKey: string | null = null;
  try {
    const key = `media/${selfId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await uploadFile(key, enc.body, req.file.mimetype || 'application/octet-stream');
    storageKey = key;
  } catch { /* Object Storage unavailable, fall back to DB blob */ }
  let thumbnailBuf: Buffer | null = null;
  if (kind === 'photo') {
    try {
      thumbnailBuf = await sharp(req.file.buffer).resize(200, 200, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer();
    } catch { /* ignore thumbnail generation errors */ }
  }
  const media = insertMedia({
    chatId,
    senderId: selfId,
    kind,
    name: String(req.file.originalname || 'file').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'file',
    mime: req.file.mimetype || 'application/octet-stream',
    size: req.file.size,
    body: enc.body,
    iv: enc.iv,
    duration: Number.isFinite(duration) && duration! > 0 ? duration : null,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    storage_key: storageKey,
    thumbnail: thumbnailBuf,
  } as any);
  res.json({ media: serializeMedia(media) });
});

// --- resumable upload (chunked) ---
const uploadSessions = new Map<string, { chunks: Buffer[]; totalChunks: number; meta: Record<string, string>; startedAt: number }>();

app.post('/api/media/upload-init', (req, res) => {
  const selfId = (req as any).userId;
  const { chatId, kind, name, mime, totalChunks, size } = req.body ?? {};
  if (!chatId || !totalChunks) return res.status(400).json({ error: 'Missing fields' });
  const uploadId = `u_${selfId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  uploadSessions.set(uploadId, {
    chunks: [],
    totalChunks: Number(totalChunks),
    meta: { chatId: String(chatId), kind: String(kind ?? 'file'), name: String(name ?? 'file'), mime: String(mime ?? 'application/octet-stream'), size: String(size ?? 0), senderId: String(selfId) },
    startedAt: Date.now(),
  });
  // Clean up old sessions (>30 min)
  for (const [id, s] of uploadSessions) {
    if (Date.now() - s.startedAt > 30 * 60_000) uploadSessions.delete(id);
  }
  res.json({ uploadId });
});

app.post('/api/media/upload-chunk', upload.single('chunk'), (req, res) => {
  const { uploadId, chunkIndex } = req.body ?? {};
  const session = uploadSessions.get(uploadId);
  if (!session) return res.status(404).json({ error: 'Upload session not found' });
  if (!req.file?.buffer) return res.status(400).json({ error: 'No chunk data' });
  session.chunks[Number(chunkIndex)] = req.file.buffer;
  res.json({ ok: true, received: session.chunks.filter(Boolean).length, total: session.totalChunks });
});

app.post('/api/media/upload-finalize', async (req, res) => {
  const selfId = (req as any).userId;
  const { uploadId } = req.body ?? {};
  const session = uploadSessions.get(uploadId);
  if (!session) return res.status(404).json({ error: 'Upload session not found' });
  uploadSessions.delete(uploadId);

  // Concatenate chunks
  const totalLen = session.chunks.reduce((s, c) => s + (c?.length ?? 0), 0);
  const combined = Buffer.alloc(totalLen);
  let offset = 0;
  for (const chunk of session.chunks) {
    if (chunk) { chunk.copy(combined, offset); offset += chunk.length; }
  }

  const m = session.meta;
  const chatId = Number(m.chatId);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const enc = encryptAtRest(combined);
  let storageKey2: string | null = null;
  try {
    const key = `media/${selfId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await uploadFile(key, enc.body, m.mime || 'application/octet-stream');
    storageKey2 = key;
  } catch { /* Object Storage unavailable */ }
  let thumbBuf2: Buffer | null = null;
  if (m.kind === 'photo') {
    try { thumbBuf2 = await sharp(combined).resize(200, 200, { fit: 'cover' }).jpeg({ quality: 70 }).toBuffer(); } catch { /* ignore */ }
  }
  const media = insertMedia({
    chatId,
    senderId: selfId,
    kind: m.kind as string,
    name: (m.name || 'file').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || 'file',
    mime: m.mime || 'application/octet-stream',
    size: combined.length,
    body: enc.body,
    iv: enc.iv,
    duration: null,
    storage_key: storageKey2,
    thumbnail: thumbBuf2,
  } as any);
  res.json({ media: serializeMedia(media) });
});

app.get('/api/media/:id', async (req, res) => {
  const selfId = (req as any).userId;
  const media = getMediaById(Number(req.params.id));
  if (!media) return res.status(404).json({ error: 'Media not found' });
  const chat = getChatForUser(media.chat_id, selfId);
  if (!chat && media.sender_id !== selfId) return res.status(403).json({ error: 'Forbidden' });
  if (!media.body || !media.iv) return res.status(404).json({ error: 'Media empty' });
  let plain: Buffer;
  if ((media as any).storage_key) {
    try {
      const raw = await getFile((media as any).storage_key);
      plain = decryptAtRest(raw, Buffer.from(media.iv as Uint8Array));
    } catch {
      plain = decryptAtRest(Buffer.from(media.body as Uint8Array), Buffer.from(media.iv as Uint8Array));
    }
  } else {
    plain = decryptAtRest(Buffer.from(media.body as Uint8Array), Buffer.from(media.iv as Uint8Array));
  }
  res.set('Content-Type', media.mime || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=3600');
  if (req.query.download !== undefined) {
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(media.name || 'file')}`);
  }
  res.send(plain);
});

app.get('/api/media/:id/thumb', (req, res) => {
  const selfId = (req as any).userId;
  const media = getMediaById(Number(req.params.id));
  if (!media) return res.status(404).json({ error: 'Media not found' });
  const chat = getChatForUser(media.chat_id, selfId);
  if (!chat && media.sender_id !== selfId) return res.status(403).json({ error: 'Forbidden' });
  if (!media.thumbnail) return res.status(404).json({ error: 'No thumbnail' });
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(media.thumbnail as Uint8Array));
});

// Audio normalization: peak-normalize WAV files to -1 dBFS; returns other formats unchanged.
app.post('/api/media/:id/normalize-audio', (req, res) => {
  const selfId = (req as any).userId;
  const media = getMediaById(Number(req.params.id));
  if (!media) return res.status(404).json({ error: 'Media not found' });
  const chat = getChatForUser(media.chat_id, selfId);
  if (!chat && media.sender_id !== selfId) return res.status(403).json({ error: 'Forbidden' });
  if (media.kind !== 'audio') return res.status(400).json({ error: 'Not an audio media' });
  if (!media.body || !media.iv) return res.status(404).json({ error: 'Media empty' });
  const plain = decryptAtRest(Buffer.from(media.body as Uint8Array), Buffer.from(media.iv as Uint8Array));
  // Only normalize WAV PCM data (RIFF header)
  const isWav = plain.length > 44 && plain.slice(0, 4).toString('ascii') === 'RIFF' && plain.slice(8, 12).toString('ascii') === 'WAVE';
  if (!isWav) {
    res.set('Content-Type', media.mime || 'application/octet-stream');
    res.set('X-Normalized', 'false');
    if (req.query.json === '1') return res.json({ media: serializeMedia(media), normalized: false });
    return res.send(plain);
  }
  // Parse WAV: bits per sample from fmt chunk
  const bitsPerSample = plain.readUInt16LE(34);
  const dataOffset = 44; // standard PCM header
  const dataLen = plain.length - dataOffset;
  if (bitsPerSample === 16) {
    const samples = dataLen / 2;
    // Find peak absolute sample
    let peak = 0;
    for (let i = 0; i < samples; i++) {
      const s = Math.abs(plain.readInt16LE(dataOffset + i * 2));
      if (s > peak) peak = s;
    }
    if (peak > 0) {
      // Target: -1 dBFS ≈ 0.891 × 32768 ≈ 29186
      const targetPeak = 29186;
      const gain = targetPeak / peak;
      if (gain > 1.01 || gain < 0.99) {
        const out = Buffer.from(plain);
        for (let i = 0; i < samples; i++) {
          const s = Math.round(plain.readInt16LE(dataOffset + i * 2) * gain);
          out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), dataOffset + i * 2);
        }
        res.set('Content-Type', 'audio/wav');
        res.set('X-Normalized', 'true');
        if (req.query.json === '1') return res.json({ media: serializeMedia(media), normalized: true });
        return res.send(out);
      }
    }
  }
  // 8-bit or already normalized
  res.set('Content-Type', media.mime || 'application/octet-stream');
  res.set('X-Normalized', 'false');
  if (req.query.json === '1') return res.json({ media: serializeMedia(media), normalized: false });
  res.send(plain);
});

// duplicate media into another chat so the target chat can access it
app.post('/api/media/:id/forward', (req, res) => {
  const selfId = (req as any).userId;
  const media = getMediaById(Number(req.params.id));
  const targetChatId = Number(req.body?.chatId);
  if (!media) return res.status(404).json({ error: 'Media not found' });
  const sourceChat = getChatForUser(media.chat_id, selfId);
  if (!sourceChat && media.sender_id !== selfId) return res.status(403).json({ error: 'Forbidden' });
  const targetChat = getChatForUser(targetChatId, selfId);
  if (!targetChat) return res.status(404).json({ error: 'Chat not found' });
  if (!media.body || !media.iv) return res.status(404).json({ error: 'Media empty' });
  const plain = decryptAtRest(Buffer.from(media.body as Uint8Array), Buffer.from(media.iv as Uint8Array));
  const enc = encryptAtRest(plain);
  const newMedia = insertMedia({
    chatId: targetChatId,
    senderId: selfId,
    kind: media.kind,
    name: media.name,
    mime: media.mime,
    size: media.size,
    body: enc.body,
    iv: enc.iv,
    duration: media.duration,
    width: media.width,
    height: media.height,
  });
  res.json({ media: serializeMedia(newMedia) });
});

// archive / unarchive a chat for the current user
app.patch('/api/chats/:id', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (typeof req.body?.archived === 'boolean') {
    setChatArchived(chatId, selfId, req.body.archived);
  }
  if (typeof req.body?.muted === 'boolean') {
    setChatMuted(chatId, selfId, req.body.muted);
  }
  if (typeof req.body?.pinned === 'boolean') {
    setChatPinned(chatId, selfId, req.body.pinned);
  }
  const fresh = getChatForUser(chatId, selfId);
  if (!fresh) return res.status(404).json({ error: 'Chat not found' });
  res.json({
    ok: true,
    archived: chatArchived(fresh, selfId),
    muted: isGroupChat(fresh) ? Boolean(getChatMember(chatId, selfId)?.muted) : false,
    pinned: chatPinned(fresh, selfId),
  });
});

registerSockets(io);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io') || req.path.startsWith('/media')) return next();
  res.sendFile(path.join(distPath, 'index.html'));
});

// --- sticker packs ---
app.get('/api/sticker-packs', (req, res) => {
  const packs = db.prepare('SELECT * FROM sticker_packs ORDER BY id').all();
  res.json(packs);
});

app.get('/api/sticker-packs/:id/stickers', (req, res) => {
  const packId = Number(req.params.id);
  const stickers = db.prepare('SELECT * FROM stickers WHERE pack_id = ? ORDER BY sort_order').all(packId);
  res.json(stickers);
});

app.post('/api/sticker-packs', (req, res) => {
  const selfId = (req as any).userId;
  const { name, emoji } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO sticker_packs (name, owner_id, emoji) VALUES (?, ?, ?)').run(name, selfId, emoji || null);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

app.post('/api/sticker-packs/:id/stickers', (req, res) => {
  const selfId = (req as any).userId;
  const packId = Number(req.params.id);
  const pack = db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(packId) as any;
  if (!pack) return res.status(404).json({ error: 'Pack not found' });
  if (pack.owner_id !== selfId) return res.status(403).json({ error: 'Only pack owner can add stickers' });
  const { emoji, media_id } = req.body ?? {};
  if (!emoji || !media_id) return res.status(400).json({ error: 'emoji and media_id required' });
  const sort = (db.prepare('SELECT MAX(sort_order) as m FROM stickers WHERE pack_id = ?').get(packId) as any)?.m ?? 0;
  db.prepare('INSERT INTO stickers (pack_id, file_id, emoji, sort_order) VALUES (?, ?, ?, ?)').run(packId, media_id, emoji, sort + 1);
  res.json({ ok: true });
});

app.post('/api/sticker-packs/:id/install', (req, res) => {
  const selfId = (req as any).userId;
  const packId = Number(req.params.id);
  const sort = (db.prepare('SELECT MAX(sort_order) as m FROM user_sticker_packs WHERE user_id = ?').get(selfId) as any)?.m ?? 0;
  db.prepare('INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id, sort_order) VALUES (?, ?, ?)').run(selfId, packId, sort + 1);
  res.json({ ok: true });
});

app.delete('/api/sticker-packs/:id/install', (req, res) => {
  const selfId = (req as any).userId;
  const packId = Number(req.params.id);
  db.prepare('DELETE FROM user_sticker_packs WHERE user_id = ? AND pack_id = ?').run(selfId, packId);
  res.json({ ok: true });
});

app.get('/api/me/sticker-packs', (req, res) => {
  const selfId = (req as any).userId;
  const packs = db
    .prepare('SELECT sp.* FROM sticker_packs sp JOIN user_sticker_packs usp ON usp.pack_id = sp.id WHERE usp.user_id = ? ORDER BY usp.sort_order')
    .all(selfId);
  res.json(packs);
});

// --- GIF search (uses Giphy/Tenor public API or fallback curated list) ---
const GIF_CATEGORIES: Record<string, Array<{ id: string; url: string; preview: string; width: number; height: number }>> = {};

app.get('/api/gifs/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  if (!q) {
    // Return trending/curated GIFs
    return res.json(getCuratedGifs(limit));
  }

  // Try Tenor API (free, no key needed for basic)
  try {
    const tenorRes = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=${config.tenorApiKey}&limit=${limit}&media_filter=gif,tinygif`);
    if (tenorRes.ok) {
      const data = (await tenorRes.json()) as { results?: Array<{ id: string; media_formats: Record<string, { url: string; dims?: number[] }> }> };
      const gifs = (data.results ?? []).map((r) => ({
        id: r.id,
        url: r.media_formats?.gif?.url ?? '',
        preview: r.media_formats?.tinygif?.url ?? '',
        width: r.media_formats?.gif?.dims?.[0] ?? 200,
        height: r.media_formats?.gif?.dims?.[1] ?? 200,
      })).filter((g) => g.url);
      if (gifs.length > 0) return res.json(gifs);
    }
  } catch { /* fallback */ }

  // Fallback: filter curated list by keyword
  const all = getCuratedGifs(200);
  const filtered = all.filter((g) => g.url.toLowerCase().includes(q) || (g as any).tags?.some?.((t: string) => t.includes(q)));
  res.json(filtered.slice(0, limit));
});

function getCuratedGifs(limit: number) {
  // Curated popular GIFs (placeholder URLs - in production would use a CDN)
  return [
    { id: 'g1', url: 'https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif', preview: 'https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif', width: 498, height: 280, tags: ['thumbs up', 'agree'] },
    { id: 'g2', url: 'https://media.giphy.com/media/l0HlNQ03J5JR3V2sE/giphy.gif', preview: 'https://media.giphy.com/media/l0HlNQ03J5JR3V2sE/giphy.gif', width: 498, height: 373, tags: ['heart', 'love'] },
    { id: 'g3', url: 'https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif', preview: 'https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif', width: 498, height: 278, tags: ['fire', 'hot'] },
    { id: 'g4', url: 'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif', preview: 'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif', width: 498, height: 406, tags: ['cat', 'animals'] },
    { id: 'g5', url: 'https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif', preview: 'https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif', width: 498, height: 278, tags: ['laugh', 'funny'] },
    { id: 'g6', url: 'https://media.giphy.com/media/l0HlvtIPzPdt2usKs/giphy.gif', preview: 'https://media.giphy.com/media/l0HlvtIPzPdt2usKs/giphy.gif', width: 498, height: 278, tags: ['dance', 'party'] },
    { id: 'g7', url: 'https://media.giphy.com/media/3o7TKDEGkX69Trbqzm/giphy.gif', preview: 'https://media.giphy.com/media/3o7TKDEGkX69Trbqzm/giphy.gif', width: 498, height: 280, tags: ['thumbs down', 'no'] },
    { id: 'g8', url: 'https://media.giphy.com/media/26BROrSHlmyzzHIfm/giphy.gif', preview: 'https://media.giphy.com/media/26BROrSHlmyzzHIfm/giphy.gif', width: 498, height: 280, tags: ['wave', 'hello'] },
  ].slice(0, limit);
}

// --- moderation: reports ---
app.post('/api/reports', (req, res) => {
  const selfId = (req as any).userId;
  const { target_type, target_id, reason, details } = req.body ?? {};
  if (!target_type || !target_id || !reason) return res.status(400).json({ error: 'target_type, target_id, reason required' });
  if (!['message', 'user', 'chat'].includes(target_type)) return res.status(400).json({ error: 'Invalid target_type' });
  db.prepare('INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES (?, ?, ?, ?, ?)').run(selfId, target_type, target_id, reason, details || null);
  res.json({ ok: true });
});

app.get('/api/admin/reports', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const status = String(req.query.status ?? 'pending');
  const reports = db.prepare(`
    SELECT r.*, u.username as reporter_username, u.first_name as reporter_name
    FROM reports r JOIN users u ON u.id = r.reporter_id
    WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 100
  `).all(status);
  res.json(reports);
});

app.patch('/api/admin/reports/:id', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const id = Number(req.params.id);
  const { status } = req.body ?? {};
  if (!['reviewed', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`UPDATE reports SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`).run(status, selfId, id);
  logAdminAction(selfId, 'review_report', 'report', id, `status: ${status}`);
  res.json({ ok: true });
});

// --- admin: users list / global ban ---
app.get('/api/admin/users', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const q = String(req.query.q ?? '').trim();
  let users;
  if (q) {
    users = db.prepare(`
      SELECT id, username, first_name, last_name, phone, is_admin, created_at
      FROM users WHERE username LIKE ? OR first_name LIKE ? OR phone LIKE ? ORDER BY id DESC LIMIT 50
    `).all(`%${q}%`, `%${q}%`, `%${q}%`);
  } else {
    users = db.prepare('SELECT id, username, first_name, last_name, phone, is_admin, created_at FROM users ORDER BY id DESC LIMIT 50').all();
  }
  res.json(users);
});

app.post('/api/admin/users/:id/ban', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const targetId = Number(req.params.id);
  if (targetId === selfId) return res.status(400).json({ error: 'Cannot ban yourself' });
  const reason = String(req.body?.reason ?? '');
  db.prepare('INSERT OR REPLACE INTO global_bans (user_id, reason, banned_by) VALUES (?, ?, ?)').run(targetId, reason || null, selfId);
  logAdminAction(selfId, 'global_ban', 'user', targetId, reason || undefined);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id/ban', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const targetId = Number(req.params.id);
  db.prepare('DELETE FROM global_bans WHERE user_id = ?').run(targetId);
  logAdminAction(selfId, 'global_unban', 'user', targetId);
  res.json({ ok: true });
});

app.get('/api/admin/bans', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const bans = db.prepare(`
    SELECT gb.*, u.username, u.first_name, u.last_name
    FROM global_bans gb JOIN users u ON u.id = gb.user_id ORDER BY gb.created_at DESC LIMIT 100
  `).all();
  res.json(bans);
});

app.post('/api/admin/users/:id/delete-messages', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const targetId = Number(req.params.id);
  db.prepare('UPDATE messages SET deleted = 1, body = NULL, iv = NULL WHERE sender_id = ?').run(targetId);
  logAdminAction(selfId, 'delete_messages', 'user', targetId);
  res.json({ ok: true });
});

// ======================== EDIT HISTORY ========================

app.get('/api/messages/:id/history', (req, res) => {
  const selfId = (req as any).userId;
  const messageId = Number(req.params.id);
  if (!messageId) return res.status(400).json({ error: 'Invalid message id' });
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as any;
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (!getChatForUser(msg.chat_id, selfId)) return res.status(404).json({ error: 'Chat not found' });
  const history = db.prepare(`
    SELECT eh.*, u.username, u.first_name, u.last_name
    FROM edit_history eh JOIN users u ON u.id = eh.user_id
    WHERE eh.message_id = ? ORDER BY eh.edited_at DESC
  `).all(messageId) as any[];
  res.json(history.map((h) => {
    let text = '';
    if (h.old_body && h.old_iv) {
      try {
        text = decryptAtRest(Buffer.from(h.old_body), Buffer.from(h.old_iv)).toString('utf8');
      } catch { text = '[decryption failed]'; }
    }
    return {
      id: h.id,
      user: { id: h.user_id, username: h.username, first_name: h.first_name, last_name: h.last_name },
      text,
      edited_at: h.edited_at,
    };
  }));
});

// ======================== CUSTOM REACTIONS (REST) ========================

interface TopicDTO {
  id: number;
  chat_id: number;
  title: string;
  created_by: { id: number; username?: string; first_name?: string; last_name?: string; photo?: string | null } | null;
  created_at: string;
}

function broadcastMessageReactions(chatId: number, messageId: number, chat: any) {
  const viewerIds = isGroupChat(chat)
    ? listChatMembers(chatId).map((m: any) => m.user_id)
    : [chat.user_a_id, chat.user_b_id].filter((id): id is number => id !== null);
  for (const viewerId of viewerIds) {
    io.to(`user:${viewerId}`).emit('message:reaction', {
      chatId,
      messageId,
      reactions: reactionGroups(messageId, viewerId),
    });
  }
}

function canReactToMessage(messageId: number, selfId: number): { chatId: number } | null {
  const msg = db.prepare('SELECT id, chat_id FROM messages WHERE id = ? AND deleted = 0').get(messageId) as { id: number; chat_id: number } | undefined;
  if (!msg) return null;
  const chat = getChatForUser(msg.chat_id, selfId);
  if (!chat) return null;
  return { chatId: msg.chat_id };
}

app.get('/api/messages/:id/reactions', (req, res) => {
  const selfId = (req as any).userId;
  const messageId = Number(req.params.id);
  if (!messageId) return res.status(400).json({ error: 'Invalid message id' });
  if (!canReactToMessage(messageId, selfId)) return res.status(404).json({ error: 'Message not found' });
  res.json(reactionGroups(messageId, selfId));
});

app.post('/api/messages/:id/reactions', (req, res) => {
  const selfId = (req as any).userId;
  const messageId = Number(req.params.id);
  const emoji = String(req.body?.emoji ?? '').trim();
  if (!messageId) return res.status(400).json({ error: 'Invalid message id' });
  if (!emoji || [...emoji].length > 8) return res.status(400).json({ error: 'Invalid emoji' });
  const target = canReactToMessage(messageId, selfId);
  if (!target) return res.status(404).json({ error: 'Message not found' });
  try {
    db.prepare('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(messageId, selfId, emoji);
  } catch {
    return res.status(500).json({ error: 'Could not save reaction' });
  }
  broadcastMessageReactions(target.chatId, messageId, getChatById(target.chatId));
  res.json({ ok: true, reactions: reactionGroups(messageId, selfId) });
});

app.delete('/api/messages/:id/reactions/:emoji', (req, res) => {
  const selfId = (req as any).userId;
  const messageId = Number(req.params.id);
  const emoji = String(req.params.emoji ?? '').trim();
  if (!messageId || !emoji) return res.status(400).json({ error: 'Invalid request' });
  const target = canReactToMessage(messageId, selfId);
  if (!target) return res.status(404).json({ error: 'Message not found' });
  db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(messageId, selfId, emoji);
  broadcastMessageReactions(target.chatId, messageId, getChatById(target.chatId));
  res.json({ ok: true, reactions: reactionGroups(messageId, selfId) });
});

// ======================== FORUM TOPICS ========================

function topicDTO(row: any): TopicDTO {
  let creator: { id: number; username?: string; first_name?: string; last_name?: string; photo?: string | null } | null = null;
  if (row.created_by) {
    const u = getUserById(row.created_by);
    if (u) creator = publicUser(u);
  }
  return {
    id: row.id,
    chat_id: row.chat_id,
    title: row.title,
    created_by: creator,
    created_at: row.created_at,
  };
}

app.patch('/api/groups/:id/forum', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const enabled = Boolean(req.body?.enabled);
  db.prepare('UPDATE chats SET is_forum = ? WHERE id = ?').run(enabled ? 1 : 0, chatId);
  broadcastGroupInfo(chatId);
  res.json({ ok: true, is_forum: enabled });
});

app.get('/api/chats/:id/topics', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  if (!getChatForUser(chatId, selfId)) return res.status(404).json({ error: 'Chat not found' });
  const rows = db
    .prepare('SELECT * FROM forum_topics WHERE chat_id = ? ORDER BY id')
    .all(chatId);
  res.json(rows.map(topicDTO));
});

app.post('/api/chats/:id/topics', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatForUser(chatId, selfId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  const title = String(req.body?.title ?? '').trim();
  if (!title || title.length > 128) return res.status(400).json({ error: 'Title must be 1-128 characters' });
  const info = db.prepare('INSERT INTO forum_topics (chat_id, title, created_by) VALUES (?, ?, ?)').run(chatId, title, selfId);
  const topic = db.prepare('SELECT * FROM forum_topics WHERE id = ?').get(Number(info.lastInsertRowid));
  // Creating a topic implicitly turns the group into a forum
  db.prepare('UPDATE chats SET is_forum = 1 WHERE id = ?').run(chatId);
  broadcastGroupInfo(chatId);
  io.to(`chat:${chatId}`).emit('forum:topics', { chatId });
  res.json(topicDTO(topic));
});

app.delete('/api/chats/:id/topics/:topicId', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const topicId = Number(req.params.topicId);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  const role = chatMemberRole(chatId, selfId);
  const topic = db.prepare('SELECT * FROM forum_topics WHERE id = ? AND chat_id = ?').get(topicId, chatId) as any;
  if (!topic) return res.status(404).json({ error: 'Topic not found' });
  const isCreator = topic.created_by === selfId;
  if (!isCreator && role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
  db.prepare('UPDATE messages SET topic_id = NULL WHERE topic_id = ?').run(topicId);
  db.prepare('DELETE FROM forum_topics WHERE id = ?').run(topicId);
  io.to(`chat:${chatId}`).emit('forum:topics', { chatId });
  res.json({ ok: true });
});

// ======================== ADMIN LOG ========================

app.get('/api/admin/log', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const before = req.query.before ? Number(req.query.before) : null;
  let sql = 'SELECT al.*, u.username, u.first_name, u.last_name FROM admin_log al JOIN users u ON u.id = al.admin_id';
  const params: any[] = [];
  if (before) { sql += ' WHERE al.id < ?'; params.push(before); }
  sql += ' ORDER BY al.id DESC LIMIT ?';
  params.push(limit + 1);
  const rows = db.prepare(sql).all(...params) as any[];
  const hasMore = rows.length > limit;
  res.json({ results: hasMore ? rows.slice(0, limit) : rows, hasMore });
});

// ======================== JOIN REQUESTS ========================

app.post('/api/chats/:id/join-request', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  if (isChatMember(chatId, selfId)) return res.status(400).json({ error: 'Already a member' });
  const banned = db.prepare('SELECT 1 FROM group_bans WHERE chat_id = ? AND user_id = ?').get(chatId, selfId);
  if (banned) return res.status(403).json({ error: 'You are banned from this group' });
  try {
    db.prepare('INSERT INTO join_requests (chat_id, user_id) VALUES (?, ?)').run(chatId, selfId);
    io.to(`chat:${chatId}`).emit('group:updated', { chatId });
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Join request already pending' });
  }
});

app.get('/api/chats/:id/join-requests', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const requests = db.prepare(`
    SELECT jr.*, u.username, u.first_name, u.last_name, u.photo
    FROM join_requests jr JOIN users u ON u.id = jr.user_id
    WHERE jr.chat_id = ? AND jr.status = 'pending' ORDER BY jr.created_at DESC
  `).all(chatId);
  res.json(requests);
});

app.post('/api/chats/:id/join-requests/:requestId', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const requestId = Number(req.params.requestId);
  const action = String(req.body?.action ?? '');
  if (action !== 'approve' && action !== 'reject') return res.status(400).json({ error: 'action must be approve or reject' });
  const role = chatMemberRole(chatId, selfId);
  if (role !== 'owner' && role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const request = db.prepare('SELECT * FROM join_requests WHERE id = ? AND chat_id = ? AND status = ?').get(requestId, chatId, 'pending') as any;
  if (!request) return res.status(404).json({ error: 'Request not found' });
  db.prepare("UPDATE join_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(action === 'approve' ? 'approved' : 'rejected', selfId, requestId);
  if (action === 'approve') {
    addChatMember(chatId, request.user_id, 'member');
    io.in(`user:${request.user_id}`).socketsJoin(roomName(chatId));
    io.to(`user:${request.user_id}`).emit('group:added', groupChatInfo(chatId, request.user_id));
    broadcastGroupInfo(chatId);
  }
  logAdminAction(selfId, action === 'approve' ? 'approve_join' : 'reject_join', 'user', request.user_id, `chat: ${chatId}`);
  res.json({ ok: true });
});

// ======================== DELETE GROUP ========================

app.delete('/api/groups/:id', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  if (chatMemberRole(chatId, selfId) !== 'owner') return res.status(403).json({ error: 'Only the owner can delete this group' });
  // Soft delete: archive the group so the owner can restore it later
  db.prepare('UPDATE chats SET is_deleted = 1 WHERE id = ?').run(chatId);
  for (const m of listChatMembers(chatId)) {
    io.in(`user:${m.user_id}`).socketsLeave(roomName(chatId));
    if (m.user_id !== selfId) io.to(`user:${m.user_id}`).emit('chat:removed', { chatId });
  }
  io.to(`chat:${chatId}`).emit('chat:removed', { chatId });
  logAdminAction(selfId, 'delete_group', 'chat', chatId);
  res.json({ ok: true });
});

// ======================== RESTORE GROUP ========================

app.post('/api/groups/:id/restore', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = db.prepare("SELECT * FROM chats WHERE id = ? AND kind = 'group' AND is_deleted = 1").get(chatId) as any;
  if (!chat) return res.status(404).json({ error: 'Deleted group not found' });
  if (chatMemberRole(chatId, selfId) !== 'owner') return res.status(403).json({ error: 'Only the owner can restore this group' });
  db.prepare('UPDATE chats SET is_deleted = 0 WHERE id = ?').run(chatId);
  for (const m of listChatMembers(chatId)) {
    io.in(`user:${m.user_id}`).socketsJoin(roomName(chatId));
    io.to(`user:${m.user_id}`).emit('group:added', groupChatInfo(chatId, m.user_id));
  }
  broadcastGroupInfo(chatId);
  logAdminAction(selfId, 'restore_group', 'chat', chatId);
  res.json(groupChatInfo(chatId, selfId));
});

// ======================== TRANSFER OWNERSHIP ========================

app.post('/api/groups/:id/transfer', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const targetId = Number(req.body?.userId);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  if (chatMemberRole(chatId, selfId) !== 'owner') return res.status(403).json({ error: 'Only the owner can transfer ownership' });
  if (!Number.isInteger(targetId) || targetId <= 0 || targetId === selfId || !isChatMember(chatId, targetId)) {
    return res.status(400).json({ error: 'Invalid target user' });
  }
  db.prepare('UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ?').run('admin', chatId, selfId);
  db.prepare('UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ?').run('owner', chatId, targetId);
  logAdminAction(selfId, 'transfer_ownership', 'chat', chatId, `to user ${targetId}`);
  const info = groupChatInfo(chatId, selfId);
  broadcastGroupInfo(chatId);
  res.json(info);
});

// ======================== MEMBER LIMIT ========================

app.patch('/api/groups/:id/max-members', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const chat = getChatById(chatId);
  if (!chat || !isGroupChat(chat)) return res.status(404).json({ error: 'Chat not found' });
  if (chatMemberRole(chatId, selfId) !== 'owner') return res.status(403).json({ error: 'Only the owner can set member limits' });
  const maxMembers = Math.min(Math.max(Number(req.body?.max_members) || 200000, 1), 200000);
  db.prepare('UPDATE chats SET max_members = ? WHERE id = ?').run(maxMembers, chatId);
  broadcastGroupInfo(chatId);
  res.json({ ok: true, max_members: maxMembers });
});

// ======================== DELIVERY STATUS ========================

app.post('/api/chats/:id/delivered', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.id);
  const messageId = Number(req.body?.messageId);
  if (!messageId) return res.status(400).json({ error: 'messageId required' });
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const msg = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ?').get(messageId, chatId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  db.prepare("UPDATE messages SET delivered_at = datetime('now'), delivery_status = 'delivered' WHERE id = ? AND delivered_at IS NULL").run(messageId);
  io.to(`chat:${chatId}`).emit('message:delivered', { chatId, messageId, delivered_at: new Date().toISOString() });
  res.json({ ok: true });
});

// ======================== UNDO DELETE ========================

app.post('/api/chats/:chatId/messages/:messageId/undelete', (req, res) => {
  const selfId = (req as any).userId;
  const chatId = Number(req.params.chatId);
  const messageId = Number(req.params.messageId);
  const chat = getChatForUser(chatId, selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const msg = db.prepare('SELECT id, deleted_for, sender_id FROM messages WHERE id = ? AND chat_id = ?').get(messageId, chatId) as { id: number; deleted_for: string; sender_id: number } | undefined;
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.sender_id !== selfId) return res.status(403).json({ error: 'Can only undelete own messages' });
  let deletedFor: number[] = [];
  try { deletedFor = JSON.parse(msg.deleted_for || '[]'); } catch { deletedFor = []; }
  const idx = deletedFor.indexOf(selfId);
  if (idx === -1) return res.status(400).json({ error: 'Message not deleted for you' });
  deletedFor.splice(idx, 1);
  db.prepare('UPDATE messages SET deleted_for = ? WHERE id = ?').run(JSON.stringify(deletedFor), messageId);
  res.json({ ok: true });
});

// ======================== LINK BLACKLIST ========================

app.get('/api/admin/blacklist', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const patterns = db.prepare('SELECT * FROM link_blacklist ORDER BY id DESC').all();
  res.json(patterns);
});

app.post('/api/admin/blacklist', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const pattern = String(req.body?.pattern ?? '').trim().toLowerCase();
  if (!pattern) return res.status(400).json({ error: 'pattern required' });
  try {
    db.prepare('INSERT INTO link_blacklist (pattern, reason, created_by) VALUES (?, ?, ?)').run(pattern, req.body?.reason || null, selfId);
    logAdminAction(selfId, 'add_blacklist', 'link_blacklist', null, pattern);
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Pattern already exists' });
  }
});

app.delete('/api/admin/blacklist/:id', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const id = Number(req.params.id);
  db.prepare('DELETE FROM link_blacklist WHERE id = ?').run(id);
  logAdminAction(selfId, 'remove_blacklist', 'link_blacklist', id);
  res.json({ ok: true });
});

// ======================== SHADOW BANS ========================

app.get('/api/admin/shadow-bans', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const bans = db.prepare(`
    SELECT sb.*, u.username, u.first_name, u.last_name
    FROM shadow_bans sb JOIN users u ON u.id = sb.user_id ORDER BY sb.created_at DESC
  `).all();
  res.json(bans);
});

app.post('/api/admin/shadow-ban/:userId', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const targetId = Number(req.params.userId);
  if (!targetId || targetId === selfId) return res.status(400).json({ error: 'Invalid user' });
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 200) : null;
  db.prepare('INSERT OR REPLACE INTO shadow_bans (user_id, banned_by, reason) VALUES (?, ?, ?)').run(targetId, selfId, reason);
  logAdminAction(selfId, 'shadow_ban', 'user', targetId, reason || undefined);
  res.json({ ok: true });
});

app.delete('/api/admin/shadow-ban/:userId', (req, res) => {
  const selfId = (req as any).userId;
  if (!isAdmin(selfId)) return res.status(403).json({ error: 'Admin only' });
  const targetId = Number(req.params.userId);
  db.prepare('DELETE FROM shadow_bans WHERE user_id = ?').run(targetId);
  logAdminAction(selfId, 'shadow_unban', 'user', targetId);
  res.json({ ok: true });
});

// ======================== CALL HISTORY ========================

app.get('/api/calls', (req, res) => {
  const selfId = (req as any).userId;
  const calls = db.prepare(`
    SELECT ch.*, c.title as chat_title
    FROM call_history ch LEFT JOIN chats c ON c.id = ch.chat_id
    WHERE ch.caller_id = ?
    ORDER BY ch.started_at DESC LIMIT 100
  `).all(selfId);
  res.json(calls);
});

app.post('/api/calls', (req, res) => {
  const selfId = (req as any).userId;
  const { chatId, callType } = req.body ?? {};
  if (!chatId || !['audio', 'video'].includes(callType)) return res.status(400).json({ error: 'chatId and callType (audio|video) required' });
  const chat = getChatForUser(Number(chatId), selfId);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const result = db.prepare("INSERT INTO call_history (chat_id, caller_id, call_type, status) VALUES (?, ?, ?, 'outgoing')").run(Number(chatId), selfId, callType);
  res.json({ ok: true, id: Number(result.lastInsertRowid) });
});

app.patch('/api/calls/:id', (req, res) => {
  const selfId = (req as any).userId;
  const callId = Number(req.params.id);
  const call = db.prepare('SELECT * FROM call_history WHERE id = ?').get(callId) as any;
  if (!call) return res.status(404).json({ error: 'Call not found' });
  const { status, duration } = req.body ?? {};
  if (status && ['missed', 'outgoing', 'incoming', 'completed'].includes(status)) {
    db.prepare('UPDATE call_history SET status = ?, ended_at = datetime(\'now\') WHERE id = ?').run(status, callId);
  }
  if (typeof duration === 'number') {
    db.prepare('UPDATE call_history SET duration = ? WHERE id = ?').run(duration, callId);
  }
  res.json({ ok: true });
});

// ======================== BOTS / WEBHOOKS ========================

function sanitizeWebhookUrl(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\/[^\s]+$/i.test(s) || s.length > 500) return '';
  if (!isSafeUrl(s)) return '';
  return s;
}

app.post('/api/bots', (req, res) => {
  const selfId = (req as any).userId;
  const name = String(req.body?.name ?? '').trim().slice(0, 64);
  const description = String(req.body?.description ?? '').trim().slice(0, 300);
  const webhookUrl = sanitizeWebhookUrl(req.body?.webhook_url);
  if (!name) return res.status(400).json({ error: 'Name required' });
  const token = randomToken(32);
  // Provision an underlying user account so the bot can be added to chats as a member
  let base = name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
  if (base.length < 5) base = (base + 'bot_').slice(0, 5);
  let username = base;
  while (getUserByUsername(username)) {
    username = `${base}_${Math.random().toString(36).slice(2, 7)}`;
  }
  const userRes = db.prepare('INSERT INTO users (phone, username, first_name, last_name, bio) VALUES (?, ?, ?, ?, ?)')
    .run(`bot:${token}`, username, name, '', description);
  const botUserId = Number(userRes.lastInsertRowid);
  try {
    const r = db.prepare('INSERT INTO bots (user_id, token, name, description, webhook_url, owner_id) VALUES (?, ?, ?, ?, ?, ?)').run(botUserId, token, name, description, webhookUrl, selfId);
    log.suspicious('bot_created', { userId: selfId, botId: Number(r.lastInsertRowid), botUserId });
    res.json({
      ok: true,
      id: Number(r.lastInsertRowid),
      token,
      bot_user_id: botUserId,
      username,
      name,
      description,
      webhook_url: webhookUrl,
    });
  } catch (e) {
    db.prepare('DELETE FROM users WHERE id = ?').run(botUserId);
    throw e;
  }
});

app.get('/api/bots', (req, res) => {
  const selfId = (req as any).userId;
  const rows = db.prepare(`
    SELECT b.id, b.name, b.description, b.webhook_url, b.is_active, b.created_at,
           b.user_id as bot_user_id, u.username
    FROM bots b JOIN users u ON u.id = b.user_id
    WHERE b.owner_id = ?
    ORDER BY b.id DESC
  `).all(selfId);
  res.json(rows);
});

app.delete('/api/bots/:id', (req, res) => {
  const selfId = (req as any).userId;
  const botId = Number(req.params.id);
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(botId, selfId) as any;
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  db.prepare('DELETE FROM chat_members WHERE user_id = ?').run(bot.user_id);
  db.prepare('DELETE FROM bots WHERE id = ?').run(botId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(bot.user_id);
  db.prepare('DELETE FROM users WHERE id = ?').run(bot.user_id);
  log.suspicious('bot_deleted', { userId: selfId, botId });
  res.json({ ok: true });
});

app.post('/api/bots/:id/set-webhook', (req, res) => {
  const selfId = (req as any).userId;
  const botId = Number(req.params.id);
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND owner_id = ?').get(botId, selfId) as any;
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const rawUrl = req.body?.webhook_url;
  if (rawUrl !== undefined && rawUrl !== null && rawUrl !== '') {
    if (!sanitizeWebhookUrl(rawUrl)) return res.status(400).json({ error: 'Invalid webhook URL' });
  }
  const url = rawUrl === undefined || rawUrl === null || rawUrl === '' ? '' : sanitizeWebhookUrl(rawUrl);
  db.prepare('UPDATE bots SET webhook_url = ? WHERE id = ?').run(url, botId);
  res.json({ ok: true, webhook_url: url });
});

// ======================== GRACEFUL SHUTDOWN ========================

function gracefulShutdown(signal: string) {
  log.info(`received ${signal}, shutting down gracefully...`);
  log.suspicious('server_shutdown', { signal });
  httpServer.close(() => {
    log.info('HTTP server closed');
    try {
      db.close();
      log.info('database closed');
    } catch {
      // ignore
    }
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => {
    log.error('forced shutdown after timeout');
    process.exit(1);
  }, 5_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ======================== START ========================

httpServer.listen(config.port, () => {
  log.info(`listening on http://localhost:${config.port}`);
  log.suspicious('server_start', { port: config.port, production: config.isProduction });
});

// --- Folder Filters ---
app.get('/api/folder-filters', (req, res) => {
  const selfId = (req as any).userId;
  const row = db.prepare('SELECT folder_filters FROM users WHERE id = ?').get(selfId) as { folder_filters?: string } | undefined;
  let filters: Record<string, string[]> = {};
  try { filters = JSON.parse(row?.folder_filters ?? '{}'); } catch { filters = {}; }
  res.json(filters);
});

app.put('/api/folder-filters', (req, res) => {
  const selfId = (req as any).userId;
  const filters = req.body ?? {};
  db.prepare('UPDATE users SET folder_filters = ? WHERE id = ?').run(JSON.stringify(filters), selfId);
  res.json({ ok: true });
});

// --- SSRF-safe URL validation ---
import { isIPv4 } from 'node:net';
function isPrivateOrReservedIP(hostname: string): boolean {
  const ip = hostname.toLowerCase();
  if (!isIPv4(ip)) return false;
  const parts = ip.split('.').map(Number);
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 0) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] >= 224 && parts[0] <= 239) return true;
  return false;
}

function isSafeUrl(raw: string): boolean {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const h = parsed.hostname.toLowerCase();
  if (isPrivateOrReservedIP(h)) return false;
  // Block hostname tricks that resolve to localhost
  const blocked = ['localhost', '0.0.0.0', '127.0.0.1', '::1', 'metadata.google.internal', '169.254.169.254'];
  if (blocked.includes(h)) return false;
  // Block numeric IP ranges that could be confused with hostname
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return isPrivateOrReservedIP(h);
  return true;
}

// --- Link Preview ---
app.get('/api/link-preview', async (req, res) => {
  const url = String(req.query.url ?? '').trim();
  if (!url || !isSafeUrl(url)) return res.json(null);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MessengerBot/1.0)' } });
    clearTimeout(timeout);
    // Reject non-HTML responses and redirects to private IPs
    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.includes('text/html')) return res.json(null);
    if (resp.redirected) {
      try { const rUrl = new URL(resp.url); if (!isSafeUrl(rUrl.href)) return res.json(null); } catch { return res.json(null); }
    }
    const html = await resp.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
    const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    res.json({
      url,
      title: titleMatch?.[1]?.trim()?.slice(0, 200) ?? null,
      description: descMatch?.[1]?.trim()?.slice(0, 500) ?? null,
      image: ogImageMatch?.[1]?.trim() ?? null,
    });
  } catch {
    res.json(null);
  }
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found' }));

app.use(((error, _req, res, _next) => {
  log.error('unhandled request error', { error: String(error), stack: error.stack });
  if (error instanceof multer.MulterError) {
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.message });
  }
  return res.status(500).json({ error: t_server('server_error') });
}) as express.ErrorRequestHandler);

// --- scheduled message sender (check every 15s) ---
setInterval(() => {
  try {
    const pending = db.prepare(`SELECT * FROM scheduled_messages WHERE sent = 0 AND scheduled_at <= datetime('now')`).all() as any[];
    for (const sm of pending) {
      try {
        db.prepare('UPDATE scheduled_messages SET sent = 1 WHERE id = ?').run(sm.id);
        const enc = encryptAtRest(sm.body ?? '');
        db.prepare('INSERT INTO messages (chat_id, sender_id, body, iv, media_id, reply_to) VALUES (?, ?, ?, ?, ?, ?)').run(sm.chat_id, sm.user_id, enc.body, enc.iv, sm.media_id, sm.reply_to);
        const row = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1').get(sm.chat_id) as any;
        if (row) {
          io.to(`chat:${sm.chat_id}`).emit('message:new', { chatId: sm.chat_id, messageId: row.id });
          try { db.prepare("UPDATE chats SET last_message_at = datetime('now') WHERE id = ?").run(sm.chat_id); } catch { /* ignore */ }
        }
        log.suspicious('scheduled_message_sent', { userId: sm.user_id, chatId: sm.chat_id, smId: sm.id });
      } catch (e) {
        log.error('failed to send scheduled message', { smId: sm.id, error: String(e) });
      }
    }
  } catch { /* ignore */ }
}, 15_000);

// ======================== DATA RETENTION ========================
setInterval(() => {
  try {
    const retentionDays = config.dataRetentionDays;
    if (retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    // Delete old messages and their media
    const mediaIds = db.prepare('SELECT id, storage_key FROM messages WHERE created_at < ? AND media_id IS NOT NULL').all(cutoff) as { id: number; storage_key?: string }[];
    const mediaRows = db.prepare('SELECT id, storage_key FROM media WHERE id IN (SELECT media_id FROM messages WHERE created_at < ?)').all(cutoff) as { id: number; storage_key?: string }[];
    const msgResult = db.prepare(`DELETE FROM messages WHERE created_at < ?`).run(cutoff);
    // Delete storage blobs for purged media
    for (const m of mediaRows) {
      if (m.storage_key) deleteFile(m.storage_key).catch(() => {});
    }
    if (mediaIds.length > 0) {
      try { db.prepare(`DELETE FROM media WHERE id IN (${mediaIds.map(() => '?').join(',')})`).run(...mediaIds.map((m) => m.id)); } catch { /* ignore */ }
    }
    // Purge old auth codes and phone_change_codes
    db.prepare("DELETE FROM auth_codes WHERE expires_at < datetime('now', '-1 day')").run();
    db.prepare("DELETE FROM phone_change_codes WHERE expires_at < datetime('now', '-1 day')").run();
    // Purge old suspicious events (keep 30 days)
    db.prepare("DELETE FROM suspicious_events WHERE created_at < datetime('now', '-30 days')").run();
    // Purge old admin log (keep 90 days)
    try { db.prepare("DELETE FROM admin_log WHERE created_at < datetime('now', '-90 days')").run(); } catch { /* ignore */ }
    // Purge old signed prekeys (keep 30 days) — clients rotate weekly
    try { db.prepare("DELETE FROM e2e_signed_prekeys WHERE created_at < datetime('now', '-30 days')").run(); } catch { /* ignore */ }
    // Purge consumed one-time prekeys
    try { db.prepare('DELETE FROM e2e_one_time_prekeys WHERE consumed = 1').run(); } catch { /* ignore */ }
    // Auto-archive chats inactive for >30 days (direct chats only)
    try {
      const staleChats = db.prepare(`
        SELECT id, user_a_id, user_b_id FROM chats
        WHERE kind = 'regular' AND last_message_at IS NOT NULL
        AND last_message_at < datetime('now', '-30 days')
        AND archived_a = 0 AND archived_b = 0
      `).all() as { id: number; user_a_id: number; user_b_id: number }[];
      for (const ch of staleChats) {
        if (ch.user_b_id) {
          db.prepare('UPDATE chats SET archived_a = 1 WHERE id = ? AND archived_a = 0').run(ch.id);
          db.prepare('UPDATE chats SET archived_b = 1 WHERE id = ? AND archived_b = 0').run(ch.id);
        }
      }
      if (staleChats.length > 0) log.info(`auto_archive: archived ${staleChats.length} inactive chats`);
    } catch { /* ignore */ }
    if (msgResult.changes > 0) {
      log.info(`data_retention: purged ${msgResult.changes} old messages`);
    }
  } catch (e) {
    log.error('data_retention_error', { error: String(e) });
  }
}, 3_600_000); // Run every hour

// --- Admin: data retention ---
app.get('/api/admin/data-retention', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  const retentionDays = config.dataRetentionDays;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const oldMessages = (db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE created_at < ?').get(cutoff) as { cnt: number }).cnt;
  res.json({ retentionDays, cutoff, oldMessages });
});

app.post('/api/admin/data-retention/purge', (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  const retentionDays = config.dataRetentionDays;
  if (retentionDays <= 0) return res.status(400).json({ error: 'Retention disabled' });
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const mediaIds = db.prepare('SELECT id FROM messages WHERE created_at < ? AND media_id IS NOT NULL').all(cutoff) as { id: number }[];
  const result = db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
  if (mediaIds.length > 0) {
    try { db.prepare(`DELETE FROM media WHERE id IN (${mediaIds.map(() => '?').join(',')})`).run(...mediaIds.map((m) => m.id)); } catch { /* ignore */ }
  }
  log.suspicious('admin_purge_data', { adminId: selfId, deleted: result.changes });
  res.json({ ok: true, deleted: result.changes });
});

// ======================== BACKUP ========================
app.post('/api/admin/backup', async (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  try {
    const fs = await import('node:fs/promises');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `data/backups/messenger-${timestamp}.db`;
    await fs.mkdir('data/backups', { recursive: true });
    // SQLite backup via VACUUM INTO
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    const stat = await fs.stat(backupPath);
    log.suspicious('admin_backup', { adminId: selfId, path: backupPath, size: stat.size });
    res.json({ ok: true, path: backupPath, size: stat.size });
  } catch (e) {
    res.status(500).json({ error: 'Backup failed: ' + String(e) });
  }
});

// --- backup restore ---
app.post('/api/admin/restore', async (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  const backupName = String(req.body?.name ?? '');
  if (!backupName || !/^[a-zA-Z0-9._-]+\.db$/.test(backupName)) {
    return res.status(400).json({ error: 'Invalid backup name' });
  }
  try {
    const fs = await import('node:fs/promises');
    const backupPath = `data/backups/${backupName}`;
    const targetPath = String(config.dbPath ?? 'data/messenger.db');
    // Verify backup file exists and is a valid SQLite DB
    const stat = await fs.stat(backupPath).catch(() => null);
    if (!stat || !stat.isFile()) return res.status(404).json({ error: 'Backup not found' });
    // Copy current DB as safety backup
    const safetyPath = `data/backups/pre-restore-${Date.now()}.db`;
    await fs.copyFile(targetPath, safetyPath);
    // Replace DB
    await fs.copyFile(backupPath, targetPath);
    log.suspicious('admin_restore', { adminId: selfId, backup: backupName, safety: safetyPath });
    res.json({ ok: true, restored: backupName, safetyBackup: safetyPath });
  } catch (e) {
    res.status(500).json({ error: 'Restore failed: ' + String(e) });
  }
});

app.get('/api/admin/backups', async (req, res) => {
  const selfId = (req as any).userId;
  const user = getUserById(selfId);
  if (!user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  try {
    const fs = await import('node:fs/promises');
    const dir = 'data/backups';
    try {
      const files = await fs.readdir(dir);
      const backups = await Promise.all(
        files.filter((f) => f.endsWith('.db')).map(async (f) => {
          const stat = await fs.stat(`${dir}/${f}`);
          return { name: f, size: stat.size, createdAt: stat.mtime.toISOString() };
        }),
      );
      backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.json({ backups: backups.slice(0, 20) });
    } catch {
      res.json({ backups: [] });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
