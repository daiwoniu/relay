import { createSessionToken } from './session.js';
import { StorageContractError } from '../storage/command-boundary.js';

type Entry = { scope: string; token: string; tokenHash: string; expiresAt: number; timer: ReturnType<typeof setTimeout> };
/** Bounded, disposable server-memory token custody. Passwords are never kept in this registry. */
export class LoginIntentTokens {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(private readonly maxEntries = 128, private readonly ttlMs = 300_000, private readonly now = Date.now) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 128
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300_000) throw new StorageContractError('INVALID_ARGUMENT');
  }
  private remove(id: string) { const entry = this.entries.get(id); if (entry) clearTimeout(entry.timer); this.entries.delete(id); }
  acquire(id: string, scope: string): Readonly<{ token: string; tokenHash: string }> {
    if (this.closed) throw new StorageContractError('STORAGE_UNAVAILABLE');
    for (const [key, value] of this.entries) if (value.expiresAt <= this.now()) this.remove(key);
    const prior = this.entries.get(id);
    if (prior) { if (prior.scope !== scope) throw new StorageContractError('CONFLICT'); return Object.freeze({ token: prior.token, tokenHash: prior.tokenHash }); }
    if (this.entries.size >= this.maxEntries) throw new StorageContractError('OVERLOADED');
    const timer = setTimeout(() => this.remove(id), this.ttlMs); timer.unref?.();
    const entry = { ...createSessionToken(), scope, expiresAt: this.now() + this.ttlMs, timer };
    this.entries.set(id, entry); return Object.freeze({ token: entry.token, tokenHash: entry.tokenHash });
  }
  dispose() { this.closed = true; for (const key of this.entries.keys()) this.remove(key); }
  get size() { return this.entries.size; }
}
