import crypto from 'node:crypto';

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DIGITS = 6;
const PERIOD = 30;
const ALGORITHM = 'sha1';

export function generateSecret(length = 20): string {
  const bytes = crypto.randomBytes(length);
  return base32Encode(bytes);
}

export function base32Encode(buffer: Buffer): string {
  let bits = '';
  for (const b of buffer) bits += b.toString(2).padStart(8, '0');
  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, '0');
    result += BASE32_CHARS[parseInt(chunk, 2)];
  }
  return result;
}

export function base32Decode(str: string): Buffer {
  const clean = str.replace(/[=\s]/g, '').toUpperCase();
  let bits = '';
  for (const c of clean) {
    const val = BASE32_CHARS.indexOf(c);
    if (val === -1) throw new Error('Invalid base32 character');
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret: string, time?: number): string {
  const key = base32Decode(secret);
  const epoch = time ?? Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / PERIOD);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(0, 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac(ALGORITHM, key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function verifyTotp(secret: string, token: string, window = 1): boolean {
  const now = Math.floor(Date.now() / 1000);
  for (let i = -window; i <= window; i++) {
    if (generateTotp(secret, now + i * PERIOD) === token) return true;
  }
  return false;
}

export function getOtpauthUri(secret: string, email: string, issuer = 'Messenger'): string {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedEmail = encodeURIComponent(email);
  return `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${secret}&issuer=${encodedIssuer}&algorithm=${ALGORITHM}&digits=${DIGITS}&period=${PERIOD}`;
}
