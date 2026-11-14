import test from 'node:test';
import assert from 'node:assert/strict';
import { requireEmptyRequestBody } from './empty-request-body.js';

const request = (body?: BodyInit) => new Request('http://localhost/delete', { method: 'DELETE', body, duplex: 'half' } as RequestInit);

test('empty body validation accepts absent and empty streamed HTTP payloads', async () => {
  await requireEmptyRequestBody(request());
  await requireEmptyRequestBody(request(new ReadableStream({ start(c) { c.enqueue(new Uint8Array()); c.close(); } })));
});

test('empty body validation rejects actual bytes, including misleading content length', async () => {
  const withBytes = request('{}');
  withBytes.headers.set('content-length', '0');
  await assert.rejects(requireEmptyRequestBody(withBytes), { code: 'INVALID_ARGUMENT' });
});

test('empty body validation cancels stalled input without waiting indefinitely', async () => {
  let cancelled = false;
  const pending = request(new ReadableStream({ cancel() { cancelled = true; } }));
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(requireEmptyRequestBody(pending, 10), { code: 'NOT_SUBMITTED' });
    assert.equal(cancelled, true);
    assert.equal(pending.body!.locked, false);
  } finally { clearTimeout(keepAlive); }
});
