import type { Request, Response, NextFunction } from 'express';
import { db } from '../db.js';

/**
 * Idempotency-key middleware for mutating requests.
 *
 * Client sends `Idempotency-Key: <uuid>`; first request runs and its JSON
 * response is cached for 24h; duplicates return the cached response without
 * re-running the handler. Used for retry-prone POST/PATCH/DELETE endpoints.
 */
export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  const key = String(req.headers['idempotency-key'] ?? '').trim();
  if (!key) return next();
  if (key.length > 128 || !/^[A-Za-z0-9._-]+$/.test(key)) {
    res.status(400).json({ error: 'Invalid Idempotency-Key' });
    return;
  }

  const userId = (req as any).userId ?? 0;
  const endpoint = req.baseUrl + req.path;

  // Existing record → replay cached response if still fresh
  const existing = db
    .prepare('SELECT status, response FROM idempotency_keys WHERE key = ? AND created_at > datetime(\'now\', \'-1 day\')')
    .get(key) as { status: number; response: string } | undefined;
  if (existing) {
    res.status(existing.status).setHeader('X-Idempotency-Replayed', 'true');
    res.send(existing.response);
    return;
  }

  // Execute handler, capture its JSON output, store it.
  const origJson = res.json.bind(res);
  res.json = (body: any) => {
    const text = JSON.stringify(body);
    try {
      db.prepare('INSERT INTO idempotency_keys (key, user_id, endpoint, status, response) VALUES (?, ?, ?, ?, ?)')
        .run(key, userId, endpoint.slice(0, 255), res.statusCode, text ?? '');
    } catch {
      // storage is best-effort; do not fail the request
    }
    return origJson(body);
  };
  next();
}