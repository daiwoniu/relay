import { randomUUID } from 'node:crypto';
import type { CoreStoragePort } from '../storage/contracts.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { StorageContractError } from '../storage/command-boundary.js';

/** One provider snapshot in flight. Failed/unknown fetches never become an empty authoritative list. */
export class StoredArchiveSync {
  private closed=false;
  private pending: Promise<void> | undefined;
  private validUntil = 0;
  constructor(private readonly options: { port: CoreStoragePort; storeId: string; generation: number;
    fetchArchivedThreadIds: () => Promise<readonly string[]>;
    changed: (sessionId: string) => void | Promise<void>;
    ttlMs?: number;
  }) {
    if (options.ttlMs !== undefined && (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 0 || options.ttlMs > 60_000)) throw new StorageContractError('INVALID_ARGUMENT');
    this.options = Object.freeze({ ...options });
  }
  invalidate(): void { this.validUntil = 0; }
  refresh(): Promise<void> {
    if(this.closed)return Promise.reject(new StorageContractError('NOT_SUBMITTED'));
    if (this.pending) return this.pending;
    if (this.validUntil > Date.now()) return Promise.resolve();
    const run = this.run().then(() => { this.validUntil = Date.now() + (this.options.ttlMs ?? 15_000); });
    const tracked = run.finally(() => { if (this.pending === tracked) this.pending = undefined; });
    this.pending = tracked; return tracked;
  }
  private async run() {
    const key = randomUUID(), o = this.options;
    const common = { protocolVersion: 1 as const, storeId: o.storeId, workerGeneration: o.generation,
      principal: { kind: 'system' as const, purpose: 'maintenance' as const } };
    const begun = await executeStoredCommand(o.port, { ...common, requestId: randomUUID(), operationId: `archive:begin:${key}`,
      command: { name: 'archive.beginSnapshot', input: {} } });
    if (begun.state !== 'committed') throw new StorageContractError(begun.state === 'rejected' ? begun.code : 'STORAGE_UNAVAILABLE');
    const ids = await o.fetchArchivedThreadIds();
    if (!Array.isArray(ids) || ids.length > 10000 || ids.some((id) => typeof id !== 'string' || !id || id.length > 256)) throw new StorageContractError('INVALID_ARGUMENT');
    const result = await executeStoredCommand(o.port, { ...common, requestId: randomUUID(), operationId: `archive:apply:${key}`,
      command: { name: 'archive.applySnapshot', input: { version: begun.value.version, archivedThreadIds: [...new Set(ids)] } } });
    if (result.state === 'rejected' && result.code === 'SUPERSEDED') return;
    if (result.state !== 'committed') throw new StorageContractError(result.state === 'rejected' ? result.code : 'STORAGE_UNAVAILABLE');
    // Publish only IDs; the per-client projection must be read again, including for recovered old receipts.
    const changes = await Promise.allSettled(result.value.changedSessionIds.map((id) => Promise.resolve().then(() => o.changed(id))));
    if (changes.some((r) => r.status === 'rejected')) throw new StorageContractError('STORAGE_UNAVAILABLE');
  }
  async close(){this.closed=true;await this.pending?.catch(()=>undefined);}
}
