import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { canonicalJson, StorageContractError } from './command-boundary.js';

/** Disposable read-only file probes. Neither the main thread nor the serialized DB connection performs lstat. */
export class AttachmentProbe {
  private readonly active = new Set<Worker>();
  private closed = false;
  constructor(private readonly timeoutMs = 10_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new StorageContractError('INVALID_ARGUMENT');
  }
  check(input: readonly string[]): Promise<Array<[string, boolean]>> {
    if (this.closed) return Promise.reject(new StorageContractError('STORAGE_UNAVAILABLE'));
    let paths: string[];
    try {
      canonicalJson(input, 1024*1024);
      if (!Array.isArray(input) || input.length > 4096 || input.some((p) => typeof p !== 'string' || !p || p.length > 32768 || p.includes('\0'))) throw new Error();
      paths = [...new Set(input)];
    } catch { return Promise.reject(new StorageContractError('INVALID_ARGUMENT')); }
    if (!paths.length) return Promise.resolve([]);
    if (this.active.size >= 2) return Promise.reject(new StorageContractError('OVERLOADED'));
    let worker: Worker;
    const requestId = randomUUID();
    try { worker = new Worker(new URL('./attachment-probe-entry.mjs', import.meta.url), { workerData: { requestId, paths },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } }); }
    catch { return Promise.reject(new StorageContractError('STORAGE_UNAVAILABLE')); }
    this.active.add(worker);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (availability?: boolean[]) => {
        if (done) return; done = true; clearTimeout(timer);
        if (availability) resolve(paths.map((filename, index) => [filename, availability[index]]));
        else reject(new StorageContractError('STORAGE_UNAVAILABLE'));
        void worker.terminate().catch(() => undefined);
      };
      const timer = setTimeout(() => finish(), this.timeoutMs); timer.unref();
      worker.on('message', (message) => {
        if (message?.error) { finish(); return; }
        if (message?.requestId !== requestId) return;
        if (!Array.isArray(message.availability) || message.availability.length !== paths.length
          || message.availability.some((v: unknown) => typeof v !== 'boolean')) finish();
        else finish(message.availability);
      });
      worker.on('error', () => finish());
      worker.on('exit', () => { this.active.delete(worker); if (!done) finish(); });
    });
  }
  async dispose(): Promise<void> { this.closed = true; await Promise.all([...this.active].map((worker) => worker.terminate())); }
}
