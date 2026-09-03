// Server-side Web Push notification sender using VAPID.
// Uses native Node crypto + fetch (no external dependencies).

import * as crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';

const VAPID_headers = {
  'Content-Type': 'application/octet-stream',
  TTL: '86400',
};

export function getVapidPublicKey(): string {
  return config.vapidPublicKey;
}

export function isWebPushEnabled(): boolean {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey);
}

// Send a Web Push notification to a single subscription endpoint.
export async function sendWebPush(
  endpoint: string,
  p256dh: string,
  auth: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status?: number }> {
  if (!isWebPushEnabled()) return { ok: false };

  try {
    const body = JSON.stringify(payload);
    const bodyBuffer = Buffer.from(body);

    // ---- RFC 8291 + RFC 8188 (aes128gcm) correct implementation ----

    // Ephemeral sender ECDH key on P-256 (65-byte uncompressed point).
    const ephemeral = crypto.createECDH('prime256v1');
    const ephPubRaw = Buffer.from(ephemeral.generateKeys());
    const peerPubRaw = Buffer.from(p256dh, 'base64');
    if (peerPubRaw.length !== 65) throw new Error('Invalid p256dh (expected 65-byte uncompressed point)');
    const sharedSecret = Buffer.from(ephemeral.computeSecret(peerPubRaw));

    const authSecret = Buffer.from(auth, 'base64');
    if (authSecret.length !== 16) throw new Error('Invalid auth secret (expected 16 bytes)');
    const salt = crypto.randomBytes(16);

    // PRK = HKDF-Extract(salt = auth_secret, ikm = shared_secret)
    const prk = hkdfExtract(authSecret, sharedSecret);

    // CEK (16 bytes) = HKDF-Expand(PRK, "Content-Encoding: aes128gcm"||0x00||u32||ua_public, 16)
    const ephLen = Buffer.alloc(4);
    ephLen.writeUInt32BE(ephPubRaw.length, 0);
    const cekInfo = Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), ephLen, ephPubRaw]);
    const cek = hkdfExpand(prk, cekInfo, 16);

    // nonce (12 bytes) = HKDF-Expand(PRK, "Content-Encoding: nonce"||0x00||u32||ua_public, 12)
    const nonceInfo = Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), ephLen, ephPubRaw]);
    const nonce = hkdfExpand(prk, nonceInfo, 12);

    // Record size 4096; single record with padding to rs-16.
    const rs = 4096;
    const recordPlainLen = rs - 16; // 4080 (reserve 16-byte GCM tag per record)
    if (bodyBuffer.length + 1 > recordPlainLen) throw new Error('Payload too large for Web Push (max ~4 KB)');
    const record = Buffer.alloc(recordPlainLen, 0);
    bodyBuffer.copy(record, 0);
    record[bodyBuffer.length] = 0x02; // record delimiter, then zero padding

    // aes128gcm header: salt(16) || rs(4 BE) || idlen(1)=0x00 (no keyid for Web Push)
    const rsBuf = Buffer.alloc(4);
    rsBuf.writeUInt32BE(rs, 0);
    const header = Buffer.concat([salt, rsBuf, Buffer.from([0x00])]);

    // AAD is the aes128gcm header itself.
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    cipher.setAAD(header);
    const encrypted = Buffer.concat([cipher.update(record), cipher.final()]);
    const tag = cipher.getAuthTag();

    const aes128gcmPayload = Buffer.concat([header, encrypted, tag]);

    const vapidHeaders = getVapidAuthHeader(endpoint);

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...VAPID_headers,
        'Content-Encoding': 'aes128gcm',
        'Content-Length': String(aes128gcmPayload.length),
        Authorization: vapidHeaders,
      },
      body: aes128gcmPayload,
    });

    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    console.error('[push] send failed:', err);
    return { ok: false };
  }
}

