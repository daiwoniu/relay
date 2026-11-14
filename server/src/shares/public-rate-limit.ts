export class PublicShareRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 60,
    private readonly windowMs = 60_000,
    private readonly maxEntries = 5_000,
  ) {}

  consume(key: string, now = Date.now()): boolean {
    this.cleanup(now);
    const current = this.entries.get(key);
    if (!current || current.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }

  private cleanup(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}
