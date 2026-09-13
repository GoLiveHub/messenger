import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Request ID middleware.
 *
 * Attaches a unique `X-Request-Id` header to every response.
 * If the client sends one, it is reused (for distributed tracing).
 * Also sets `req.id` for downstream logging.
 */

declare module 'express-serve-static-core' {
  interface Request {
    /** Unique request identifier, available after requestId middleware runs. */
    id: string;
  }
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string | undefined) || randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}
