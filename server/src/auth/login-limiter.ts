interface LoginAttemptLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  maxEntries?: number;
}

interface AttemptState {
  failures: number;
  lastFailedAt: number;
}

export class LoginAttemptLimiter {
  private readonly attempts = new Map<string, AttemptState>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;

  constructor(options: LoginAttemptLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowMs = options.windowMs ?? 5 * 60 * 1000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 10_000);
  }

  get size(): number {
    return this.attempts.size;
  }

  private deleteExpired(now: number): void {
    for (const [key, state] of this.attempts) {
      if (now - state.lastFailedAt >= this.windowMs) this.attempts.delete(key);
    }
  }

  private makeRoom(): void {
    while (this.attempts.size >= this.maxEntries) {
      const oldestKey = this.attempts.keys().next().value as string | undefined;
      if (!oldestKey) return;
      this.attempts.delete(oldestKey);
    }
  }

  canAttempt(key: string, now = Date.now()): boolean {
    this.deleteExpired(now);
    const state = this.attempts.get(key);
    if (!state) return true;
    return state.failures < this.maxFailures;
  }

  getRetryAfterSeconds(key: string, now = Date.now()): number {
    this.deleteExpired(now);
    const state = this.attempts.get(key);
    if (!state || state.failures < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((this.windowMs - (now - state.lastFailedAt)) / 1000));
  }

  getRemainingAttempts(key: string, now = Date.now()): number {
    this.deleteExpired(now);
    const state = this.attempts.get(key);
    return Math.max(0, this.maxFailures - (state?.failures ?? 0));
  }

  recordFailure(key: string, now = Date.now()): number {
    this.deleteExpired(now);
    const state = this.attempts.get(key);
    if (!state) {
      this.makeRoom();
      this.attempts.set(key, { failures: 1, lastFailedAt: now });
      return Math.max(0, this.maxFailures - 1);
    }
    state.failures += 1;
    state.lastFailedAt = now;
    return Math.max(0, this.maxFailures - state.failures);
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }
}

export function formatLoginRetryAfter(seconds: number): string {
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.max(1, seconds)} 秒`;
}
