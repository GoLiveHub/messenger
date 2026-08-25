import { Router, type NextFunction, type Request, type Response } from 'express';
import { db } from './db.js';
import {
  generateCode,
  hashPassword,
  randomToken,
  sha256Hex,
  verifyPassword,
} from './crypto.js';
import {
  createSession,
  deleteAllSessions,
  deleteSession,
  getUserById,
  getUserByPhone,
  getUserByUsername,
  publicUser,
} from './helpers.js';
import { config } from './config.js';
import { validatePhone } from './phone.js';
import { getSmsProvider } from './lib/sms.js';
import { createRateLimiter, type RateLimiter } from './lib/rateLimit.js';
import { verifyTotp } from './lib/totp.js';

export const authRouter = Router();

const CODE_COOLDOWN_MS = 30_000; // min interval between codes per phone
const CODE_WINDOW_MS = 60 * 60 * 1000;
const MAX_CODE_SENDS = 5;
const MAX_CODE_VERIFY_ATTEMPTS = 5;

// --- Rate limiting (Redis-backed with in-memory fallback) ---
let authLimiter: RateLimiter | null = null;
let signupLimiter: RateLimiter | null = null;
let phoneCodeLimiter: RateLimiter | null = null;

async function getAuthLimiter(): Promise<RateLimiter> {
  if (!authLimiter) authLimiter = await createRateLimiter({ windowMs: 60_000, max: 30 });
  return authLimiter;
}

async function getSignupLimiter(): Promise<RateLimiter> {
  if (!signupLimiter) signupLimiter = await createRateLimiter({ windowMs: 3_600_000, max: 10 });
  return signupLimiter;
}

async function getPhoneCodeLimiter(): Promise<RateLimiter> {
  if (!phoneCodeLimiter) phoneCodeLimiter = await createRateLimiter({ windowMs: 300_000, max: 5 });
  return phoneCodeLimiter;
}

