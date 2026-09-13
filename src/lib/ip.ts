import { isIP } from 'node:net';
import type { Request } from 'express';

/**
 * Trusted-peer client IP resolution.
 *
 * Rate limits MUST NOT be keyed on attacker-controlled headers. We only trust
 * X-Forwarded-For when the direct socket peer is a known proxy (loopback /
 * RFC1918 / link-local / ULA) — exactly the case behind nginx, Railway's edge
 * or a Docker bridge. When the peer is a public address the request reached us
 * directly, so XFF is ignored entirely and the socket address is treated as the
 * client: rotating X-Forwarded-For/X-Real-IP/CF-Connecting-Ip no longer buys a
 * fresh bucket.
 */
export function isTrustedPeer(addr: string): boolean {
  const ip = stripZone(addr);
  const v = isIP(ip);
  if (v === 0) return false;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
  }
  return false;
}

function stripZone(ip: string): string {
  const idx = ip.indexOf('%');
  return idx === -1 ? ip : ip.slice(0, idx);
}

function isValidClientIp(candidate: string): boolean {
  const ip = stripZone(candidate);
  return isIP(ip) > 0 && candidate.indexOf('/') === -1 && candidate.indexOf(' ') === -1;
}

/**
 * Returns the client IP for rate limiting / logging, trusting XFF only from a
 * trusted peer (see isTrustedPeer). Never returns attacker-controlled garbage.
 */
export function getClientIp(req: Request): string {
  const peer = String(req.socket?.remoteAddress || '');
  if (!isTrustedPeer(peer)) return peer || 'unknown';
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    for (const part of xff.split(',')) {
      const candidate = part.trim();
      if (isValidClientIp(candidate)) return candidate;
    }
  }
  return peer;
}