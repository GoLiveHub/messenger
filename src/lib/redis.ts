/**
 * Redis abstraction layer.
 *
 * If REDIS_URL is set and ioredis is available, creates a real Redis connection.
 * Otherwise falls back to an in-memory Map.
 *
 * Exports: get, set, del, incr, expire
 */

type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttl?: number): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  quit(): Promise<void>;
};

class MemoryClient implements RedisClient {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  private isExpired(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return true;
    }
    return false;
  }

  async get(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null;
    const entry = this.store.get(key);
    return entry?.value ?? null;
  }

  async set(key: string, value: string, mode?: string, ttl?: number): Promise<string | null> {
    const expiresAt = mode === 'EX' && ttl ? Date.now() + ttl * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  async incr(key: string): Promise<number> {
    const current = this.store.get(key);
    const val = current ? parseInt(current.value, 10) + 1 : 1;
    this.store.set(key, { value: String(val) });
    return val;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1000;
    return 1;
  }

  async quit(): Promise<void> {
    this.store.clear();
  }

  /** Fixed-window increment that is atomic and sets TTL on first hit. */
  incrWindow(key: string, ttlMs: number): Promise<number> {
    // Set TTL only if the key did not exist yet, so the window runs from the
    // first request (fixed window), not sliding on every hit.
    const existing = this.store.get(key);
    if (!existing || this.isExpired(key)) {
      this.store.set(key, { value: '1', expiresAt: Date.now() + ttlMs });
      return Promise.resolve(1);
    }
    const val = parseInt(existing.value, 10) + 1;
    this.store.set(key, { value: String(val), expiresAt: existing.expiresAt });
    return Promise.resolve(val);
  }
}

let client: RedisClient | null = null;

export async function getRedisClient(): Promise<RedisClient> {
  if (client) return client;

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const ioredis = await import('ioredis');
      const Redis = ioredis.default ?? ioredis;
      const redis = new (Redis as any)(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy(times: number) {
          if (times > 3) return null;
          return Math.min(times * 200, 2000);
        },
        lazyConnect: true,
      });
      redis.connect().catch(() => {});
      console.log('[redis] connected to', redisUrl.replace(/\/\/.*@/, '//***@'));
      client = redis;
    } catch {
      console.warn('[redis] ioredis not available, falling back to in-memory');
      client = new MemoryClient();
    }
  } else {
    console.log('[redis] REDIS_URL not set, using in-memory store');
    client = new MemoryClient();
  }

  return client!;
}

// --- Convenience wrappers ---

export async function cacheGet(key: string): Promise<string | null> {
  return (await getRedisClient()).get(key);
}

export async function cacheSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  const c = await getRedisClient();
  if (ttlSeconds) {
    await c.set(key, value, 'EX', ttlSeconds);
  } else {
    await c.set(key, value);
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  await (await getRedisClient()).del(...keys);
}

export async function cacheIncr(key: string): Promise<number> {
  return (await getRedisClient()).incr(key);
}

export async function cacheExpire(key: string, ttlSeconds: number): Promise<void> {
  await (await getRedisClient()).expire(key, ttlSeconds);
}

/**
 * Atomic fixed-window increment with TTL.
 *
 * Redis: a single Lua script (INCR + PEXPIRE only when the key is brand new)
 * so concurrent replicas always agree on one shared count — no reset race, no
 * per-instance windows when REDIS_URL is configured.
 *
 * In-memory fallback: MemoryClient#incrWindow has the identical semantics.
 */
export async function cacheIncrWindow(key: string, windowMs: number): Promise<number> {
  const c = await getRedisClient();
  if (typeof (c as any).incrWindow === 'function') {
    return (c as any as { incrWindow(k: string, ms: number): Promise<number> }).incrWindow(key, windowMs);
  }
  // ioredis: atomic Lua.
  const r = c as any;
  if (typeof r.eval === 'function') {
    const script = [
      'local c = redis.call("INCR", KEYS[1])',
      'if c == 1 then',
      '  redis.call("PEXPIRE", KEYS[1], ARGV[1])',
      'end',
      'return c',
    ].join('\n');
    const res = await r.eval(script, 1, key, String(windowMs));
    return Number(res ?? 0);
  }
  // Last-resort: INCR then conditional EXPIRE (best-effort on exotic clients).
  const count = await c.incr(key);
  if (count === 1) await c.expire(key, Math.max(1, Math.round(windowMs / 1000)));
  return count;
}

// --- Presence tracking helpers ---

export async function presenceSet(userId: number, socketId: string, ttlSeconds = 300): Promise<void> {
  const c = await getRedisClient();
  const key = `presence:${userId}`;
  await c.set(key, socketId, 'EX', ttlSeconds);
}

export async function presenceGet(userId: number): Promise<string | null> {
  return (await getRedisClient()).get(`presence:${userId}`);
}

export async function presenceDel(userId: number): Promise<void> {
  await (await getRedisClient()).del(`presence:${userId}`);
}