// Send push to all subscriptions of a user
export async function sendPushToUser(
  userId: number,
  payload: Record<string, unknown>,
): Promise<void> {
  // Web Push
  if (isWebPushEnabled()) {
    const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId) as Array<{
      endpoint: string;
      p256dh: string;
      auth: string;
    }>;
    for (const sub of subs) {
      const result = await sendWebPush(sub.endpoint, sub.p256dh, sub.auth, payload);
      if (!result.ok && result.status && (result.status === 404 || result.status === 410)) {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
      }
    }
  }
  // Mobile push (FCM + APNs)
  if (isFCMEnabled() || isAPNsEnabled()) {
    const title = typeof payload.title === 'string' ? payload.title : 'Messenger';
    const body = typeof payload.body === 'string' ? payload.body : 'New message';
    await sendMobilePushToUser(userId, { title, body });
  }
}

// HKDF-Extract: PRK = HMAC-SHA256(salt, ikm). RFC 5869.
function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return crypto.createHmac('sha256', salt).update(ikm).digest();
}

// HKDF-Expand: RFC 5869.
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const output = Buffer.alloc(length);
  let produced = 0;
  let t = Buffer.alloc(0);
  let counter = 1;
  while (produced < length) {
    const hmac = crypto.createHmac('sha256', prk);
    if (t.length > 0) hmac.update(t);
    hmac.update(info);
    hmac.update(Buffer.from([counter]));
    t = hmac.digest();
    const needed = Math.min(t.length, length - produced);
    t.copy(output, produced, 0, needed);
    produced += t.length;
    counter += 1;
  }
  return output;
}

function getVapidAuthHeader(endpoint: string): string {
  const url = new URL(endpoint);

  const header = { alg: 'ES256', typ: 'JWT' };
  const payload = {
    aud: url.origin,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: config.vapidSubject,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;

  // Load the VAPID private key (raw EC private key bytes, base64)
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(config.vapidPrivateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  const sigB64 = signature.toString('base64url');

  return `vapid t=${signingInput}.${sigB64}, k=${config.vapidPublicKey}`;
}

// ======================== FCM MOBILE PUSH ========================

interface FCMConfig {
  projectId: string;
  privateKey: string;
  clientEmail: string;
}

export function isFCMEnabled(): boolean {
  return Boolean(process.env.FCM_PROJECT_ID && process.env.FCM_PRIVATE_KEY && process.env.FCM_CLIENT_EMAIL);
}

function getFCMConfig(): FCMConfig | null {
  if (!isFCMEnabled()) return null;
  return {
    projectId: String(process.env.FCM_PROJECT_ID),
    privateKey: String(process.env.FCM_PRIVATE_KEY).replace(/\\n/g, '\n'),
    clientEmail: String(process.env.FCM_CLIENT_EMAIL),
  };
}

let fcmAccessToken: string | null = null;
let fcmTokenExpiresAt = 0;

async function getFCMAccessToken(cfg: FCMConfig): Promise<string> {
  if (fcmAccessToken && Date.now() < fcmTokenExpiresAt - 60_000) return fcmAccessToken;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: cfg.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), crypto.createPrivateKey(cfg.privateKey));
  const assertion = `${signingInput}.${signature.toString('base64url')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!res.ok) throw new Error(`FCM auth failed: HTTP ${res.status}`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('FCM auth returned no access_token');
  fcmAccessToken = data.access_token;
  fcmTokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  return fcmAccessToken;
}

// Send a push notification to FCM device tokens via the Firebase HTTP v1 API.
// Silently no-ops when FCM_* env vars are not configured.
export async function sendFCM(
  tokens: string[],
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; sent: number }> {
  const cfg = getFCMConfig();
  if (!cfg || !Array.isArray(tokens) || tokens.length === 0) {
    return { ok: false, sent: 0 };
  }
  let sent = 0;
  try {
    const accessToken = await getFCMAccessToken(cfg);
    const notification: Record<string, string> = {};
    if (typeof payload.title === 'string') notification.title = payload.title.slice(0, 200);
    if (typeof payload.body === 'string') notification.body = payload.body.slice(0, 500);
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (k !== 'title' && k !== 'body' && v != null) data[k] = String(v).slice(0, 500);
    }

    for (const token of tokens) {
      try {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${cfg.projectId}/messages:send`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message: { token, notification, data } }),
        });
        if (res.ok) {
          sent++;
        } else if (res.status === 404 || res.status === 410) {
          db.prepare('DELETE FROM fcm_tokens WHERE token = ?').run(token);
        }
      } catch {
        // per-token failure should not abort remaining tokens
      }
    }
    return { ok: sent > 0, sent };
  } catch (err) {
    console.error('[push] FCM send failed:', err);
    return { ok: false, sent };
  }
}

