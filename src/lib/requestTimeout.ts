import type { Request, Response, NextFunction } from 'express';

/**
 * Request timeout middleware.
 *
 * Aborts slow requests (DB stall, hung external API call) and answers 408.
 * `req.socket` / `res` are destroyed after sending so the connection does not
 * stay open. Exempts the Socket.io handshake: the polling transport needs the
 * long-poll socket to stay alive (long-polling is exempted; websocket upgrade
 * never passes through an Express route).
 */
export function requestTimeout(ms: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { socket } = req;
    if (!socket || socket.readableEnded) {
      next();
      return;
    }
    const p = socket.setTimeout || socket.setTimeout;
    if (!p) {
      next();
      return;
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!res.headersSent) {
        res.status(408).json({ error: 'Request timed out' });
      }
      try {
        socket.destroy();
      } catch {
        // socket may already be closed
      }
    }, ms);
    timer.unref?.();

    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));

    // keep the native server-level timeout sane: never fire before ours
    const socketAny = socket as unknown as { timeout: number };
    const oldTimeout = socketAny.timeout;
    socketAny.timeout = ms + 5_000;

    res.on('finish', () => {
      try {
        socketAny.timeout = oldTimeout;
      } catch {
        // ignore
      }
    });

    if (!timedOut) next();
  };
}