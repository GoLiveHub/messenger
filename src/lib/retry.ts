/**
 * Retry with exponential backoff, decorrelated jitter and an overall budget.
 *
 *   await withRetry(() => fetch(...), {
 *     attempts: 3,
 *     baseDelayMs: 1_000,
 *     maxDelayMs: 16_000,
 *     shouldRetry: (e) => e.status >= 500,
 *   });
 */
export interface RetryOptions {
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Optional predicate: decide which errors are retryable. Defaults to all. */
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  /** Per-call timeout (AbortSignal) in ms. */
  timeoutMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    onAbort = () => {
      clearTimeout(t);
      cleanup();
      reject(new Error('Aborted'));
    };
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Decorrelated jitter: base * 2^attempt reversed — full jitter avoids thundering herd. */
function computeDelay(baseDelayMs: number, maxDelayMs: number, attempt: number): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  // Full jitter: uniform random between base and cap.
  return baseDelayMs + Math.random() * Math.max(0, cap - baseDelayMs);
}

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { attempts, baseDelayMs = 1_000, maxDelayMs = 16_000, shouldRetry, onRetry, timeoutMs } = opts;
  let lastErr: unknown;
  const abortCtl = new AbortController();
  if (timeoutMs) {
    const t = setTimeout(() => abortCtl.abort(), timeoutMs);
    t.unref?.();
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(abortCtl.signal);
    } catch (err) {
      lastErr = err;
      if ((abortCtl.signal as any).aborted) throw err;
      if (attempt >= attempts) break;
      if (shouldRetry && !shouldRetry(err)) throw err;
      const delay = computeDelay(baseDelayMs, maxDelayMs, attempt);
      onRetry?.(attempt, err, delay);
      await sleep(delay);
    }
  }
  abortCtl.abort?.();
  throw lastErr;
}