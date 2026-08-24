/**
 * Pluggable rate limiter with Redis backend and in-memory fallback.
 *
 * Usage:
 *   const limiter = createRateLimiter({ windowMs: 60_000, max: 300 });
 *   if (!limiter.allow(req.ip)) return res.status(429)...
 */

interface RateLimitWindow {
  startedAt: number;
  count: number;
}

interface RateLimiterOpts {
  windowMs: number;
  max: number;
  cleanupIntervalMs?: number;
}

// --- In-memory fallback ---

class MemoryRateLimiter {
  private windows = new Map<string, RateLimitWindow>();
  private opts: RateLimiterOpts;
  private lastCleanup = Date.now();

  constructor(opts: RateLimiterOpts) {
    this.opts = opts;
  }

  allow(key: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const current = this.windows.get(key);
    const window: RateLimitWindow =
      !current || now - current.startedAt >= this.opts.windowMs
        ? { startedAt: now, count: 0 }
        : current;
    window.count += 1;
    this.windows.set(key, window);

    // Periodic cleanup
    if (now - this.lastCleanup > (this.opts.cleanupIntervalMs ?? 60_000)) {
      this.lastCleanup = now;
      if (this.windows.size > 10_000) {
        for (const [k, v] of this.windows) {
          if (now - v.startedAt >= this.opts.windowMs) this.windows.delete(k);
        }
      }
    }

    if (window.count > this.opts.max) {
      const retryAfterMs = this.opts.windowMs - (now - window.startedAt);
      return { allowed: false, retryAfterMs };
    }
    return { allowed: true };
  }

  get count(): number {
    return this.windows.size;
  }
}

// --- Redis backend (lazy) ---

class RedisRateLimiter {
  private redis: any;
  private prefix: string;
  private opts: RateLimiterOpts;

  constructor(redis: any, prefix: string, opts: RateLimiterOpts) {
    this.redis = redis;
    this.prefix = prefix;
    this.opts = opts;
  }

  async allow(key: string): Promise<{ allowed: boolean; retryAfterMs?: number }> {
    const redisKey = `${this.prefix}:${key}`;
    const now = Date.now();
    const windowStart = now - this.opts.windowMs;

    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(redisKey, 0, windowStart);
    pipeline.zadd(redisKey, now, `${now}:${Math.random()}`);
    pipeline.zcard(redisKey);
    pipeline.pexpire(redisKey, this.opts.windowMs);
    const results = await pipeline.exec();

    const count = results[2]?.[1] as number;
    if (count > this.opts.max) {
      return { allowed: false, retryAfterMs: this.opts.windowMs };
    }
    return { allowed: true };
  }

  get count(): number {
    return 0;
  }
}

// --- Factory ---

export interface RateLimiter {
  allow(key: string): { allowed: boolean; retryAfterMs?: number } | Promise<{ allowed: boolean; retryAfterMs?: number }>;
  readonly count: number;
}

let memLimiter: MemoryRateLimiter | null = null;

export async function createRateLimiter(opts: RateLimiterOpts): Promise<RateLimiter> {
  // Try Redis if REDIS_URL is set
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const ioredis = await import('ioredis');
      const Redis = ioredis.default ?? ioredis;
      const redis = new (Redis as any)(redisUrl, { lazyConnect: true });
      redis.connect().catch(() => {});
      const prefix = process.env.REDIS_RATE_PREFIX ?? 'ratelimit';
      console.log('[rate-limit] using Redis backend');
      return new RedisRateLimiter(redis, prefix, opts);
    } catch {
      console.warn('[rate-limit] Redis unavailable, falling back to in-memory');
    }
  }

  // In-memory fallback
  if (!memLimiter) {
    memLimiter = new MemoryRateLimiter(opts);
    console.log('[rate-limit] using in-memory backend');
  }
  return memLimiter;
}
