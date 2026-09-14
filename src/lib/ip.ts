import { isIP } from 'node:net';
import type { Request } from 'express';
import { config } from '../config.js';

/**
 * Client IP for rate limiting / logging.
 *
 * Default behaviour mirrors Express `trust proxy: false`: the client identity
 * is ALWAYS the direct socket peer. Attackers cannot rotate
 * X-Forwarded-For/X-Real-IP/CF-Connecting-Ip to open fresh rate-limit buckets,
 * and NAT/CGNAT users collapse to one shared bucket (correct: no better signal
 * exists without authenticated identity).
 *
 * When TRUST_PROXY=1 is configured, a trusted reverse proxy sits in front
 * (nginx, Railway edge, Docker bridge). Then — and only then — the first
 * X-Forwarded-For entry is used, exactly as nginx/HAProxy appended it from the
 * real client socket. The proxy in that path strips/chains XFF itself.
 */
export function getClientIp(req: Request): string {
  const peer = String(req.socket?.remoteAddress || '');
  if (!config.trustProxy) return peer || 'unknown';
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    for (const part of xff.split(',')) {
      const candidate = part.trim();
      if (isValidClientIp(candidate)) return candidate;
    }
  }
  return peer || 'unknown';
}

function stripZone(ip: string): string {
  const idx = ip.indexOf('%');
  return idx === -1 ? ip : ip.slice(0, idx);
}

function isValidClientIp(candidate: string): boolean {
  const ip = stripZone(candidate);
  return isIP(ip) > 0 && candidate.indexOf('/') === -1 && candidate.indexOf(' ') === -1;
}