async function sensitiveEndpointLimit(req: Request, res: Response, next: NextFunction) {
  const key = `auth:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
  const limiter = await getAuthLimiter();
  const result = await limiter.allow(key);
  if (!result.allowed) {
    logSuspicious('rate_limit_auth', { ip: key });
    res.set('Retry-After', '60');
    return res.status(429).json({ error: 'Too many authentication attempts. Try again shortly.' });
  }
  next();
}

// Mass-registration protection: limit sign-ups per IP prefix
async function massRegistrationLimit(req: Request, res: Response, next: NextFunction) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  let ipPrefix: string;
  if (ip.includes(':')) {
    // IPv6: group by /64 prefix (first 8 hex groups)
    const groups = ip.split(':');
    ipPrefix = groups.slice(0, 8).join(':');
  } else if (ip.includes('.')) {
    // IPv4: group by /24 (first 3 octets)
    const parts = ip.split('.');
    ipPrefix = parts.length === 4 ? parts.slice(0, 3).join('.') : ip;
  } else {
    ipPrefix = ip;
  }
  const limiter = await getSignupLimiter();
  const result = await limiter.allow(`signup:${ipPrefix}`);
  if (!result.allowed) {
    logSuspicious('mass_registration', { ipPrefix });
    res.set('Retry-After', '3600');
    return res.status(429).json({ error: 'Too many accounts created from this network. Try again later.' });
  }
  next();
}

// --- Suspicious activity logging (persisted to SQLite) ---

export function logSuspicious(type: string, details?: Record<string, unknown>) {
  const ip = details?.ip != null ? String(details.ip) : null;
  const userId = details?.userId != null ? Number(details.userId) : null;
  const extra = { ...details };
  delete extra.ip;
  delete extra.userId;
  const detailsStr = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;
  try {
    db.prepare('INSERT INTO suspicious_events (type, user_id, ip, details) VALUES (?, ?, ?, ?)').run(type, userId, ip, detailsStr);
  } catch { /* ignore */ }
  console.warn(`[security] ${type}`, details ? JSON.stringify(details) : '');
}

export function getSuspiciousLog(): Array<Record<string, unknown>> {
  try {
    return db.prepare('SELECT * FROM suspicious_events ORDER BY id DESC LIMIT 500').all() as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

// --- Cookie helpers ---
function cookieFlags(httpOnly: boolean): string {
  const parts = ['Path=/'];
  if (httpOnly) parts.push('HttpOnly');
  parts.push('SameSite=Strict');
  if (config.isProduction) parts.push('Secure');
  return parts.join('; ');
}

function setSessionCookies(res: Response, token: string, csrfToken: string) {
  res.setHeader('Set-Cookie', [
    `${config.sessionCookieName}=${token}; ${cookieFlags(true)}; Max-Age=${config.sessionCookieMaxAge}`,
    `${config.csrfCookieName}=${csrfToken}; ${cookieFlags(false)}; Max-Age=${config.csrfCookieMaxAge}`,
  ]);
}

function clearSessionCookies(res: Response) {
  res.setHeader('Set-Cookie', [
    `${config.sessionCookieName}=; ${cookieFlags(true)}; Max-Age=0`,
    `${config.csrfCookieName}=; ${cookieFlags(false)}; Max-Age=0`,
  ]);
}

export async function deliverCode(phone: string, code: string): Promise<void> {
  const provider = getSmsProvider();
  const body = `Your messenger code: ${code}. Valid for ${Math.floor(config.codeTtlMs / 60_000)} minutes.`;
  await provider.send(phone, body);
}

authRouter.use(sensitiveEndpointLimit);

function deviceLabelOf(req: { body?: { device?: unknown } }): string | undefined {
  const d = String(req.body?.device ?? '').trim();
  return d ? d.slice(0, 64) : undefined;
}

function issueCode(phone: string) {
  // rate limiting: one code per cooldown, max attempts per hour
  const existing = db.prepare('SELECT attempts, last_sent_at FROM auth_codes WHERE phone = ?').get(phone) as
    | { attempts: number; last_sent_at: string | null }
    | undefined;
  if (existing) {
    if (existing.last_sent_at) {
      const elapsed = Date.now() - new Date(existing.last_sent_at).getTime();
      if (elapsed < CODE_COOLDOWN_MS) {
        return { retryAfterMs: CODE_COOLDOWN_MS - elapsed };
      }
    }
    const inCurrentWindow = Boolean(existing.last_sent_at) && Date.now() - new Date(existing.last_sent_at!).getTime() < CODE_WINDOW_MS;
    if (inCurrentWindow && existing.attempts >= MAX_CODE_SENDS) {
      return { limitExceeded: true };
    }
  }

  const code = generateCode();
  const phoneCodeHash = randomToken(16);
  const expiresAt = new Date(Date.now() + config.codeTtlMs).toISOString();
  const inCurrentWindow = Boolean(existing?.last_sent_at) && Date.now() - new Date(existing!.last_sent_at!).getTime() < CODE_WINDOW_MS;
  const attempts = inCurrentWindow ? (existing?.attempts ?? 0) + 1 : 1;
  if (existing) {
    db.prepare(
      'UPDATE auth_codes SET code_hash = ?, phone_code_hash = ?, expires_at = ?, used = 0, attempts = ?, failed_attempts = 0, last_sent_at = ? WHERE phone = ?',
    ).run(sha256Hex(code), phoneCodeHash, expiresAt, attempts, new Date().toISOString(), phone);
  } else {
    db.prepare(
      'INSERT INTO auth_codes (phone, code_hash, phone_code_hash, expires_at, attempts, last_sent_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(phone, sha256Hex(code), phoneCodeHash, expiresAt, attempts, new Date().toISOString());
  }
  return { code, phoneCodeHash };
}

// --- Recovery Codes ---

function generateRecoveryCodes(userId: number): string[] {
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const codes: string[] = [];
  const insert = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
  for (let i = 0; i < 10; i++) {
    const code = randomToken(4).toUpperCase().replace(/(.{4})/g, '$1-').slice(0, -1);
    insert.run(userId, sha256Hex(code));
    codes.push(code);
  }
  return codes;
}

function useRecoveryCode(userId: number, code: string): boolean {
  const codes = db.prepare('SELECT id, code_hash FROM recovery_codes WHERE user_id = ? AND used = 0').all(userId) as { id: number; code_hash: string }[];
  for (const row of codes) {
    if (sha256Hex(code.toUpperCase()) === row.code_hash) {
      db.prepare('UPDATE recovery_codes SET used = 1 WHERE id = ?').run(row.id);
      return true;
    }
  }
  return false;
}

function recoveryCodeCount(userId: number): number {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM recovery_codes WHERE user_id = ? AND used = 0').get(userId) as { cnt: number };
  return row.cnt;
}

// Step 0: check whether a phone number exists in the database.
authRouter.post('/checkPhone', (req, res) => {
  const phone = validatePhone(String(req.body?.phone ?? ''));
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  const user = getUserByPhone(phone);
  res.json({ registered: Boolean(user), phone });
});

// Step 1: request a login code
authRouter.post('/sendCode', async (req, res) => {
  const phone = validatePhone(String(req.body?.phone ?? ''));
  if (!phone) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }
  const result = issueCode(phone);
  if (result.limitExceeded) {
    logSuspicious('code_send_limit', { phone, ip: String(req.ip || '') });
    return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
  }
  if (result.retryAfterMs) {
    return res.status(429).json({ error: 'Wait before requesting another code.', retry_after_ms: result.retryAfterMs });
  }
  const { code, phoneCodeHash } = result as { code: string; phoneCodeHash: string };
  try {
    await deliverCode(phone, code);
    res.json({ phone_code_hash: phoneCodeHash, ...(config.exposeDevCode ? { dev_code: code } : {}) });
  } catch (error) {
    db.prepare('UPDATE auth_codes SET used = 1 WHERE phone_code_hash = ?').run(phoneCodeHash);
    console.error(error);
    res.status(503).json({ error: 'Could not deliver the sign-in code. Try again later.' });
  }
});

async function verifyCodeInput(phone: string, code: string, phoneCodeHash: string, markUsed = false): Promise<boolean> {
  // Per-phone brute-force: max 5 attempts per 5 minutes
  const phoneLimiter = await getPhoneCodeLimiter();
  const phoneCheck = await phoneLimiter.allow(`code:${phone}`);
  if (!phoneCheck.allowed) {
    logSuspicious('code_brute_force', { phone });
    return false;
  }

  // Atomic check+mark to prevent TOCTOU race: use a single UPDATE...WHERE used=0
  if (markUsed) {
    const result = db.prepare(
      'UPDATE auth_codes SET used = 1 WHERE phone_code_hash = ? AND phone = ? AND used = 0 AND failed_attempts < ? AND expires_at > datetime(\'now\')',
    ).run(phoneCodeHash, phone, MAX_CODE_VERIFY_ATTEMPTS);
    if (result.changes === 0) {
      logSuspicious('code_verify_fail', { phone, ip: 'unknown' });
      return false;
    }
    // Verify hash matches (already marked used atomically)
    const row = db.prepare('SELECT code_hash FROM auth_codes WHERE phone_code_hash = ?').get(phoneCodeHash) as { code_hash: string } | undefined;
    if (!row || sha256Hex(code) !== row.code_hash) {
      // Rollback: unmark so it can be retried (hash didn't match)
      db.prepare('UPDATE auth_codes SET used = 0 WHERE phone_code_hash = ?').run(phoneCodeHash);
      return false;
    }
    return true;
  }

  // Non-consuming check (for password/TOTP flow)
  const row = db.prepare('SELECT * FROM auth_codes WHERE phone_code_hash = ?').get(phoneCodeHash) as
    | { phone: string; code_hash: string; expires_at: string; used: number; failed_attempts: number }
    | undefined;
  if (!row || row.phone !== phone || row.used || row.failed_attempts >= MAX_CODE_VERIFY_ATTEMPTS) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  if (sha256Hex(code) !== row.code_hash) {
    logSuspicious('code_verify_fail', { phone, ip: 'unknown' });
    db.prepare(
      'UPDATE auth_codes SET failed_attempts = failed_attempts + 1, used = CASE WHEN failed_attempts + 1 >= ? THEN 1 ELSE used END WHERE phone_code_hash = ?',
    ).run(MAX_CODE_VERIFY_ATTEMPTS, phoneCodeHash);
    return false;
  }
  return true;
}

// Step 2: verify code -> create or sign into the account
authRouter.post('/signIn', async (req, res) => {
  const phone = validatePhone(String(req.body?.phone ?? ''));
  const code = String(req.body?.code ?? '').trim();
  const phoneCodeHash = String(req.body?.phone_code_hash ?? '').trim();
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  if (!await verifyCodeInput(phone, code, phoneCodeHash)) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  let user = getUserByPhone(phone);
  if (!user) {
    return res.status(404).json({ error: 'No account for this phone. Use signUp first.', phone_code_hash: phoneCodeHash });
  }
  if (user.password || user.totp_secret) {
    // do not consume the code yet — checkPassword/verifyTotp must be able to use it
    return res.status(200).json({ status: user.password ? 'need_password' : 'need_totp' });
  }
  if (!await verifyCodeInput(phone, code, phoneCodeHash, true)) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  const token = createSession(user.id, deviceLabelOf(req));
  const csrfToken = randomToken(32);
  setSessionCookies(res, token, csrfToken);
  logSuspicious('auth_success_signin', { userId: user.id, ip: String(req.ip || '') });
  res.json({ status: 'ok', user: publicUser(user) });
});

function generateUsername(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const base = 'user' + digits.slice(-7);
  let candidate = base;
  let i = 1;
  while (getUserByUsername(candidate)) {
    candidate = base + i;
    i++;
  }
  return candidate;
}

authRouter.post('/signUp', massRegistrationLimit, async (req, res) => {
  const phone = validatePhone(String(req.body?.phone ?? ''));
  const code = String(req.body?.code ?? '').trim();
  const phoneCodeHash = String(req.body?.phone_code_hash ?? '').trim();
  const firstName = String(req.body?.first_name ?? '').trim().slice(0, 64);

  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  if (!firstName) return res.status(400).json({ error: 'First name is required' });
  if (getUserByPhone(phone)) return res.status(409).json({ error: 'An account already exists for this phone' });
  const requestedUsername = String(req.body?.username ?? '').trim().replace(/^@/, '');
  if (requestedUsername && !/^[a-zA-Z0-9_]{3,32}$/.test(requestedUsername)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars: letters, digits, underscore' });
  }
  if (!await verifyCodeInput(phone, code, phoneCodeHash, true)) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  const username = requestedUsername || generateUsername(phone);
  const finalUsername = getUserByUsername(username) ? generateUsername(phone) : username;
  const resRow = db
    .prepare('INSERT INTO users (phone, username, first_name) VALUES (?, ?, ?)')
    .run(phone, finalUsername, firstName);
  const userId = Number(resRow.lastInsertRowid);
  // First user becomes admin automatically
  const userCount = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt;
  if (userCount === 1) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(userId);
  }
  const user = getUserById(userId)!;
  const token = createSession(user.id, deviceLabelOf(req));
  const csrfToken = randomToken(32);
  setSessionCookies(res, token, csrfToken);
  logSuspicious('auth_success_signup', { userId: user.id, phone, ip: String(req.ip || '') });
  res.json({ user: publicUser(user) });
});

// Step 3 (2FA): check password
authRouter.post('/checkPassword', async (req, res) => {
  const phone = validatePhone(String(req.body?.phone ?? ''));
  const code = String(req.body?.code ?? '').trim();
  const phoneCodeHash = String(req.body?.phone_code_hash ?? '').trim();
  const password = String(req.body?.password ?? '');
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  if (!await verifyCodeInput(phone, code, phoneCodeHash)) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  const user = getUserByPhone(phone);
  if (!user || !user.password || !verifyPassword(password, user.password)) {
    logSuspicious('2fa_fail', { phone, ip: String(req.ip || '') });
    return res.status(403).json({ error: 'Wrong password' });
  }
  if (!await verifyCodeInput(phone, code, phoneCodeHash, true)) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  const token = createSession(user.id, deviceLabelOf(req));
  const csrfToken = randomToken(32);
  setSessionCookies(res, token, csrfToken);
  logSuspicious('auth_success_2fa', { userId: user.id, ip: String(req.ip || '') });
  res.json({ user: publicUser(user) });
});

// Step 3b (TOTP): verify TOTP code
authRouter.post('/verifyTotp', async (req, res) => {
  const phone = validatePhone(String(req.body?.phone ?? ''));
  const code = String(req.body?.code ?? '').trim();
  const phoneCodeHash = String(req.body?.phone_code_hash ?? '').trim();
  const totpToken = String(req.body?.totp_token ?? '').trim();
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  if (!totpToken) return res.status(400).json({ error: 'TOTP code is required' });
  if (!await verifyCodeInput(phone, code, phoneCodeHash)) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  const user = getUserByPhone(phone);
  if (!user || !user.totp_secret) {
    return res.status(404).json({ error: 'No account or TOTP not enabled' });
  }
  if (!verifyTotp(user.totp_secret, totpToken)) {
    logSuspicious('totp_auth_fail', { phone, ip: String(req.ip || '') });
    return res.status(403).json({ error: 'Invalid TOTP code' });
  }
  if (!await verifyCodeInput(phone, code, phoneCodeHash, true)) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }
  const token = createSession(user.id, deviceLabelOf(req));
  const csrfToken = randomToken(32);
  setSessionCookies(res, token, csrfToken);
  logSuspicious('auth_success_totp', { userId: user.id, ip: String(req.ip || '') });
  res.json({ user: publicUser(user) });
});

// Step 4: account recovery via recovery code
authRouter.post('/recover', (req, res) => {
  const phone = validatePhone(String(req.body?.phone ?? ''));
  const code = String(req.body?.code ?? '').trim();
  if (!phone) return res.status(400).json({ error: 'Invalid phone number' });
  if (!code) return res.status(400).json({ error: 'Recovery code is required' });
  const user = getUserByPhone(phone);
  if (!user) return res.status(404).json({ error: 'No account found' });
  if (!useRecoveryCode(user.id, code)) {
    logSuspicious('recovery_fail', { phone, ip: String(req.ip || '') });
    return res.status(403).json({ error: 'Invalid recovery code' });
  }
  const token = createSession(user.id, deviceLabelOf(req));
  const csrfToken = randomToken(32);
  setSessionCookies(res, token, csrfToken);
  logSuspicious('auth_success_recovery', { userId: user.id, ip: String(req.ip || '') });
  res.json({ user: publicUser(user) });
});

// Logout: destroy session and clear cookies
authRouter.post('/logout', (req, res) => {
  const cookies = parseCookies(req);
  const sessionToken = cookies[config.sessionCookieName];
  if (sessionToken) {
    const tokenHash = sha256Hex(sessionToken);
    const session = db.prepare('SELECT id FROM sessions WHERE token_hash = ?').get(tokenHash) as { id: number } | undefined;
    if (session) {
      deleteSession(session.id, (req as any).userId ?? 0);
    }
  }
  clearSessionCookies(res);
  res.json({ ok: true });
});

// Logout from all sessions
authRouter.post('/logout-all', (req, res) => {
  const userId = (req as any).userId;
  if (userId) {
    deleteAllSessions(userId);
  }
  clearSessionCookies(res);
  res.json({ ok: true });
});

// --- Suspicious activity log (admin only) ---
authRouter.get('/security-log', (req, res) => {
  // Only accessible if user is authenticated and is the first user (admin)
  const userId = (req as any).userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const user = getUserById(userId);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  // Only the first registered user can access the log
  const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined;
  if (!firstUser || firstUser.id !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(getSuspiciousLog().slice(-100));
});

// Helper to parse cookies from request
function parseCookies(req: Request): Record<string, string> {
  const cookies: Record<string, string> = {};
  const cookieHeader = req.headers.cookie ?? '';
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

// --- CAPTCHA challenge (simple math) ---
const captchaChallenges = new Map<string, { answer: number; expiresAt: number }>();
const captchaIpCounts = new Map<string, { count: number; resetAt: number }>();

authRouter.post('/captcha/challenge', (req, res) => {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  // Per-IP rate limit: max 10 captchas per minute
  const now = Date.now();
  const entry = captchaIpCounts.get(ip);
  if (entry && now < entry.resetAt) {
    if (entry.count >= 10) return res.status(429).json({ error: 'Too many captcha requests' });
    entry.count++;
  } else {
    captchaIpCounts.set(ip, { count: 1, resetAt: now + 60_000 });
  }
  // Cleanup old entries periodically
  if (captchaIpCounts.size > 5000) {
    for (const [k, v] of captchaIpCounts) { if (now > v.resetAt) captchaIpCounts.delete(k); }
  }
  // Simplified captcha: small numbers, addition/subtraction only, non-negative result
  const op = Math.random() < 0.5 ? '+' : '-';
  const a = Math.floor(Math.random() * 9) + 2; // 2-10
  const b = Math.floor(Math.random() * 9) + 2; // 2-10
  let answer: number;
  let question: string;
  if (op === '+') {
    answer = a + b;
    question = `${a} + ${b} = ?`;
  } else {
    answer = Math.abs(a - b);
    question = `${Math.max(a, b)} - ${Math.min(a, b)} = ?`;
  }
  const token = randomToken(32);
  captchaChallenges.set(token, { answer, expiresAt: Date.now() + 300_000 });
  logSuspicious('captcha_challenge_issued', { ip });
  res.json({ token, question });
});

authRouter.post('/captcha/verify', (req, res) => {
  const token = String(req.body?.token ?? '');
  const answer = Number(req.body?.answer);
  const challenge = captchaChallenges.get(token);
  if (!challenge) return res.status(400).json({ error: 'Invalid or expired challenge' });
  captchaChallenges.delete(token);
  if (Date.now() > challenge.expiresAt) return res.status(400).json({ error: 'Challenge expired' });
  if (answer !== challenge.answer) {
    logSuspicious('captcha_failed', { ip: String(req.ip || '') });
    return res.status(400).json({ error: 'Incorrect answer', correct: false });
  }
  res.json({ ok: true, correct: true });
});

export { parseCookies, setSessionCookies, clearSessionCookies };
