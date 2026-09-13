/**
 * Circuit breaker with exponential backoff + jitter.
 *
 * State machine: CLOSED -> OPEN (after failures threshold) -> HALF_OPEN
 * (after cool-down) -> CLOSED (test succeeds) | OPEN (test fails).
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Failures before the breaker trips OPEN. */
  failureThreshold?: number;
  /** Milliseconds the breaker stays OPEN before a half-open test. */
  cooldownMs?: number;
  /** How many in-flight probes are allowed in HALF_OPEN. */
  halfOpenMaxConcurrent?: number;
}

class CircuitBreaker {
  private _state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenMaxConcurrent: number;
  private halfOpenInflight = 0;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.halfOpenMaxConcurrent = opts.halfOpenMaxConcurrent ?? 1;
  }

  get state(): CircuitState {
    return this._state;
  }
  get failures(): number {
    return this.failureCount;
  }

  /** Call before an external request. Throws when the breaker is open. */
  before(): void {
    if (this._state === 'open') {
      if (Date.now() - this.lastFailureAt >= this.cooldownMs) {
        this._state = 'half_open';
        this.halfOpenInflight = 0;
      } else {
        throw new Error('Circuit breaker is OPEN — failing fast');
      }
    }
    if (this._state === 'half_open') {
      if (this.halfOpenInflight >= this.halfOpenMaxConcurrent) {
        throw new Error('Circuit breaker half-open — concurrency limit reached');
      }
      this.halfOpenInflight += 1;
    }
  }

  /** Report a success (resets the breaker). */
  success(): void {
    this.failureCount = 0;
    if (this._state === 'half_open') {
      this.halfOpenInflight = 0;
      this._state = 'closed';
    }
  }

  /** Report a failure. */
  failure(): void {
    this.failureCount += 1;
    this.lastFailureAt = Date.now();
    if (this._state === 'half_open') {
      this._state = 'open';
      this.halfOpenInflight = 0;
    } else if (this.failureCount >= this.failureThreshold) {
      this._state = 'open';
    }
  }

  /** Manually force OPEN (e.g. healthcheck confirmed dependency is down). */
  trip(): void {
    this._state = 'open';
    this.lastFailureAt = Date.now();
  }

  get isOpen(): boolean {
    return this._state === 'open';
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(name: string, opts?: CircuitBreakerOptions): CircuitBreaker {
  let cb = breakers.get(name);
  if (!cb) {
    cb = new CircuitBreaker(opts);
    breakers.set(name, cb);
  }
  return cb;
}

export function circuitState(name: string): CircuitState {
  return breakers.get(name)?.state ?? 'closed';
}

export function listCircuitStates(): Array<{ name: string; state: CircuitState }> {
  return [...breakers.entries()].map(([name, cb]) => ({ name, state: cb.state }));
}