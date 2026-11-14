export interface RuntimeFence {
  runtime: object;
  sessionId: string;
  attemptId: string;
  connectionId: string;
  version: number;
}
export class RuntimeEventQueueError extends Error {
  constructor(readonly code: 'INVALID_EVENT' | 'OVERLOADED' | 'CLOSED' | 'FAILED') { super(`RUNTIME_EVENT_${code}`); }
}
class StaleEvent extends Error {}

/** One queue per attempt. The runtime owner checks identity again before every post-await side effect. */
export class RuntimeEventQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private bytes = 0;
  private closed = false;
  private failed = false;
  constructor(private readonly isCurrent: (fence: RuntimeFence) => boolean, private readonly options: {
    maxPending?: number; maxBytes?: number; onFailure?: (code: 'RUNTIME_EVENT_FAILED') => void;
  } = {}) {
    for (const value of [options.maxPending ?? 256, options.maxBytes ?? 16 * 1024 * 1024]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RuntimeEventQueueError('INVALID_EVENT');
    }
  }
  enqueue<T>(fence: RuntimeFence, bytes: number, work: (guard: {
    isCurrent: () => boolean; assertCurrent: () => void;
  }) => T | Promise<T>): Promise<{ state: 'handled'; value: T } | { state: 'stale' }> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !fence.runtime || typeof fence.runtime !== 'object'
      || !Number.isSafeInteger(fence.version) || fence.version < 0
      || !fence.sessionId || !fence.attemptId || !fence.connectionId) return Promise.reject(new RuntimeEventQueueError('INVALID_EVENT'));
    if (this.closed || this.failed) return Promise.reject(new RuntimeEventQueueError(this.failed ? 'FAILED' : 'CLOSED'));
    if (!this.isCurrent(fence)) return Promise.resolve({ state: 'stale' });
    if (this.pending >= (this.options.maxPending ?? 256) || this.bytes + bytes > (this.options.maxBytes ?? 16 * 1024 * 1024)) return Promise.reject(new RuntimeEventQueueError('OVERLOADED'));
    const captured = Object.freeze({ ...fence });
    const current = () => this.isCurrent(captured);
    this.pending++; this.bytes += bytes;
    const result = this.tail.then(async (): Promise<{ state: 'handled'; value: T } | { state: 'stale' }> => {
      try {
        if (!current()) return { state: 'stale' };
        if (this.failed) throw new RuntimeEventQueueError('FAILED');
        const value = await work({ isCurrent: () => current() && !this.failed, assertCurrent: () => {
          if (!current()) throw new StaleEvent(); if (this.failed) throw new RuntimeEventQueueError('FAILED');
        } });
        if (this.failed) throw new RuntimeEventQueueError('FAILED');
        return current() ? { state: 'handled', value } : { state: 'stale' };
      } catch (error) {
        if (!current()) return { state: 'stale' };
        if (!this.failed) {
          this.failed = true;
          try { this.options.onFailure?.('RUNTIME_EVENT_FAILED'); } catch { /* Diagnostics do not change queue state. */ }
        }
        throw error;
      } finally { this.pending--; this.bytes -= bytes; }
    });
    // Observe rejection even if a void engine callback only registers work; failure remains explicit in health/close.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  health() { return { pending: this.pending, bytes: this.bytes, closed: this.closed, failed: this.failed }; }
  poison() { this.failed = true; }
  async drain() {
    await this.tail;
    if (this.failed) throw new RuntimeEventQueueError('FAILED');
  }
  async close() {
    this.closed = true;
    await this.drain();
  }
}
