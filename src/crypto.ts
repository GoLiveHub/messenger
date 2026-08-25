import crypto from 'node:crypto';
import { config } from './config.js';

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function generateCode(len = 6): string {
  const max = 10 ** len;
  return crypto.randomInt(0, max).toString().padStart(len, '0');
}

// --- 2FA passwords (scrypt, no external deps) ---

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// --- Server-side encryption at rest (regular chats) ---
// AES-256-GCM. The server key is derived from the secret so no key file is needed.

let _atRestKey: Buffer | null = null;
function atRestKey(): Buffer {
  if (!_atRestKey) _atRestKey = crypto.createHash('sha256').update(config.serverSecret + ':at-rest-v1').digest();
  return _atRestKey;
}

export function encryptAtRest(plaintext: Buffer): { body: Buffer; iv: Buffer } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', atRestKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { body: Buffer.concat([enc, tag]), iv };
}

export function decryptAtRest(body: Buffer, iv: Buffer): Buffer {
  const tag = body.subarray(body.length - 16);
  const data = body.subarray(0, body.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', atRestKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