// Push to all registered FCM device tokens of a user
export async function sendFCMToUser(userId: number, payload: Record<string, unknown>): Promise<void> {
  if (!isFCMEnabled()) return;
  const rows = db.prepare('SELECT token FROM fcm_tokens WHERE user_id = ?').all(userId) as Array<{ token: string }>;
  if (!rows.length) return;
  await sendFCM(rows.map((r) => r.token), payload);
}

// ======================== APNS MOBILE PUSH ========================

interface APNsConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
  production: boolean;
}

export function isAPNsEnabled(): boolean {
  return Boolean(process.env.APNS_TEAM_ID && process.env.APNS_KEY_ID && process.env.APNS_PRIVATE_KEY && process.env.APNS_BUNDLE_ID);
}

function getAPNsConfig(): APNsConfig | null {
  if (!isAPNsEnabled()) return null;
  return {
    teamId: String(process.env.APNS_TEAM_ID),
    keyId: String(process.env.APNS_KEY_ID),
    privateKey: String(process.env.APNS_PRIVATE_KEY).replace(/\\n/g, '\n'),
    bundleId: String(process.env.APNS_BUNDLE_ID),
    production: process.env.APNS_PRODUCTION === '1',
  };
}

let apnsToken: string | null = null;
let apnsTokenExpiresAt = 0;

function getAPNsJwtToken(cfg: APNsConfig): string {
  if (apnsToken && Date.now() < apnsTokenExpiresAt - 60_000) return apnsToken;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: cfg.keyId };
  const claims = { iss: cfg.teamId, iat: now };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  const privateKey = crypto.createPrivateKey(cfg.privateKey);
  const sig = crypto.sign(null, Buffer.from(signingInput), privateKey);
  const jwt = `${signingInput}.${sig.toString('base64url')}`;
  apnsToken = jwt;
  apnsTokenExpiresAt = Date.now() + 3600 * 1000;
  return jwt;
}

export async function sendAPNs(
  tokens: string[],
  payload: { title: string; body: string; badge?: number; sound?: string },
): Promise<{ ok: boolean; sent: number }> {
  const cfg = getAPNsConfig();
  if (!cfg || !tokens.length) return { ok: false, sent: 0 };
  let sent = 0;
  const jwt = getAPNsJwtToken(cfg);
  const host = cfg.production ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';

  for (const token of tokens) {
    try {
      const apnsPayload = JSON.stringify({
        aps: {
          alert: { title: payload.title, body: payload.body },
          badge: payload.badge ?? 1,
          sound: payload.sound ?? 'default',
        },
      });
      const res = await fetch(`https://${host}/3/device/${token}`, {
        method: 'POST',
        headers: {
          authorization: `bearer ${jwt}`,
          'apns-topic': cfg.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        body: apnsPayload,
      });
      if (res.ok) {
        sent++;
      } else if (res.status === 410) {
        db.prepare('DELETE FROM apns_tokens WHERE token = ?').run(token);
      }
    } catch {
      // per-token failure should not abort
    }
  }
  return { ok: sent > 0, sent };
}

export async function sendAPNsToUser(userId: number, payload: { title: string; body: string }): Promise<void> {
  if (!isAPNsEnabled()) return;
  const rows = db.prepare('SELECT token FROM apns_tokens WHERE user_id = ?').all(userId) as Array<{ token: string }>;
  if (!rows.length) return;
  await sendAPNs(rows.map((r) => r.token), payload);
}

// Combined push helper: sends to both FCM and APNs
export async function sendMobilePushToUser(userId: number, payload: { title: string; body: string }): Promise<void> {
  await Promise.all([
    sendFCMToUser(userId, payload),
    sendAPNsToUser(userId, payload),
  ]);
}
