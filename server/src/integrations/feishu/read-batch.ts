import { AsyncLocalStorage } from 'node:async_hooks';
import type { Row } from './client.js';

type Batch = { requests: Map<string, Promise<Row>>; items: Map<string, Row>; bytes: number };
const batches = new AsyncLocalStorage<Map<object, Batch>>();
const maxBytes = 16 * 1024 * 1024;

/** Share provider reads across workbench phases inside one HTTP read. */
export function withFeishuReadBatch<T>(read: () => Promise<T>): Promise<T> {
  return batches.getStore() ? read() : batches.run(new Map(), read);
}
export function outsideFeishuReadBatch<T>(run: () => T): T {
  return batches.exit(run);
}
export function feishuReadBatch(owner: object): Batch | undefined {
  const current = batches.getStore();
  if (!current) return undefined;
  let batch = current.get(owner);
  if (!batch) { batch = { requests: new Map(), items: new Map(), bytes: 0 }; current.set(owner, batch); }
  return batch;
}
export function rememberFeishuItem(batch: Batch | undefined, key: string, row: Row): void {
  if (!batch || batch.items.has(key) || batch.items.size >= 1000) return;
  const bytes = Buffer.byteLength(JSON.stringify(row));
  if (batch.bytes + bytes > maxBytes) return;
  batch.bytes += bytes;
  batch.items.set(key, row);
}
export function memoFeishuRequest(batch: Batch | undefined, key: string, read: () => Promise<Row>): Promise<Row> {
  const existing = batch?.requests.get(key);
  if (existing) return existing;
  const promise = read();
  if (batch && batch.requests.size < 64) {
    batch.requests.set(key, promise);
    void promise.then(value => {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (batch.bytes + bytes > maxBytes) batch.requests.delete(key);
      else batch.bytes += bytes;
    }, () => { batch.requests.delete(key); });
  }
  return promise;
}
