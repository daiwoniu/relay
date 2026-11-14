import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { canonicalJson, StorageContractError } from './command-boundary.js';
import type { TerminalFileChanges } from '../ws/frontend-terminal-snapshot.js';

/** Read-only filesystem projection; accepted engine facts never wait on synchronous main-thread stat calls. */
export class RuntimeFileProjection {
  private readonly active = new Set<Worker>();
  private closed = false;
  constructor(private readonly timeoutMs = 10_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new StorageContractError('INVALID_ARGUMENT');
  }
  collect(items: readonly unknown[], projectRoot: string): Promise<TerminalFileChanges> {
    if (this.closed) return Promise.reject(new StorageContractError('STORAGE_UNAVAILABLE'));
    try {
      if (!Array.isArray(items) || items.length > 10_000 || typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)
        || projectRoot.length > 32768 || projectRoot.includes('\0')) throw new Error();
      canonicalJson({ items, projectRoot }, 8 * 1024 * 1024);
    } catch { return Promise.reject(new StorageContractError('INVALID_ARGUMENT')); }
    if (this.active.size >= 2) return Promise.reject(new StorageContractError('OVERLOADED'));
    let worker: Worker;
    try {
      worker = new Worker(new URL('./runtime-file-projection-bootstrap.mjs', import.meta.url), {
        workerData: { items, projectRoot }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      });
    } catch { return Promise.reject(new StorageContractError('STORAGE_UNAVAILABLE')); }
    this.active.add(worker);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (value?: TerminalFileChanges) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (value) resolve(value); else reject(new StorageContractError('STORAGE_UNAVAILABLE'));
        void worker.terminate().catch(() => undefined);
      };
      const timer = setTimeout(() => finish(), this.timeoutMs); timer.unref();
      worker.on('message', (value: TerminalFileChanges) => {
        try {
          canonicalJson(value, 2 * 1024 * 1024);
          if (!value || !Array.isArray(value.changedFiles) || value.changedFiles.length > 500
            || typeof value.changedFilesIncomplete !== 'boolean'
            || value.changedFiles.some(file => !file || typeof file.path !== 'string' || file.path.length > 4096
              || !['added', 'modified', 'deleted'].includes(file.changeType)
              || (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0)))) throw new Error();
          finish(value);
        } catch { finish(); }
      });
      worker.on('error', () => finish());
      worker.on('exit', () => { this.active.delete(worker); if (!done) finish(); });
    });
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active].map(worker => worker.terminate()));
  }
}
